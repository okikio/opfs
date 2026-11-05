import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { CouchdbError, CouchdbPublicationError, createCouchdbClient } from "../src/couchdb.ts";
import type { CouchdbClientOptionsType, CouchdbPutType } from "../src/couchdb.ts";
const BASE = { endpoint: "https://couch.test/prefix/", database: "fixture" };
const ETAG = '"1B2M2Y8AsgTpgAmY7PhCfg=="';
function client(options: Partial<CouchdbClientOptionsType> = {}) {
  return createCouchdbClient({ ...BASE, ...options });
}
function stub(extra = {}) {
  return {
    stub: true,
    content_type: "application/octet-stream",
    length: 3,
    digest: `md5-${ETAG.slice(1, -1)}`,
    revpos: 1,
    ...extra,
  };
}
function document(id = "doc", extra = {}) {
  return { _id: id, _rev: "1-abc", _attachments: { file: stub() }, ...extra };
}
function bytes(value = [1, 2, 3], headers = {}, status = 200): Response {
  return new Response(new Uint8Array(value), {
    status,
    headers: { "content-length": String(value.length), etag: ETAG, ...headers },
  });
}
describe("native CouchDB attachments", () => {
  it("preserves literal IDs, confines detached credentials, and separates document revision from attachment digest", async () => {
    const urls: URL[] = [];
    const api = client({
      credentials: (url) => {
        url.host = "foreign.test";
        return { authorization: "Basic fixture" };
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        urls.push(url);
        expect(url.origin).toBe("https://couch.test");
        expect(init?.redirect).toBe("manual");
        expect(init?.credentials).toBe("omit");
        expect(new Headers(init?.headers).get("authorization")).toBe("Basic fixture");
        return init?.method === "GET" && url.searchParams.has("attachments")
          ? Response.json(document("literal/%?#雪"))
          : bytes();
      },
    });
    const result = await api.document("literal/%?#雪", { revision: "1-abc" });
    expect(result.revision).toBe("1-abc");
    expect(result.attachments[0]?.digest).toBe(`md5-${ETAG.slice(1, -1)}`);
    expect(Object.isFrozen(result.attachments[0])).toBe(true);
    expect(await api.read("literal/%?#雪", "name/%?#雪", { revision: "1-abc" })).toEqual(new Uint8Array([1, 2, 3]));
    expect(urls[1]?.pathname).toBe("/prefix/fixture/literal%2F%25%3F%23%E9%9B%AA/name%2F%25%3F%23%E9%9B%AA");
    expect(urls[1]?.searchParams.get("rev")).toBe("1-abc");
  });
  it("preserves encoded metadata without treating HEAD wire length as logical length", async () => {
    const api = client({
      fetch: async (_, init) =>
        init?.method === "HEAD"
          ? new Response(null, {
            headers: {
              "content-length": "2",
              "content-type": "text/plain",
              "content-encoding": "gzip",
              etag: ETAG,
              "accept-ranges": "none",
            },
          })
          : Response.json(document("doc", { _attachments: { file: stub({ encoding: "gzip", encoded_length: 2 }) } })),
    });
    expect((await api.document("doc")).attachments[0]?.length).toBe(3);
    expect(await api.stat("doc", "file")).toEqual({
      size: 2,
      mediaType: "text/plain",
      encoding: "gzip",
      etag: ETAG,
      acceptsRanges: false,
    });
  });
  it("rejects lossy native numeric lexemes and duplicate authority fields before interpretation", async () => {
    for (const raw of ["9007199254740991.1", "1e-324", "9007199254740992", "-0"]) {
      const api = client({
        fetch: async () => new Response(JSON.stringify(document()).replace('"length":3', `"length":${raw}`)),
      });
      await expect(api.document("doc")).rejects.toThrow();
    }
    const api = client({ fetch: async () => new Response('{"_id":"doc","_id":"doc","_rev":"1-abc"}') });
    await expect(api.document("doc")).rejects.toThrow("Malformed");
    const foreign = client({ fetch: async () => Response.json(document("other")) });
    await expect(foreign.document("doc")).rejects.toThrow("differs");
  });
  it("accepts exact EOF-clamped ranges and rejects encoded/ignored/wrong extents before delivery", async () => {
    const api = client({
      fetch: async (_, init) => {
        expect(new Headers(init?.headers).get("range")).toBe("bytes=1-9");
        return bytes([2, 3], { "content-range": "bytes 1-2/3" }, 206);
      },
    });
    expect(await api.read("doc", "file", { at: 1, length: 9 })).toEqual(new Uint8Array([2, 3]));
    for (
      const response of [
        bytes(),
        bytes([2, 3], { "content-range": "bytes 0-1/3" }, 206),
        bytes([2, 3], { "content-range": "bytes 1-2/3", "content-encoding": "gzip" }, 206),
      ]
    ) {
      const bad = client({ fetch: async () => response });
      await expect(bad.get("doc", "file", { at: 1, length: 2 })).rejects.toThrow();
    }
  });
  it("owns EOF validation, early cancellation and terminal read failure without duplicate primary errors", async () => {
    let cancelled: unknown;
    const api = client({
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array([1]));
            },
            cancel(reason) {
              cancelled = reason;
            },
          }),
          { headers: { "content-length": "3", etag: ETAG } },
        ),
    });
    const result = await api.get("doc", "file");
    await result.bytes.cancel("preview done");
    expect(cancelled).toBe("preview done");
    const short = client({
      fetch: async () => new Response(new Uint8Array([1]), { headers: { "content-length": "3", etag: ETAG } }),
    });
    await expect(short.read("doc", "file")).rejects.toThrow("truncated");
    const failure = new Error("native read failure");
    const failing = client({
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.error(failure);
            },
          }),
          { headers: { "content-length": "3", etag: ETAG } },
        ),
    });
    await expect(failing.read("doc", "file")).rejects.toBe(failure);
  });
  it("captures bytes and mutable conditions before credential awaits", async () => {
    const input = new Uint8Array([1, 2, 3]);
    const options = { revision: "1-abc", mediaType: "application/octet-stream" };
    const api = client({
      credentials: async () => {
        input.fill(9);
        options.revision = "9-foreign";
        options.mediaType = "text/plain";
        return undefined;
      },
      fetch: async (input, init) => {
        expect(new URL(String(input)).searchParams.get("rev")).toBe("1-abc");
        expect(new Headers(init?.headers).get("content-type")).toBe("application/octet-stream");
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        return Response.json({ ok: true, id: "doc", rev: "2-def" }, { status: 201 });
      },
    });
    expect((await api.put("doc", "file", input, options)).state).toBe("stored");
  });
  it("requires explicit document-creation/revision choice and exposes native conflicts without retry", async () => {
    let requests = 0;
    const api = client({
      fetch: async () => {
        requests++;
        return Response.json({ error: "conflict" }, { status: 409 });
      },
    });
    await expect(api.put("doc", "file", new Uint8Array(), {} as CouchdbPutType)).rejects.toThrow("exactly one");
    await expect(api.put("doc", "file", new Uint8Array(), { createDocument: true })).rejects.toBeInstanceOf(
      CouchdbError,
    );
    expect(requests).toBe(1);
  });
  it("preserves a known409 refusal when retiring its unread body independently fails", async () => {
    const cleanup = new Error("body cancellation failed");
    const api = client({
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw cleanup;
            },
          }),
          { status: 409 },
        ),
    });
    try {
      await api.put("doc", "file", new Uint8Array([1]), { revision: "1-abc" });
      throw new Error("expected conflict and cleanup failure");
    } catch (reason) {
      expect(reason).toBeInstanceOf(AggregateError);
      expect(reason).not.toBeInstanceOf(CouchdbPublicationError);
      const errors = (reason as AggregateError).errors as unknown[];
      expect(errors.some((error) => error instanceof CouchdbError && error.status === 409)).toBe(true);
      expect(errors.includes(cleanup)).toBe(true);
    }
  });
  it("distinguishes202 acceptance and uncertain lost/mismatched receipts", async () => {
    const accepted = client({
      fetch: async () => Response.json({ ok: true, id: "doc", rev: "2-def" }, { status: 202 }),
    });
    expect((await accepted.remove("doc", "file", { revision: "1-abc" })).state).toBe("accepted");
    for (
      const fetch of [
        async () => {
          throw new Error("lost ack");
        },
        async () => Response.json({ ok: true, id: "other", rev: "2-def" }, { status: 201 }),
        async () => new Response("bad", { status: 201 }),
      ]
    ) {
      const api = client({ fetch });
      try {
        await api.put("doc", "file", new Uint8Array([1]), { revision: "1-abc" });
        throw new Error("expected refusal");
      } catch (reason) {
        expect(reason).toBeInstanceOf(CouchdbPublicationError);
        expect((reason as CouchdbPublicationError).revision).toBe("1-abc");
      }
    }
  });
  it("refuses unsafe input and preaborted operations before credentials and transport", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort("stop");
    const api = client({
      credentials: () => {
        calls++;
        return undefined;
      },
      fetch: async () => {
        calls++;
        return bytes();
      },
      maxBytes: 2,
    });
    await expect(api.read("doc", "file", { signal: controller.signal })).rejects.toBe("stop");
    await expect(api.read("..", "file")).rejects.toThrow();
    await expect(api.put("doc", "file", new Uint8Array([1, 2, 3]), { revision: "1-abc" })).rejects.toThrow();
    expect((await api.get("doc", "file", { length: 0 })).size).toBe(0);
    expect(calls).toBe(0);
    for (
      const endpoint of [
        "https://user:secret@couch.test/",
        "https://couch.test/a/../",
        "https://couch.test/%2f/",
        "https://couch.test/?auth=secret",
      ]
    ) expect(() => client({ endpoint })).toThrow();
  });
});
