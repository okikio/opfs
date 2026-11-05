import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { OciClient, OciError } from "../src/oci.ts";
import type { FetchType } from "../src/request.ts";

const image = "application/vnd.oci.image.manifest.v1+json";
const index = "application/vnd.oci.image.index.v1+json";
const content = new TextEncoder().encode("abc");
const identifier = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const empty = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const descriptor = { mediaType: "application/octet-stream", digest: identifier, size: 3 };
const manifest = { schemaVersion: 2, mediaType: image, config: descriptor, layers: [descriptor] };
const client = (fetch: FetchType) =>
  new OciClient({ registry: "https://registry.invalid/", repository: "team/repo", fetch, request: { retries: 0 } });
/** Independent native SHA-256 oracle; fixtures do not call the client hash implementation. */
async function hash(bytes: Uint8Array): Promise<string> {
  const value = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return `sha256:${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

describe("OCI exact manifest bytes", () => {
  it("validates exact response bytes before JSON parsing and treats tags as mutable lookups", async () => {
    const raw = new TextEncoder().encode(
      ` { "schemaVersion":2, "mediaType":"${image}", "config":${JSON.stringify(descriptor)}, "layers":[] }\n`,
    );
    const digest = await hash(raw);
    const files = client(() =>
      Promise.resolve(new Response(raw, { headers: { "content-type": image, "docker-content-digest": digest } }))
    );
    const result = await files.getManifest("latest");
    expect(result.digest).toBe(digest);
    expect(result.integrity).toBe("sha256");
    expect(result.bytes).toEqual(raw);
    expect(result.kind).toBe("manifest");
    expect(result.config).toEqual(descriptor);
    await expect(files.getManifest(identifier)).rejects.toThrow("digest mismatch");
  });
  it("admits OCI index descriptors without fetching the referenced content", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(
        Response.json({ schemaVersion: 2, mediaType: index, manifests: [{ ...descriptor, mediaType: image }] }, {
          headers: { "content-type": index },
        }),
      );
    });
    const result = await files.getManifest("v1");
    expect(result.kind).toBe("index");
    expect(result.manifests?.length).toBe(1);
    expect(calls).toBe(1);
    expect(Object.hasOwn(result, "layers")).toBe(false);
  });
  it("rejects hash header mismatch, wrong representation, unsafe descriptor sizes and invalid UTF-8", async () => {
    await expect(
      client(() =>
        Promise.resolve(
          Response.json(manifest, { headers: { "content-type": image, "docker-content-digest": identifier } }),
        )
      ).getManifest("v1"),
    ).rejects.toThrow("digest header");
    await expect(
      client(() => Promise.resolve(Response.json(manifest, { headers: { "content-type": index } }))).getManifest("v1"),
    ).rejects.toThrow("Content-Type");
    await expect(
      client(() =>
        Promise.resolve(
          Response.json({ ...manifest, config: { ...descriptor, size: Number.MAX_SAFE_INTEGER + 1 } }, {
            headers: { "content-type": image },
          }),
        )
      ).getManifest("v1"),
    ).rejects.toThrow();
    await expect(
      client(() => Promise.resolve(new Response(new Uint8Array([255]), { headers: { "content-type": image } })))
        .getManifest("v1"),
    ).rejects.toThrow();
  });
  it("bounds streamed manifests and retires oversized control bodies", async () => {
    let cancelled = false;
    const files = new OciClient({
      registry: "https://registry.invalid/",
      repository: "repo",
      maxManifestBytes: 2,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(3));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": image } },
          ),
        ),
    });
    await expect(files.getManifest("latest")).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});

describe("OCI blob trust and resource ownership", () => {
  it("separates server HEAD/range evidence from complete digest proof", async () => {
    const files = client((_input, init) => {
      const selected = new Headers(init?.headers).get("range");
      if (init?.method === "HEAD") return Promise.resolve(new Response(null, { headers: { "content-length": "3" } }));
      if (selected !== null) {
        return Promise.resolve(new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/3" } }));
      }
      return Promise.resolve(new Response(content));
    });
    expect(await files.statBlob(identifier)).toEqual({ digest: identifier, size: 3, integrity: "server" });
    expect(await new Response(await files.getBlob(identifier, { integrity: "server", at: 1, length: 2 })).text()).toBe(
      "bc",
    );
    expect(await files.readBlob(identifier, { size: 3 })).toEqual(content);
    await expect(files.readBlob(identifier, { size: 2 })).rejects.toThrow("descriptor size");
    await expect(files.readBlob(empty)).rejects.toThrow("digest mismatch");
  });
  it("retains a private verified snapshot and returns independent exact ranges", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(new Response(content));
    });
    const source = await files.openBlobSource(identifier, { size: 3 });
    expect(source.identity).toBe(`oci:${identifier}`);
    expect(source.stability).toBe("immutable");
    const first = await source.read(0, 3);
    first.fill(0);
    expect(await source.read(1, 2)).toEqual(new Uint8Array([98, 99]));
    expect(calls).toBe(1);
    await expect(source.read(2, 2)).rejects.toThrow("extent");
  });
  it("rejects ignored ranges and encoded responses while retiring their bodies", async () => {
    let cancelled = false;
    const files = client(() =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      )
    );
    await expect(files.getBlob(identifier, { integrity: "server", at: 1 })).rejects.toThrow("206");
    expect(cancelled).toBe(true);
    await expect(
      client(() => Promise.resolve(new Response(content, { headers: { "content-encoding": "gzip" } }))).readBlob(
        identifier,
      ),
    ).rejects.toThrow("Encoded");
    await expect(
      client(() =>
        Promise.resolve(new Response(null, { headers: { "content-encoding": "gzip", "content-length": "3" } }))
      ).statBlob(identifier),
    ).rejects.toThrow("Encoded");
    const zero = client(() => Promise.resolve(new Response(null, { headers: { "content-length": "0" } })));
    expect(await zero.readBlob(empty)).toEqual(new Uint8Array());
    expect(await new Response(await zero.getBlob(empty, { integrity: "server" })).text()).toBe("");
  });
  it("rejects bad references and absent range trust before acquiring credentials", async () => {
    let calls = 0;
    const files = new OciClient({
      registry: "https://registry.invalid/",
      repository: "repo",
      headers: () => {
        calls++;
        return { authorization: "secret" };
      },
    });
    await expect(files.readBlob("sha512:abc")).rejects.toThrow("SHA-256");
    await expect(files.getManifest("../tag")).rejects.toThrow("tag");
    await expect(files.getBlob(identifier, { integrity: "verified" as "server" })).rejects.toThrow("server trust");
    const aborted = new AbortController();
    aborted.abort(new Error("stop"));
    await expect(files.getManifest("latest", aborted.signal)).rejects.toThrow("stop");
    expect(calls).toBe(0);
  });
  it("preserves exact ranges through explicitly admitted redirects without forwarding registry credentials", async () => {
    let auth = 0;
    let retired = false;
    const files = new OciClient({
      registry: "https://registry.invalid/",
      repository: "repo",
      redirectOrigins: ["https://cdn.invalid"],
      headers: () => {
        auth++;
        return { authorization: "Bearer registry", cookie: "registry=cookie", "x-secret": "secret" };
      },
      fetch: (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        expect(init?.referrerPolicy).toBe("no-referrer");
        expect(headers.get("range")).toBe("bytes=1-2");
        if (url.origin === "https://registry.invalid") {
          return Promise.resolve(
            new Response(
              new ReadableStream({
                cancel() {
                  retired = true;
                },
              }),
              { status: 307, headers: { location: "https://cdn.invalid/blob?signature=secret" } },
            ),
          );
        }
        expect(retired).toBe(true);
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
        expect(headers.has("x-secret")).toBe(false);
        return Promise.resolve(new Response("bc", { status: 206, headers: { "content-range": "bytes 1-2/3" } }));
      },
      request: { retries: 0 },
    });
    expect(await new Response(await files.getBlob(identifier, { integrity: "server", at: 1, length: 2 })).text()).toBe(
      "bc",
    );
    expect(auth).toBe(1);
  });
  it("refuses unauthorized redirects, loops and manifest redirects", async () => {
    let calls = 0;
    const files = client(() => {
      calls++;
      return Promise.resolve(
        new Response(null, { status: 307, headers: { location: "https://registry.invalid/other" } }),
      );
    });
    await expect(files.readBlob(identifier)).rejects.toThrow("origin");
    expect(calls).toBe(1);
    await expect(files.getManifest("v1")).rejects.toBeInstanceOf(OciError);
    expect(calls).toBe(2);
    const cycle = new OciClient({
      registry: "https://registry.invalid/",
      repository: "repo",
      redirectOrigins: ["https://registry.invalid"],
      fetch: (input) => Promise.resolve(new Response(null, { status: 307, headers: { location: String(input) } })),
    });
    await expect(cycle.readBlob(identifier)).rejects.toThrow("repeated");
  });
});

describe("OCI bounded tag discovery", () => {
  it("uses same-repository links and preserves tag strings", async () => {
    let calls = 0;
    const files = client(() =>
      Promise.resolve(
        calls++ === 0
          ? Response.json({ name: "team/repo", tags: ["a"] }, {
            headers: { link: '</v2/team/repo/tags/list?n=1&last=a>; rel="next"' },
          })
          : Response.json({ name: "team/repo", tags: [] }),
      )
    );
    const found = [];
    for await (const value of files.tags({ pageSize: 1 })) found.push(value);
    expect(found).toEqual(["a"]);
    expect(calls).toBe(2);
  });
  it("continues full legacy pages without Link and refuses foreign continuation credentials", async () => {
    let page = 0;
    const files = client((input) => {
      const url = new URL(String(input));
      if (page > 0) expect(url.searchParams.get("last")).toBe("a");
      return Promise.resolve(Response.json({ name: "team/repo", tags: page++ === 0 ? ["a"] : [] }));
    });
    const found = [];
    for await (const value of files.tags({ pageSize: 1 })) found.push(value);
    expect(found).toEqual(["a"]);
    for (
      const value of [
        "https://foreign.invalid/v2/team/repo/tags/list?n=1",
        "https://registry.invalid/v2/other/tags/list?n=1",
        "https://registry.invalid/v2/team/repo/tags/list?access_token=secret",
      ]
    ) await expect(files.tagsPage({ next: value })).rejects.toThrow();
  });
});
