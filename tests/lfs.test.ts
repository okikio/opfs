import { describe, it } from "node:test";
import { expect } from "@std/expect";
import {
  decodeLfsPointer,
  encodeLfsPointer,
  LfsClient,
  LfsError,
  lfsPointerObject,
  LfsPublicationError,
  LfsVerificationError,
} from "../src/content/lfs.ts";
import type { LfsOptionsType } from "../src/content/lfs.ts";
const bytes = new TextEncoder().encode("hello\n");
// Independently produced by the native `printf 'hello\n' | shasum -a256` tool.
const oid = "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03";
const selected = { oid, size: bytes.length };
const endpoint = "https://repo.invalid/owner/repo.git/info/lfs/", origin = "https://objects.invalid";
const json = (value: unknown) => new Response(JSON.stringify(value));
const batch = (actions?: unknown) =>
  json({ objects: [{ ...selected, ...(actions === undefined ? {} : { actions }) }] });
const action = (suffix: string, header: Record<string, string> = {}) => ({
  href: `${origin}/${suffix}?secret=fixture`,
  header,
});
const options = (fetch: NonNullable<LfsOptionsType["fetch"]>, rest: Partial<LfsOptionsType> = {}): LfsOptionsType => ({
  endpoint,
  fetch,
  downloadOrigins: [origin],
  uploadOrigins: [origin],
  verifyOrigins: [origin],
  subtle: crypto.subtle,
  ...rest,
});
describe("native Git LFS pointers and basic transfer", () => {
  it("round-trips canonical pointer bytes and keeps empty pass-through files distinct", () => {
    const pointer = new TextEncoder().encode(`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 6\n`);
    const decoded = decodeLfsPointer(pointer);
    expect(encodeLfsPointer(decoded)).toEqual(pointer);
    expect(lfsPointerObject(decoded)).toEqual(selected);
    expect(decodeLfsPointer(new Uint8Array())).toEqual({ kind: "empty" });
    expect(encodeLfsPointer({ kind: "empty" })).toEqual(new Uint8Array());
    expect(() => lfsPointerObject({ kind: "empty" })).toThrow();
  });
  it("refuses pointer aliases, duplicate keys, unsafe sizes, CRLF and missing LF", () => {
    const text = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 6\n`;
    for (
      const value of [
        text.slice(0, -1),
        text.replaceAll("\n", "\r\n"),
        text.replace("size 6", "size 0"),
        text.replace("size 6", "size 9007199254740993"),
        text.replace("git-lfs.github.com", "hawser.github.com"),
        text + "size 6\n",
      ]
    ) expect(() => decodeLfsPointer(new TextEncoder().encode(value))).toThrow();
    expect(() => decodeLfsPointer(new Uint8Array(1024))).toThrow();
  });
  it("retains unknown pointer records inertly and refuses implicit extension interpretation", () => {
    const encoded = encodeLfsPointer({
      kind: "pointer",
      ...selected,
      fields: [{ key: "ext-0-compress", value: `sha256:${oid}` }],
    });
    const decoded = decodeLfsPointer(encoded);
    expect(encodeLfsPointer(decoded)).toEqual(encoded);
    expect(() => lfsPointerObject(decoded)).toThrow("explicit interpretation");
  });
  it("keeps Batch credentials off action requests and preserves native action authorization", async () => {
    let count = 0;
    const client = new LfsClient(options(async (input, init) => {
      const headers = new Headers(init?.headers);
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      if (++count === 1) {
        expect(input.toString()).toBe(endpoint + "objects/batch");
        expect(headers.get("Authorization")).toBe("Basic repository");
        return batch({ download: action("object", { Authorization: "Bearer signed-action" }) });
      }
      expect(headers.get("Authorization")).toBe("Bearer signed-action");
      return new Response(new Uint8Array(bytes), { headers: { "Content-Length": "6" } });
    }, { credentials: () => ({ Authorization: "Basic repository" }) }));
    expect(await client.readVerified(selected)).toEqual(bytes);
  });
  it("requires exact action-origin grants before acquiring action credentials", async () => {
    let callbacks = 0, requests = 0;
    const client = new LfsClient(options(async () => {
      requests++;
      return batch({ download: action("object") });
    }, {
      downloadOrigins: [],
      actionCredentials: () => {
        callbacks++;
        return {};
      },
    }));
    await expect(client.download(selected)).rejects.toThrow("not granted");
    expect(callbacks).toBe(0);
    expect(requests).toBe(1);
  });
  it("rejects duplicate, missing, foreign and per-object error batch results", async () => {
    for (
      const value of [{ objects: [] }, { objects: [{ ...selected, size: 7 }] }, { objects: [selected] }, {
        transfer: "tus",
        objects: [selected],
      }]
    ) {
      const client = new LfsClient(options(async () => json(value)));
      await expect(client.download(selected)).rejects.toThrow();
    }
    const client = new LfsClient(
      options(async () => json({ objects: [{ ...selected, error: { code: 404, message: "untrusted diagnostic" } }] })),
    );
    expect((await client.batch("download", [selected]))[0]?.state).toBe("error");
    await expect(client.download(selected)).rejects.toBeInstanceOf(LfsError);
  });
  it("rejects duplicate JSON action authority before making a content request", async () => {
    const client = new LfsClient(
      options(async () =>
        new Response(
          `{"objects":[{"oid":"${oid}","size":6,"actions":{"download":{"href":"https://objects.invalid/a","href":"https://objects.invalid/b"}}}]}`,
        )
      ),
    );
    await expect(client.download(selected)).rejects.toThrow("Malformed");
  });
  it("honors relative expiry over absolute expiry and rechecks after credential acquisition", async () => {
    let now = 1000, callbacks = 0;
    const client = new LfsClient(
      options(
        async () => batch({ download: { ...action("object"), expires_in: 1, expires_at: "2100-01-01T00:00:00Z" } }),
        {
          now: () => now,
          actionCredentials: () => {
            callbacks++;
            now = 2000;
            return {};
          },
        },
      ),
    );
    await expect(client.download(selected)).rejects.toThrow("expired during");
    expect(callbacks).toBe(1);
    const expired = new LfsClient(
      options(async () => batch({ download: { ...action("object"), expires_in: -1 } }), {
        now: () => 1000,
        actionCredentials: () => {
          throw new Error("must not run");
        },
      }),
    );
    await expect(expired.download(selected)).rejects.toThrow("expired");
  });
  it("refuses signed-header conflicts, redirects and wrong content extents", async () => {
    const conflict = new LfsClient(
      options(async () => batch({ download: action("object", { Authorization: "signed" }) }), {
        actionCredentials: () => ({ authorization: "different" }),
      }),
    );
    await expect(conflict.download(selected)).rejects.toThrow("conflict");
    for (
      const response of [
        new Response(null, { status: 307, headers: { location: "https://other.invalid/" } }),
        new Response(new Uint8Array(5)),
        new Response(new Uint8Array(7)),
        new Response(new Uint8Array(bytes), { headers: { "Content-Encoding": "gzip" } }),
      ]
    ) {
      const client = new LfsClient(
        options(async (input) => input.toString().endsWith("batch") ? batch({ download: action("object") }) : response),
      );
      await expect(client.readVerified(selected)).rejects.toThrow();
    }
  });
  it("rejects case-folded duplicate signed headers and invalid expiry calendar dates", async () => {
    for (
      const download of [action("object", { Authorization: "a", authorization: "b" }), {
        ...action("object"),
        expires_at: "2100-02-30T00:00:00Z",
      }]
    ) {
      const client = new LfsClient(options(async () => batch({ download })));
      await expect(client.download(selected)).rejects.toThrow();
    }
  });
  it("preserves native terminal stream failures without duplicate cancellation errors", async () => {
    const failure = new Error("native stream failed");
    const client = new LfsClient(
      options(async (input) =>
        input.toString().endsWith("batch") ? batch({ download: action("object") }) : new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.error(failure);
            },
          }),
        )
      ),
    );
    await expect(client.readVerified(selected)).rejects.toBe(failure);
  });
  it("does not confuse server-trusted streams with fullhash verified immutable sources", async () => {
    const client = new LfsClient(
      options(async (input) =>
        input.toString().endsWith("batch") ? batch({ download: action("object") }) : new Response(new Uint8Array(bytes))
      ),
    );
    const source = await client.openVerified(selected);
    expect(source.stability).toBe("immutable");
    const first = await source.read(0, 6);
    first.fill(9);
    expect(await source.read(0, 6)).toEqual(bytes);
    const wrong = new LfsClient(
      options(async (input) =>
        input.toString().endsWith("batch") ? batch({ download: action("object") }) : new Response(new Uint8Array(6))
      ),
    );
    await expect(wrong.readVerified(selected)).rejects.toThrow("digest differs");
  });
  it("preflights digest, size and local budgets before acquiring upload credentials", async () => {
    let callbacks = 0;
    const client = new LfsClient(options(async () => {
      throw Error("must not fetch");
    }, {
      credentials: () => {
        callbacks++;
        return {};
      },
    }));
    await expect(client.upload(selected, new Uint8Array(6))).rejects.toThrow("digest differs");
    await expect(client.readVerified({ oid, size: 67108865 })).rejects.toThrow("budget");
    expect(callbacks).toBe(0);
  });
  it("copies upload bytes and target context before asynchronous hashing and credential work", async () => {
    const mutable = new Uint8Array(bytes), target = { ...selected }, settings = { ref: "refs/heads/main" };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new LfsClient(options(async (input, init) => {
      if (input.toString().endsWith("batch")) {
        expect(JSON.parse(String(init?.body)).ref.name).toBe("refs/heads/main");
        return batch({ upload: action("object") });
      }
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
      return new Response();
    }, {
      subtle: {
        async digest(algorithm, data) {
          await gate;
          return await crypto.subtle.digest(algorithm, data);
        },
      },
    }));
    const pending = client.upload(target, mutable, settings);
    mutable.fill(9);
    target.size = 9;
    settings.ref = "refs/heads/changed";
    release();
    expect((await pending).state).toBe("uploaded");
  });
  it("distinguishes already-present, upload acknowledgment and optional verify acknowledgment", async () => {
    const exists = new LfsClient(options(async () => batch()));
    expect((await exists.upload(selected, bytes)).state).toBe("already-present");
    const client = new LfsClient(
      options(async (input) =>
        input.toString().endsWith("batch")
          ? batch({ upload: action("object"), verify: action("verify") })
          : new Response()
      ),
    );
    expect((await client.upload(selected, bytes)).state).toBe("verified");
    const failed = new LfsClient(
      options(async (input) =>
        input.toString().endsWith("batch")
          ? batch({ upload: action("object"), verify: action("verify") })
          : input.toString().includes("verify")
          ? new Response(null, { status: 500 })
          : new Response()
      ),
    );
    let failure: unknown;
    try {
      await failed.upload(selected, bytes);
    } catch (reason) {
      failure = reason;
    }
    expect(failure).toBeInstanceOf(LfsVerificationError);
    expect((failure as LfsVerificationError).upload.state).toBe("uploaded");
    expect((failure as Error).cause).toBeInstanceOf(LfsPublicationError);
  });
  it("does not retry unknown upload outcomes", async () => {
    let puts = 0;
    const client = new LfsClient(options(async (input) => {
      if (input.toString().endsWith("batch")) return batch({ upload: action("object") });
      puts++;
      throw new Error("lost acknowledgment");
    }));
    await expect(client.upload(selected, bytes)).rejects.toBeInstanceOf(LfsPublicationError);
    expect(puts).toBe(1);
  });
});
