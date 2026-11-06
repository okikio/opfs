import { describe, it } from "node:test";
import { expect } from "@std/expect";

import {
  createGcsClient,
  createGcsUploadDestination,
  GCS_CHUNK_BYTES,
  GcsError,
  GcsPublicationError,
  GcsStorageClassSchema,
} from "../src/gcs.ts";
import type { GcsHeadOptionsType } from "../src/gcs.ts";
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

describe("GCS native storage-class intent", () => {
  it("captures class before credentials and confirms it in the exact final receipt", async () => {
    const options = { storageClass: "ARCHIVE" as const };
    let calls = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      token: async () => {
        Object.assign(options, { storageClass: "STANDARD" });
        return "token";
      },
      fetch: async (_input, init) => {
        if (calls++ === 0) {
          expect(JSON.parse(String(init?.body))).toEqual({ storageClass: "ARCHIVE" });
          return new Response(null, { headers: { location: session.url } });
        }
        return Response.json({ ...object, storageClass: "ARCHIVE", metadata: { storageClass: "user-field" } });
      },
    });
    expect(await client.put(key, new Uint8Array([1, 2, 3]), options)).toMatchObject({
      storageClass: "ARCHIVE",
      metadata: { storageClass: "user-field" },
    });
    expect(calls).toBe(2);
  });

  it("retains native unknown classes in head and list without treating them as upload selectors", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input) =>
        Response.json(
          new URL(String(input)).pathname.endsWith("/o")
            ? { items: [{ ...object, storageClass: "FUTURE_NATIVE_CLASS" }] }
            : { ...object, storageClass: "FUTURE_NATIVE_CLASS" },
        ),
    });
    expect((await client.head(key))?.storageClass).toBe("FUTURE_NATIVE_CLASS");
    expect((await client.list({ prefix: "" })).objects[0]?.storageClass).toBe("FUTURE_NATIVE_CLASS");
    expect(GcsStorageClassSchema.safeParse("FUTURE_NATIVE_CLASS").success).toBe(false);
  });

  it("admits only the explicit upload class profile before token acquisition", async () => {
    let tokens = 0;
    const client = createGcsClient({
      bucket: "test",
      token: () => {
        tokens++;
        return "token";
      },
    });
    await expect(client.createUpload(key, { storageClass: "RAPID" as "ARCHIVE" })).rejects.toThrow();
    await expect(client.queryUpload({ ...session, storageClass: "invalid" as "ARCHIVE" })).rejects.toThrow();
    expect(tokens).toBe(0);
  });

  it("keeps expected class in the session and refuses omitted or mismatched final class as unknown publication", async () => {
    for (const storageClass of [undefined, "STANDARD"]) {
      let calls = 0;
      const client = createGcsClient({
        bucket: "test",
        endpoint: origin,
        fetch: async () => {
          if (calls++ === 0) return new Response(null, { headers: { location: session.url } });
          return Response.json({ ...object, ...(storageClass === undefined ? {} : { storageClass }) });
        },
      });
      const upload = await client.createUpload(key, { size: 3, storageClass: "ARCHIVE" });
      expect(upload.storageClass).toBe("ARCHIVE");
      expect(Object.isFrozen(upload)).toBe(true);
      await expect(client.writeUpload(upload, new Uint8Array([1, 2, 3]), { offset: 0, total: 3, final: true }))
        .rejects.toBeInstanceOf(GcsPublicationError);
      await expect(client.queryUpload(upload)).rejects.toBeInstanceOf(GcsPublicationError);
    }
  });
});

/** These authored responses prove parsing and wire conditions, not Google service enforcement. */
describe("GCS native metadata observations and paired conditions", () => {
  const metageneration = "18446744073709551615";
  const revision = { kind: "generation" as const, value: generation };
  const reported = {
    ...object,
    metageneration,
    crc32c: "AAAAAA==",
    metadata: { metageneration: "caller-field", crc32c: "caller-checksum" },
  };

  it("retains exact native fields through client and driver receipt paths", async () => {
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/o")) {
          return init?.method === "POST"
            ? new Response(null, { headers: { location: session.url } })
            : Response.json({ items: [reported] });
        }
        return Response.json(url.pathname.includes("/rewriteTo/") ? { done: true, resource: reported } : reported);
      },
    });
    const driver = createGcsDriverFromClient(client);
    const expected = {
      key,
      size: 3,
      version: generation,
      revision,
      etag: object.etag,
      mediaType: object.contentType,
      metageneration,
      crc32c: "AAAAAA==",
      metadata: reported.metadata,
    };
    expect(await client.head(key)).toEqual(expected);
    expect(await driver.head(key)).toEqual(expected);
    expect((await driver.list({ prefix: "archive/" })).objects).toEqual([expected]);
    expect(await driver.put(key, new Uint8Array([1, 2, 3]))).toEqual(expected);
    expect(await driver.copy("source", key)).toEqual(expected);
    expect(await client.writeUpload(session, new Uint8Array([1, 2, 3]), { offset: 0, final: true }))
      .toEqual({ complete: true, offset: 3, receipt: expected });
    expect(await client.queryUpload(session)).toEqual({ complete: true, offset: 3, receipt: expected });
  });

  it("omits unreported native fields without converting them to null or zero", async () => {
    const client = createGcsClient({ bucket: "test", fetch: async () => Response.json(object) });
    const stat = await client.head(key);
    expect(Object.hasOwn(stat!, "metageneration")).toBe(false);
    expect(Object.hasOwn(stat!, "crc32c")).toBe(false);
  });

  it("preserves decimal metadata values above the safe integer range", async () => {
    for (const value of ["9007199254740993", metageneration, "184467440737095516150"]) {
      const client = createGcsClient({
        bucket: "test",
        fetch: async () => Response.json({ ...object, metageneration: value }),
      });
      expect((await client.head(key))?.metageneration).toBe(value);
    }
  });

  it("rejects malformed generation and metadata receipts while retaining unknown publication outcomes", async () => {
    const invalid = [
      ...[null, 1, "", "0", "01", "-1", "1e3", " 1", "1\n", "1\r\n", "١", "１"]
        .map((value) => ({ generation: value })),
      ...[null, 1, "", "0", "01", "-1", "1e3", " 1", "1\n", "1\r\n"].map((value) => ({ metageneration: value })),
      ...[null, 0, "", "AAAAAA", "AAAAAA=", "AAAAAAA=", "AAAAAB==", "AAAA-A==", "AAAA_A==", " AAAAAA==", "AAAAAAAAAAAA"]
        .map((value) => ({ crc32c: value })),
    ];
    for (const fields of invalid) {
      const responses: Response[] = [];
      let requests = 0;
      const client = createGcsClient({
        bucket: "test",
        endpoint: origin,
        request: { retries: 2, minDelayMs: 0, maxDelayMs: 0 },
        fetch: async (input) => {
          requests++;
          const url = new URL(String(input));
          const value = { ...object, ...fields };
          const response = Response.json(
            url.pathname.endsWith("/o")
              ? { items: [value] }
              : url.pathname.includes("/rewriteTo/")
              ? { done: true, resource: value }
              : value,
          );
          responses.push(response);
          return response;
        },
      });
      await expect(client.head(key)).rejects.toThrow();
      await expect(client.list({ prefix: "" })).rejects.toThrow();
      for (
        const operation of [
          () => client.queryUpload(session),
          () => client.writeUpload(session, new Uint8Array([1, 2, 3]), { offset: 0, final: true }),
          () => client.copy("source", key),
        ]
      ) {
        let failure: unknown;
        try {
          await operation();
        } catch (reason) {
          failure = reason;
        }
        expect(failure).toBeInstanceOf(GcsPublicationError);
        expect((failure as GcsPublicationError).cause).toBeInstanceOf(Error);
      }
      expect(requests).toBe(5); // No replay or later current HEAD can replace the invalid receipt.
      expect(responses.every((response) => response.bodyUsed)).toBe(true);
    }
  });

  it("admits only canonical four-byte Base64 including each possible final data character", async () => {
    for (const crc32c of ["AAAAAA==", "AAAAAQ==", "AAAAAg==", "AAAAAw==", "/////w=="]) {
      const client = createGcsClient({ bucket: "test", fetch: async () => Response.json({ ...object, crc32c }) });
      expect((await client.head(key))?.crc32c).toBe(crc32c);
    }
  });

  it("pairs metadata tokens with exact generation text for each native operation", async () => {
    let requests = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        expect(url.searchParams.get("ifGenerationMatch")).toBe(generation);
        expect(url.searchParams.get("ifMetagenerationMatch")).toBe(metageneration);
        requests++;
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        if (init?.method === "POST") return new Response(null, { headers: { location: session.url } });
        expect(url.searchParams.get("generation")).toBe(generation);
        return url.searchParams.get("alt") === "media"
          ? new Response(new Uint8Array([1, 2, 3]), { headers: { "x-goog-generation": generation } })
          : Response.json(reported);
      },
    });
    const driver = createGcsDriverFromClient(client);
    const options = { revision, ifMetagenerationMatch: metageneration };
    expect((await driver.head(key, options))?.metageneration).toBe(metageneration);
    expect(new Uint8Array(await new Response(await driver.get(key, options)).arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    await driver.delete(key, options);
    await client.createUpload(key, options);
    expect(requests).toBe(4);
  });

  it("sends upload guards only at initiation and retains the new publication metadata independently", async () => {
    let requests = 0;
    const options = { revision: { ...revision }, ifMetagenerationMatch: metageneration };
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      token: () => {
        options.revision.value = "2";
        options.ifMetagenerationMatch = "3";
        return "token";
      },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (requests++ === 0) {
          expect(init?.method).toBe("POST");
          expect(url.searchParams.get("ifGenerationMatch")).toBe(generation);
          expect(url.searchParams.get("ifMetagenerationMatch")).toBe(metageneration);
          return new Response(null, { headers: { location: session.url } });
        }
        expect(url.searchParams.get("ifMetagenerationMatch")).toBeNull();
        expect(url.searchParams.get("ifGenerationMatch")).toBeNull();
        return Response.json({ ...reported, metageneration: "1" });
      },
    });
    const receipt = await createGcsDriverFromClient(client).put(key, new Uint8Array([1, 2, 3]), options);
    expect(receipt.metageneration).toBe("1");
    expect(requests).toBe(2);
  });

  it("captures both rewrite condition pairs before credentials and preserves them on continuation", async () => {
    const options = {
      revision: { ...revision },
      ifMetagenerationMatch: metageneration,
      sourceRevision: { kind: "generation" as const, value: "9007199254740993" },
      ifSourceMetagenerationMatch: "9007199254740995",
    };
    let requests = 0;
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      token: () => {
        options.revision.value = "2";
        options.ifMetagenerationMatch = "3";
        options.sourceRevision.value = "4";
        options.ifSourceMetagenerationMatch = "5";
        return "token";
      },
      fetch: async (input) => {
        const query = new URL(String(input)).searchParams;
        expect(query.get("ifGenerationMatch")).toBe(generation);
        expect(query.get("ifMetagenerationMatch")).toBe(metageneration);
        expect(query.get("ifSourceGenerationMatch")).toBe("9007199254740993");
        expect(query.get("ifSourceMetagenerationMatch")).toBe("9007199254740995");
        expect(query.get("rewriteToken")).toBe(requests === 0 ? null : "next");
        return requests++ === 0
          ? Response.json({ done: false, rewriteToken: "next" })
          : Response.json({ done: true, resource: reported });
      },
    });
    expect((await createGcsDriverFromClient(client).copy("source", key, options)).metageneration).toBe(metageneration);
    expect(requests).toBe(2);
  });

  it("refuses invalid pairs before credentials, transport or stream acquisition", async () => {
    let authority = 0;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
    }, { highWaterMark: 0 });
    const client = createGcsClient({
      bucket: "test",
      token: () => {
        authority++;
        return "token";
      },
      fetch: async () => {
        authority++;
        throw new Error("Unexpected transport");
      },
    });
    const invalid: Array<GcsHeadOptionsType & { readonly ifMetagenerationMatch: string }> = [
      { ifMetagenerationMatch: "1" },
      { revision: { kind: "etag" as const, value: "etag" }, ifMetagenerationMatch: "1" },
      { revision: { kind: "generation" as const, value: "0" }, ifMetagenerationMatch: "1" },
      ...["0", "01", "", "-1", "1e3", "1\n", "1\r\n", null, 1].map((value) => ({
        revision,
        ifMetagenerationMatch: value as string,
      })),
    ];
    for (const options of invalid) {
      await expect(client.head(key, options)).rejects.toThrow(TypeError);
      await expect(client.get(key, { ...options, length: 0 })).rejects.toThrow(TypeError);
      await expect(client.delete(key, options)).rejects.toThrow(TypeError);
      await expect(client.createUpload(key, options)).rejects.toThrow(TypeError);
      await expect(client.put(key, source, options)).rejects.toThrow(TypeError);
      await expect(client.copy("source", key, options)).rejects.toThrow(TypeError);
      await expect(client.copy("source", key, {
        ...(options.revision === undefined ? {} : { sourceRevision: options.revision }),
        ifSourceMetagenerationMatch: options.ifMetagenerationMatch,
      })).rejects.toThrow(TypeError);
      expect(source.locked).toBe(false);
    }
    await expect(client.createUpload(key, { ifNoneMatch: "*", ifMetagenerationMatch: "1" })).rejects.toThrow(TypeError);
    await expect(client.copy("source", key, { ifNoneMatch: "*", ifMetagenerationMatch: "1" })).rejects.toThrow(
      TypeError,
    );
    expect(authority).toBe(0);
    expect(pulls).toBe(0);
    await source.cancel();
  });

  it("refuses malformed generation-only conditions before credentials or source acquisition", async () => {
    let authority = 0;
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        pulls++;
      },
    }, { highWaterMark: 0 });
    const client = createGcsClient({
      bucket: "test",
      token: () => {
        authority++;
        return "token";
      },
      fetch: async () => {
        authority++;
        throw new Error("Unexpected transport");
      },
    });
    for (const value of [null, 1, true, "", "-1", "1e3", " 1", "1 ", "1\n", "1\r\n", "١", "１"]) {
      const revision = { kind: "generation" as const, value: value as string };
      await expect(client.head(key, { revision })).rejects.toThrow(TypeError);
      await expect(client.get(key, { revision, length: 0 })).rejects.toThrow(TypeError);
      await expect(client.delete(key, { revision })).rejects.toThrow(TypeError);
      await expect(client.createUpload(key, { revision })).rejects.toThrow(TypeError);
      await expect(client.put(key, source, { revision })).rejects.toThrow(TypeError);
      await expect(client.copy("source", key, { revision })).rejects.toThrow(TypeError);
      await expect(client.copy("source", key, { sourceRevision: revision })).rejects.toThrow(TypeError);
      expect(source.locked).toBe(false);
    }
    expect(authority).toBe(0);
    expect(pulls).toBe(0);
    await source.cancel();
  });

  it("retains zero and raw leading-zero input generation conditions without coercion", async () => {
    const requests: string[] = [];
    const client = createGcsClient({
      bucket: "test",
      endpoint: origin,
      fetch: async (input) => {
        requests.push(new URL(String(input)).searchParams.get("ifGenerationMatch")!);
        return new Response(null, { headers: { location: session.url } });
      },
    });
    for (const value of ["0", "00", "0001", generation]) {
      await client.createUpload(key, { revision: { kind: "generation", value } });
    }
    expect(requests).toEqual(["0", "00", "0001", generation]);
  });

  it("keeps admitted empty reads local without claiming to evaluate their server guard", async () => {
    let requests = 0;
    const client = createGcsClient({
      bucket: "test",
      token: () => {
        requests++;
        return "token";
      },
    });
    const stream = await client.get(key, { revision, ifMetagenerationMatch: metageneration, length: 0 });
    expect((await new Response(stream).arrayBuffer()).byteLength).toBe(0);
    expect(requests).toBe(0);
  });

  it("rejects a metadata response attributed to a different selected generation", async () => {
    const client = createGcsClient({
      bucket: "test",
      fetch: async () => Response.json({ ...reported, generation: "2" }),
    });
    await expect(client.head(key, { revision, ifMetagenerationMatch: metageneration })).rejects.toThrow(
      "different generation",
    );
  });

  it("preserves provider 412 refusals without replay or publication success", async () => {
    let requests = 0;
    const client = createGcsClient({
      bucket: "test",
      request: { retries: 2, minDelayMs: 0, maxDelayMs: 0 },
      fetch: async () => {
        requests++;
        return new Response(null, { status: 412 });
      },
    });
    const options = { revision, ifMetagenerationMatch: metageneration };
    for (
      const operation of [
        () => client.head(key, options),
        () => client.get(key, options),
        () => client.delete(key, options),
        () => client.createUpload(key, options),
        () => client.copy("source", key, { ...options, sourceRevision: revision, ifSourceMetagenerationMatch: "1" }),
      ]
    ) {
      await expect(operation()).rejects.toMatchObject({ name: "GcsError", status: 412 });
    }
    expect(requests).toBe(5);
  });
});
