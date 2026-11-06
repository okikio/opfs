import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createSwiftClient, SwiftError, SwiftPublicationError } from "../src/swift.ts";
import type { FetchType } from "../src/request.ts";
import { openObjectSource } from "../src/source.ts";
const hash = "0123456789abcdef0123456789abcdef";
const endpoint = "https://swift.example/v1/AUTH_fixture";
function client(fetch: FetchType) {
  return createSwiftClient({ endpoint, container: "one", fetch, request: { retries: 0 } });
}

describe("native Swift regular-object protocol", () => {
  it("normalizes MD5 ETags, binds source ranges and preserves object path bytes", async () => {
    const requests: URL[] = [];
    const native = client(async (input, init) => {
      requests.push(new URL(String(input)));
      if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "3", etag: hash } });
      expect(new Headers(init?.headers).get("if-match")).toBe(`"${hash}"`);
      expect(new Headers(init?.headers).get("range")).toBe("bytes=1-2");
      return new Response(new Uint8Array([2, 3]), {
        status: 206,
        headers: { "content-range": "bytes 1-2/3", etag: hash },
      });
    });
    const source = await openObjectSource(native, "a/%2E?b#c");
    expect(source.stability).toBe("provider");
    expect(await source.read(1, 2)).toEqual(new Uint8Array([2, 3]));
    expect(requests[0]!.pathname).toBe("/v1/AUTH_fixture/one/a/%252E%3Fb%23c");
    expect(requests[0]!.searchParams.get("symlink")).toBe("get");
    expect(JSON.parse(source.identity!)[0]).toBe(native.identity);
  });
  it("retains only attributable PUT size and metadata from its own acknowledgement", async () => {
    const native = client(async (_input, init) => {
      expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
      expect(new Headers(init?.headers).get("x-object-meta-purpose")).toBe("preview");
      return new Response(null, {
        status: 201,
        headers: { etag: hash, "content-length": "0", "x-trans-id": "fixture" },
      });
    });
    expect(await native.put("one", new Uint8Array([1, 2, 3]), { metadata: { purpose: "preview" } })).toMatchObject({
      size: 3,
      etag: `"${hash}"`,
      requestId: "fixture",
      metadata: { purpose: "preview" },
    });
    expect(native.capabilities.conditionalWrite).toBe(false);
    expect(native.capabilities.copy).toBe(false);
  });
  it("uses terminal marker requests even when a cluster caps short pages", async () => {
    const native = client(async (input) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("marker")) {
        return Response.json([
          { name: "a/one", bytes: 3, hash, content_type: "text/plain", last_modified: "2026-11-05T12:00:00.000000" },
          { subdir: "a/two/" },
        ]);
      }
      expect(url.searchParams.get("marker")).toBe("a/two/");
      return new Response(null, { status: 204 });
    });
    const page = await native.list({ prefix: "a/", delimiter: "/", limit: 1000 });
    expect(page.cursor).toBe("a/two/");
    expect(page.objects[0]?.size).toBe(3);
    expect(page.prefixes).toEqual(["a/two/"]);
    expect(await native.list({ prefix: "a/", cursor: page.cursor! })).toEqual({ objects: [], prefixes: [] });
  });
  it("refuses unsupported preconditions and invalid paths before tokens, I/O or source acquisition", async () => {
    let tokens = 0;
    let calls = 0;
    const native = createSwiftClient({
      endpoint,
      container: "one",
      token: () => {
        tokens++;
        return "fixture";
      },
      fetch: () => {
        calls++;
        throw new Error("No I/O expected");
      },
    });
    const body = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
    const revision = { kind: "generation", value: "123" } as const;
    await expect(native.get("one", { revision })).rejects.toThrow(TypeError);
    await expect(native.delete("one", { revision })).rejects.toThrow(TypeError);
    await expect(native.put("one", body, { ifMatch: `"${hash}"` })).rejects.toThrow(TypeError);
    await expect(native.get("a/../b")).rejects.toThrow(TypeError);
    await expect(native.get("one", { at: -1 })).rejects.toThrow(RangeError);
    const reason = new Error("stop");
    await expect(native.head("one", { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect([tokens, calls, body.locked]).toEqual([0, 0, false]);
    await body.cancel();
  });
});

describe("Swift refusal, ownership and publication boundaries", () => {
  for (const header of ["x-object-manifest", "x-static-large-object", "x-symlink-target"]) {
    it(`refuses ${header} metadata without retaining its response body`, async () => {
      let retired = 0;
      const native = client(async () =>
        new Response(
          new ReadableStream({
            cancel() {
              retired++;
            },
          }),
          {
            headers: { "content-length": "0", [header]: "true", etag: hash },
          },
        )
      );
      await expect(native.head("one")).rejects.toThrow(TypeError);
      await expect(native.get("one")).rejects.toThrow(TypeError);
      expect(retired).toBe(2);
    });
  }
  for (
    const [status, headers] of [
      [200, { etag: hash }],
      [206, { etag: hash, "content-range": "bytes 0-1/3" }],
      [206, { etag: hash, "content-range": "bytes 1-2/3", "content-encoding": "gzip" }],
      [206, { etag: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "content-range": "bytes 1-2/3" }],
    ] as const
  ) {
    it(`refuses unbound/misaligned range ${JSON.stringify(headers)} and retires the body`, async () => {
      let retired = 0;
      const native = client(async () =>
        new Response(
          new ReadableStream({
            cancel() {
              retired++;
            },
          }),
          { status, headers },
        )
      );
      await expect(native.get("one", { at: 1, length: 2, revision: { kind: "etag", value: `"${hash}"` } }))
        .rejects.toThrow(TypeError);
      expect(retired).toBe(1);
    });
  }
  it("preserves known refusal and independent response retirement failure", async () => {
    const cleanup = new Error("cancel failed");
    const native = client(async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw cleanup;
          },
        }),
        { status: 403 },
      )
    );
    await expect(native.head("one")).rejects.toMatchObject({ errors: [expect.any(SwiftError), cleanup] });
  });
  it("classifies lost, malformed and server-error acknowledgements without replay", async () => {
    for (const response of [undefined, new Response(null, { status: 201 }), new Response(null, { status: 503 })]) {
      let calls = 0;
      const native = client(async () => {
        calls++;
        if (!response) throw new Error("lost acknowledgement");
        return response;
      });
      await expect(native.put("one", new Uint8Array([1]))).rejects.toBeInstanceOf(SwiftPublicationError);
      expect(calls).toBe(1);
    }
  });
  it("keeps authorization refusal distinct from uncertain publication", async () => {
    const native = client(async () => new Response(null, { status: 403 }));
    await expect(native.put("one", new Uint8Array([1]))).rejects.toBeInstanceOf(SwiftError);
  });
  it("streams bounded native extents and rejects a declared size mismatch", async () => {
    const native = client(async (_input, init) => {
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
      return new Response(null, { status: 201, headers: { etag: hash } });
    });
    expect((await native.put("one", new Blob([new Uint8Array([1, 2, 3])]).stream(), { size: 3 })).size).toBe(3);
    await expect(native.put("one", new Blob([new Uint8Array([1, 2, 3])]).stream(), { size: 4 }))
      .rejects.toBeInstanceOf(SwiftPublicationError);
  });
  it("joins an active source read when the transport fails", async () => {
    let acquired!: () => void;
    const started = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let retired = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        acquired();
        return new Promise<void>(() => {});
      },
      cancel() {
        retired++;
      },
    }, { highWaterMark: 0 });
    const native = client(async (_input, init) => {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
      const pending = reader.read();
      void pending.catch(() => {});
      await started;
      throw new Error("wire closed");
    });
    await expect(native.put("one", source)).rejects.toBeInstanceOf(SwiftPublicationError);
    expect(retired).toBe(1);
    expect(source.locked).toBe(false);
  });
  it("refuses stream acknowledgement before complete input consumption and retires acquired input", async () => {
    let retired = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(output) {
        output.enqueue(new Uint8Array(65536));
      },
      cancel() {
        retired++;
      },
    }, { highWaterMark: 0 });
    const native = client(async (_input, init) => {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      return new Response(null, { status: 201, headers: { etag: hash } });
    });
    await expect(native.put("one", source)).rejects.toBeInstanceOf(SwiftPublicationError);
    expect(retired).toBe(1);
    expect(source.locked).toBe(false);
  });
  it("checks native byte slots before allocation and snapshots before token acquisition", async () => {
    const bytes = new Uint8Array([1, 2]);
    for (const property of ["byteLength", "buffer", "byteOffset", "length"]) {
      Object.defineProperty(bytes, property, {
        get() {
          throw new Error("No metadata reads");
        },
      });
    }
    const native = createSwiftClient({
      endpoint,
      container: "one",
      token: () => {
        bytes.fill(9);
        return "fixture";
      },
      fetch: async (_input, init) => {
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(new Uint8Array([1, 2]));
        return new Response(null, { status: 201, headers: { etag: hash } });
      },
    });
    expect((await native.put("one", bytes)).size).toBe(2);
    const large = new Uint8Array(3);
    Object.defineProperty(large, "byteLength", { value: 0 });
    await expect(createSwiftClient({ endpoint, container: "one", maxObjectBytes: 2 }).put("one", large))
      .rejects.toThrow(RangeError);
  });
  it("rejects nonadvancing or out-of-prefix listing data", async () => {
    for (const rows of [[{ subdir: "a/one/" }, { subdir: "a/one/" }], [{ subdir: "other/" }]]) {
      await expect(client(async () => Response.json(rows)).list({ prefix: "a/" })).rejects.toThrow(TypeError);
    }
  });
  it("refreshes read tokens after a retry without retrying mutations", async () => {
    let tokens = 0;
    let calls = 0;
    const native = createSwiftClient({
      endpoint,
      container: "one",
      token: () => `token-${++tokens}`,
      request: { retries: 1, minDelayMs: 0, maxDelayMs: 0 },
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("x-auth-token")).toBe(`token-${++calls}`);
        return calls === 1 ? new Response(null, { status: 503 }) : new Response(null, {
          headers: { "content-length": "1", etag: hash },
        });
      },
    });
    expect(tokens).toBe(0);
    expect((await native.head("one"))?.size).toBe(1);
    expect(tokens).toBe(2);
  });
});
