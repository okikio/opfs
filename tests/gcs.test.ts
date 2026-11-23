import { describe, it } from "node:test";
import { expect } from "@std/expect";

import {
  createGcsClient,
  createGcsUploadDestination,
  GCS_CHUNK_BYTES,
  GcsError,
  GcsPublicationError,
} from "../src/gcs.ts";
import { createGcsDriverFromClient } from "../src/driver/gcs.ts";
import { createGcsAdapter } from "../src/adapter/gcs.ts";
import { FileSystemError } from "../src/error.ts";

const origin = "https://storage.example.test";
const key = "archive/a?b.zip";
const generation = "18446744073709551614";
const object = { name: key, size: "3", generation, etag: '"metadata-etag"', contentType: "application/zip" };
const session = { key, url: `${origin}/upload?upload_id=secret-session`, size: 3 };

describe("Google Cloud Storage JSON client", () => {
  it("keeps opaque generations distinct from ETags and preserves encoded object names", async () => {
    const requests: URL[] = [];
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input) => {
        requests.push(new URL(String(input)));
        return Response.json(object);
      },
    });
    expect(await client.head(key)).toMatchObject({
      size: 3,
      etag: object.etag,
      version: generation,
      revision: { kind: "generation", value: generation },
    });
    expect(requests[0]!.pathname).toBe("/storage/v1/b/test/o/archive%2Fa%3Fb.zip");
    const driver = createGcsDriverFromClient(client);
    expect(driver.inspect().ownership).toBe("borrowed");
    expect(driver.inspect().limits).toContainEqual(
      expect.objectContaining({ source: "provider", code: "upload-chunk-alignment" }),
    );
  });

  it("refreshes bearer authority per read attempt without acquiring it during construction", async () => {
    let tokens = 0;
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      token: () => `token-${++tokens}`,
      request: { retries: 1, minDelayMs: 0, maxDelayMs: 0 },
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer token-${calls + 1}`);
        calls++;
        return calls === 1 ? new Response(null, { status: 503 }) : Response.json(object);
      },
    });
    expect(tokens).toBe(0);
    await client.head(key);
    expect(tokens).toBe(2);
  });

  it("binds media ranges to generations and validates actual body extents", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input, init) => {
        expect(new URL(String(input)).searchParams.get("generation")).toBe(generation);
        expect(new Headers(init?.headers).get("range")).toBe("bytes=1-2");
        return new Response(new Uint8Array([7, 8]), {
          status: 206,
          headers: { "content-range": "bytes 1-2/3", "content-length": "2", "x-goog-generation": generation },
        });
      },
    });
    const stream = await client.get(key, { at: 1, length: 2, revision: { kind: "generation", value: generation } });
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(new Uint8Array([7, 8]));
  });

  it("refuses ignored ranges and retires the rejected body without downloading it", async () => {
    let cancelled = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled++;
            },
          }, { highWaterMark: 0 }),
        ),
    });
    await expect(client.get(key, { at: 1, length: 2 })).rejects.toThrow("did not honor");
    expect(cancelled).toBe(1);
  });

  it("rejects truncated ranges when the consumer reaches EOF", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () =>
        new Response(new Uint8Array([7]), { status: 206, headers: { "content-range": "bytes 1-2/3" } }),
    });
    const stream = await client.get(key, { at: 1, length: 2 });
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("truncated");
  });

  it("does no authorization or I/O for empty ranges and invalid conditions", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      token: () => {
        calls++;
        return "token";
      },
      fetch: async () => {
        calls++;
        return Response.json(object);
      },
    });
    expect((await new Response(await client.get(key, { at: 999, length: 0 })).arrayBuffer()).byteLength).toBe(0);
    await expect(client.get(key, { at: -1 })).rejects.toThrow(RangeError);
    await expect(client.put(key, new Uint8Array(), { ifMatch: object.etag })).rejects.toThrow("generation");
    await expect(client.createUpload(key, { revision: { kind: "etag", value: object.etag } })).rejects.toThrow(
      "generation",
    );
    expect(calls).toBe(0);
  });

  it("lists an exact page with native continuation and prefix markers", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input) => {
        const query = new URL(String(input)).searchParams;
        expect(query.get("pageToken")).toBe("opaque+cursor");
        expect(query.get("delimiter")).toBe("/");
        return Response.json({ items: [object], prefixes: ["archive/"], nextPageToken: "next" });
      },
    });
    expect(await client.list({ prefix: "archive", delimiter: "/", cursor: "opaque+cursor" })).toMatchObject({
      objects: [{ key }],
      prefixes: ["archive/"],
      cursor: "next",
    });
  });

  it("uses generation conditions for deletion and retires missing responses", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input) => {
        expect(new URL(String(input)).searchParams.get("ifGenerationMatch")).toBe(generation);
        calls++;
        return new Response(null, { status: 404 });
      },
    });
    await client.delete(key, { revision: { kind: "generation", value: generation } });
    expect(calls).toBe(1);
  });

  it("creates a conditional session and attributes its own final acknowledgement", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input, init) => {
        calls++;
        const url = new URL(String(input));
        if (calls === 1) {
          expect(init?.method).toBe("POST");
          expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
          return new Response(null, { headers: { location: session.url } });
        }
        expect(new Headers(init?.headers).get("content-range")).toBe("bytes 0-2/3");
        return Response.json(object);
      },
    });
    expect(await client.put(key, new Uint8Array([1, 2, 3]), { ifNoneMatch: "*" })).toMatchObject({
      size: 3,
      version: generation,
    });
    expect(calls).toBe(2);
  });

  it("reconciles retained offset with status queries and rejects impossible acknowledgements", async () => {
    let range = "bytes=0-1";
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("content-range")).toBe("bytes */3");
        return new Response(null, { status: 308, headers: { range } });
      },
    });
    expect(await client.queryUpload(session)).toEqual({ complete: false, offset: 2 });
    range = "garbage";
    await expect(client.queryUpload(session)).rejects.toThrow("retained range");
  });

  it("does not replay a mutating request after a lost acknowledgement", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      request: { retries: 3 },
      fetch: async () => {
        calls++;
        throw new Error("connection lost");
      },
    });
    await expect(client.writeUpload(session, new Uint8Array([1, 2, 3]), { offset: 0, total: 3, final: true })).rejects
      .toThrow();
    expect(calls).toBe(1);
  });

  it("rejects foreign session origins and unaligned nonfinal chunks before transport", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    await expect(client.queryUpload({ ...session, url: "https://attacker.test/upload" })).rejects.toThrow("origin");
    await expect(client.writeUpload(session, new Uint8Array([1]), { offset: 0 })).rejects.toThrow("256 KiB");
    expect(calls).toBe(0);
  });

  it("streams aligned chunks and distinguishes progress from final publication", async () => {
    let writes = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      chunkSize: GCS_CHUNK_BYTES,
      fetch: async (_input, init) => {
        if (init?.method === "POST") return new Response(null, { headers: { location: session.url } });
        writes++;
        if (writes === 1) {
          expect(new Headers(init?.headers).get("content-range")).toBe(`bytes 0-${GCS_CHUNK_BYTES - 1}/*`);
          return new Response(null, { status: 308, headers: { range: `bytes=0-${GCS_CHUNK_BYTES - 1}` } });
        }
        return Response.json({ ...object, size: String(GCS_CHUNK_BYTES + 3) });
      },
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(GCS_CHUNK_BYTES + 3));
        controller.close();
      },
    });
    expect(await client.put(key, source)).toMatchObject({ size: GCS_CHUNK_BYTES + 3 });
    expect(writes).toBe(2);
  });

  it("rejects malformed success acknowledgements without manufacturing a later HEAD receipt", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () => new Response('{"generation":"1"'),
    });
    await expect(client.writeUpload(session, new Uint8Array([1, 2, 3]), { offset: 0, final: true })).rejects
      .toBeInstanceOf(GcsPublicationError);
  });

  it("rewrites through explicit bounded continuation requests", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("ifSourceGenerationMatch")).toBe(generation);
        expect(url.searchParams.get("ifGenerationMatch")).toBe("0");
        calls++;
        return calls === 1
          ? Response.json({ done: false, rewriteToken: "continue" })
          : Response.json({ done: true, resource: object });
      },
    });
    expect(
      await client.copy("source", key, { ifNoneMatch: "*", sourceRevision: { kind: "generation", value: generation } }),
    ).toMatchObject({ size: 3 });
    expect(calls).toBe(2);
  });

  it("retains HTTP status failures rather than treating permission denial as absence", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () => new Response(null, { status: 403 }),
    });
    await expect(client.head(key)).rejects.toBeInstanceOf(GcsError);
  });

  it("does not create a session for an invalid or already borrowed stream", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    const stream = new ReadableStream<Uint8Array>();
    const reader = stream.getReader();
    await expect(client.put(key, stream)).rejects.toThrow();
    reader.releaseLock();
    await stream.cancel();
    expect(calls).toBe(0);
  });

  it("distinguishes retained bytes from final publication in the transfer destination", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () => {
        calls++;
        if (calls === 1) return new Response(null, { status: 308, headers: { range: "bytes=0-2" } });
        return Response.json(object);
      },
    });
    const destination = createGcsUploadDestination(client, session);
    expect(await destination.status()).toEqual({ offset: 3, size: 3, complete: false });
    expect(await destination.finish!()).toEqual({ offset: 3, size: 3, complete: true });
  });

  it("rejects HTTP transcoding before transferring the media body", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () => new Response(new Uint8Array([1]), { headers: { "x-goog-stored-content-encoding": "gzip" } }),
    });
    await expect(client.get(key)).rejects.toThrow("transparent Fetch decoding");
  });

  it("labels lost rewrite acknowledgement as unknown publication and never retries it", async () => {
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async () => {
        calls++;
        throw new Error("connection lost");
      },
    });
    await expect(client.copy("source", key)).rejects.toBeInstanceOf(GcsPublicationError);
    expect(calls).toBe(1);
  });

  it("translates provider failures only at the filesystem boundary and retains their cause", async () => {
    for (
      const [status, code] of [[403, "permission-denied"], [404, "not-found"], [409, "locked"], [
        412,
        "locked",
      ]] as const
    ) {
      const client = createGcsClient({
        bucket: "test",
        endpoint: origin,
        fetch: async () => new Response(null, { status }),
      });
      const adapter = createGcsAdapter(client);
      if (status === 404) {
        await expect(adapter.readFile("/missing")).rejects.toMatchObject({ code: "not-found" });
      } else {
        let failure: unknown;
        try {
          await adapter.stat("/value");
        } catch (reason) {
          failure = reason;
        }
        expect(failure).toBeInstanceOf(FileSystemError);
        expect(failure).toMatchObject({ code, cause: expect.any(GcsError) });
      }
    }
  });
});
