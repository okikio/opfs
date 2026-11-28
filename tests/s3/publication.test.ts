/** S3: Publications retain their own result, revision and failure disposition. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client, S3_LIMITS, S3CommitError, S3Error } from "../../src/backend/s3/client.ts";
import { streamBytes } from "../stream.ts";
import { within } from "../gate.ts";
import { withReleases } from "../close.ts";
import { credentials, rejectedResponse, xml } from "./fixture.ts";

describe("S3 publication contracts", () => {
  const options = { endpoint: "https://storage.example", bucket: "bucket", region: "auto", credentials };

  it("returns its own acknowledgement without a subsequent HEAD", async () => {
    const methods: string[] = [];
    const client = createS3Client({
      ...options,
      fetch: async (_input, init) => {
        methods.push(init!.method!);
        return new Response(null, {
          status: 200,
          headers: { etag: '"own"', "x-amz-version-id": "version-1", "x-amz-request-id": "request-1" },
        });
      },
    });
    expect(await client.put("value", new Uint8Array([1]), { mediaType: "text/plain" })).toMatchObject({
      size: 1,
      etag: '"own"',
      version: "version-1",
      requestId: "request-1",
      mediaType: "text/plain",
    });
    expect(methods).toEqual(["PUT"]);
  });

  it("reports a lost dispatched acknowledgement without replaying publication", async () => {
    const cause = new Error("response lost after server commit");
    let calls = 0;
    const client = createS3Client({
      ...options,
      fetch: async () => {
        calls++;
        throw cause;
      },
    });
    await expect(client.put("value", new Uint8Array([1]))).rejects.toMatchObject({
      effect: "unknown",
      key: "value",
      cause,
    });
    expect(calls).toBe(1);
  });

  it("requires a complete multipart XML acknowledgement and returns its revision", async () => {
    for (
      const body of [
        "",
        "<CompleteMultipartUploadResult>",
        "<CompleteMultipartUploadResult/>",
        "<Wrong><ETag>peer</ETag></Wrong>",
        "<CompleteMultipartUploadResult><Unexpected><ETag>nested</ETag></Unexpected></CompleteMultipartUploadResult>",
        "<CompleteMultipartUploadResult><ETag>one</ETag><ETag>two</ETag></CompleteMultipartUploadResult>",
        "<CompleteMultipartUploadResult><ETag><Value>nested</Value></ETag></CompleteMultipartUploadResult>",
        "<CompleteMultipartUploadResult><ETag>own</ETag><Unexpected><Error><Code>Failure</Code></Error></Unexpected></CompleteMultipartUploadResult>",
      ]
    ) {
      const client = createS3Client({ ...options, fetch: async () => xml(body) });
      await expect(client.completeUpload({ key: "value", id: "upload" }, [{ number: 1, etag: "part" }])).rejects
        .toMatchObject({ effect: "unknown", key: "value" });
    }
    const client = createS3Client({
      ...options,
      fetch: async () =>
        xml("<CompleteMultipartUploadResult><ETag>&quot;own&quot;</ETag></CompleteMultipartUploadResult>", {
          headers: { "x-amz-version-id": "own-version" },
        }),
    });
    expect(await client.completeUpload({ key: "value", id: "upload" }, [{ number: 1, etag: "part" }])).toMatchObject({
      etag: '"own"',
      version: "own-version",
    });
  });

  it("rejects nonzero declarations on empty streams on both multipart routes", async () => {
    for (const delayedMultipart of [true, false]) {
      let publications = 0;
      const client = createS3Client({
        ...options,
        delayedMultipart,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          if (url.searchParams.has("uploads")) {
            return xml("<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>");
          }
          if (init?.method !== "DELETE") publications++;
          return new Response(null, { status: 200 });
        },
      });
      await expect(client.put("value", streamBytes([]), { size: 1 })).rejects.toBeInstanceOf(RangeError);
      expect(publications).toBe(0);
    }
  });

  it("preserves encoded keys and prefixes without decoding the opaque continuation token", async () => {
    const client = createS3Client({
      ...options,
      fetch: async () =>
        xml(
          "<ListBucketResult><EncodingType>url</EncodingType><Contents><Key>%20a%2F%25%20</Key><Size>1</Size></Contents><CommonPrefixes><Prefix>%20prefix%2F%20</Prefix></CommonPrefixes><NextContinuationToken> token%20 </NextContinuationToken></ListBucketResult>",
        ),
    });
    const page = await client.list({ prefix: "" });
    expect(page.objects[0]!.key).toBe(" a/% ");
    expect(page.prefixes).toEqual([" prefix/ "]);
    expect(page.cursor).toBe(" token%20 ");
  });

  for (const listEncoding of ["percent", "form"] as const) {
    it(`decodes encoded listing identities with the explicit ${listEncoding} policy and leaves cursors opaque`, async () => {
      const client = createS3Client({
        ...options,
        listEncoding,
        fetch: async () =>
          xml(
            "<ListBucketResult><EncodingType>url</EncodingType><Contents><Key>a+b</Key><Size>1</Size></Contents><Contents><Key>a%2Bb</Key><Size>1</Size></Contents><Contents><Key>a%20b</Key><Size>1</Size></Contents><Contents><Key>a%2520b</Key><Size>1</Size></Contents><CommonPrefixes><Prefix>+%2B%20/</Prefix></CommonPrefixes><NextContinuationToken> +%2B%20 </NextContinuationToken></ListBucketResult>",
          ),
      });
      expect(client.listEncoding).toBe(listEncoding);
      const page = await client.list({ prefix: "" });
      expect(page.objects.map((entry) => entry.key)).toEqual([
        listEncoding === "form" ? "a b" : "a+b",
        "a+b",
        "a b",
        "a%20b",
      ]);
      expect(page.prefixes).toEqual([listEncoding === "form" ? " + /" : "++ /"]);
      expect(page.cursor).toBe(" +%2B%20 ");
      const unencoded = createS3Client({
        ...options,
        listEncoding,
        fetch: async () =>
          xml(
            "<ListBucketResult><Contents><Key> +%2B </Key><Size>1</Size></Contents><CommonPrefixes><Prefix> +%20 /</Prefix></CommonPrefixes></ListBucketResult>",
          ),
      });
      const raw = await unencoded.list({ prefix: "" });
      expect(raw.objects[0]!.key).toBe(" +%2B ");
      expect(raw.prefixes).toEqual([" +%20 /"]);
    });
  }

  it("rejects Fetch-normalized key paths before dispatch or source consumption", async () => {
    let calls = 0;
    let pulls = 0;
    const client = createS3Client({
      ...options,
      fetch: async () => {
        calls++;
        return new Response();
      },
    });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.close();
      },
    }, { highWaterMark: 0 });
    await expect(client.put("a/../b", body)).rejects.toBeInstanceOf(TypeError);
    await expect(client.copy("source", "a/./b")).rejects.toBeInstanceOf(TypeError);
    expect({ calls, pulls }).toEqual({ calls: 0, pulls: 0 });
    await body.cancel();
  });
  it("pins every copied range to the source revision admitted by HEAD", async () => {
    const reads: Headers[] = [];
    let headHeaders: Headers | undefined;
    const client = createS3Client({
      ...options,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "HEAD") {
          headHeaders = request.headers;
          return new Response(null, {
            status: 200,
            headers: { "content-length": "6442450944", etag: '"source-version"' },
          });
        }
        if (request.headers.has("x-amz-copy-source-if-match")) reads.push(request.headers);
        if (url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>");
        }
        if (url.searchParams.has("partNumber")) return xml("<CopyPartResult><ETag>part</ETag></CopyPartResult>");
        return xml("<CompleteMultipartUploadResult><ETag>own</ETag></CompleteMultipartUploadResult>");
      },
    });
    const receipt = await client.copy("source", "destination", { sourceIfMatch: "*" });
    expect(headHeaders!.get("if-match")).toBe("*");
    expect(reads.length).toBeGreaterThan(1);
    expect(reads.every((headers) => headers.get("x-amz-copy-source-if-match") === '"source-version"')).toBe(true);
    expect(receipt).toMatchObject({ size: 6442450944, etag: "own" });
  });

  it("rejects known impossible physical routes without provider I/O", () => {
    const client = createS3Client({
      ...options,
      fetch: async () => {
        throw new Error("preflight must not dispatch");
      },
    });
    expect(client.admit!({ operation: "write", source: "bytes", path: "/value", size: 6442450944 }).supported).toBe(
      false,
    );
    expect(
      client.admit!({ operation: "write", source: "stream", path: "/value", size: 6 * 1024 * 1024 * 1024 }).supported,
    ).toBe(true);
  });
  it("copies the immutable source version when the provider identifies it", async () => {
    let address: string | null = null;
    const client = createS3Client({
      ...options,
      fetch: async (_input, init) => {
        if (init!.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": "1", etag: "source", "x-amz-version-id": "source+version" },
          });
        }
        address = new Headers(init!.headers).get("x-amz-copy-source");
        return xml("<CopyObjectResult><ETag>own</ETag></CopyObjectResult>");
      },
    });
    expect(await client.copy("source", "destination")).toMatchObject({ size: 1, etag: "own" });
    expect(address!.endsWith("?versionId=source%2Bversion")).toBe(true);
  });

  for (const route of ["bytes", "stream"] as const) {
    it(`${route} publication owns its metadata and conditions before asynchronous work`, async () => {
      const policy = { metadata: { owner: "original" }, mediaType: "text/plain", ifNoneMatch: "*", size: 1 };
      const headers: Headers[] = [];
      const client = createS3Client({
        ...options,
        delayedMultipart: false,
        fetch: async (input, init) => {
          const url = new URL(String(input));
          headers.push(new Headers(init!.headers));
          policy.metadata.owner = "mutated";
          policy.mediaType = "application/json";
          policy.ifNoneMatch = "peer";
          if (url.searchParams.has("uploads")) {
            return xml("<InitiateMultipartUploadResult><UploadId>upload</UploadId></InitiateMultipartUploadResult>");
          }
          if (init!.method === "POST") {
            return xml("<CompleteMultipartUploadResult><ETag>own</ETag></CompleteMultipartUploadResult>");
          }
          return new Response(null, { headers: { etag: "part-or-own" } });
        },
      });
      const bytes = new Uint8Array([1]);
      const receipt = await client.put("value", route === "bytes" ? bytes : streamBytes([bytes]), policy);
      expect(receipt).toMatchObject({ size: 1, mediaType: "text/plain", metadata: { owner: "original" } });
      const published = headers.filter((header) => header.has("x-amz-meta-owner"));
      expect(published.length).toBe(1);
      expect(published[0]!.get("x-amz-meta-owner")).toBe("original");
      expect(headers.at(-1)!.get("if-none-match")).toBe("*");
      policy.metadata.owner = "later";
      expect(receipt.metadata).toEqual({ owner: "original" });
    });
  }
  it("owns mutable source dates through property lookup and copy", async () => {
    const date = new Date("2024-01-01T00:00:00Z");
    const expected = date.toUTCString();
    let copied: string | null = null;
    const client = createS3Client({
      ...options,
      fetch: async (_input, init) => {
        if (init!.method === "HEAD") {
          expect(new Headers(init!.headers).get("if-unmodified-since")).toBe(expected);
          date.setFullYear(2030);
          return new Response(null, { headers: { "content-length": "1", etag: "source" } });
        }
        copied = new Headers(init!.headers).get("x-amz-copy-source-if-unmodified-since");
        return xml("<CopyObjectResult><ETag>own</ETag></CopyObjectResult>");
      },
    });
    await client.copy("source", "destination", { sourceIfUnmodifiedSince: date });
    expect(copied).toBe(expected);
  });

  it("attributes normalized wire metadata and configured defaults to the publication", async () => {
    const client = createS3Client({
      ...options,
      headers: { "x-amz-meta-owner": " default ", "content-type": " text/plain " },
      fetch: async (_input, init) => {
        const headers = new Headers(init!.headers);
        expect(headers.get("x-amz-meta-owner")).toBe("before");
        expect(headers.get("content-type")).toBe("text/plain");
        return new Response(null, { status: 201, headers: { etag: "own" } });
      },
    });
    const receipt = await client.put("value", new Uint8Array([1]), { metadata: { OWNER: " before " } });
    expect(receipt).toMatchObject({ size: 1, mediaType: "text/plain", metadata: { owner: "before" } });
  });

  it("rejects disabled native copy in admission and before reading its source", async () => {
    let requests = 0;
    const client = createS3Client({
      ...options,
      copy: false,
      fetch: async () => {
        requests++;
        throw new Error("unexpected I/O");
      },
    });
    expect(client.admit!({ operation: "copy", path: "/source", destination: "/destination" }).supported).toBe(false);
    await expect(client.copy("source", "destination")).rejects.toBeInstanceOf(TypeError);
    expect(requests).toBe(0);
  });

  it("treats a server/proxy publication failure as uncertain without replay", async () => {
    let requests = 0;
    const client = createS3Client({
      ...options,
      fetch: async () => {
        requests++;
        return new Response("gateway lost the upstream response", { status: 504 });
      },
    });
    let failure: unknown;
    try {
      await client.put("value", new Uint8Array([1]));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ effect: "unknown", key: "value", cause: { status: 504 } });
    expect((failure as Error).cause).toBeInstanceOf(S3Error);
    expect(requests).toBe(1);
  });
});

describe("S3 invocation-owned publication disposition", () => {
  const options = { endpoint: "https://s3.example.test", bucket: "owned", region: "us-east-1", credentials };
  for (const route of ["put", "copy"] as const) {
    for (const disposition of ["unknown", "rejected", "acknowledged"] as const) {
      it(`keeps ${route} ${disposition} authority beside independent reader release failure`, async () => {
        const cleanup = new Error("actual final reader release fault");
        let aborts = 0;
        let completes = 0;
        const client = createS3Client({
          ...options,
          delayedMultipart: false,
          concurrency: 1,
          copyPartSize: S3_LIMITS.maxPartBytes,
          fetch: async (input, init) => {
            const request = new Request(input, init);
            const url = new URL(request.url);
            if (request.method === "HEAD") {
              return new Response(null, {
                headers: { "content-length": String(S3_LIMITS.maxCopyBytes + 1), etag: '"source"' },
              });
            }
            if (url.searchParams.has("uploads")) {
              return xml("<InitiateMultipartUploadResult><UploadId>owned</UploadId></InitiateMultipartUploadResult>");
            }
            if (request.method === "DELETE") {
              aborts++;
              return new Response(null, { status: 204 });
            }
            if (url.searchParams.has("partNumber")) {
              return route === "put"
                ? new Response(null, { headers: { etag: '"part"' } })
                : xml('<CopyPartResult><ETag>"part"</ETag></CopyPartResult>');
            }
            completes++;
            const payload = disposition === "unknown"
              ? "<CompleteMultipartUploadResult>"
              : disposition === "rejected"
              ? "<Error><Code>AccessDenied</Code></Error>"
              : '<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>';
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(payload));
                controller.close();
              },
            });
            const acquire = body.getReader.bind(body);
            Object.defineProperty(body, "getReader", {
              value() {
                const reader = acquire();
                const release = reader.releaseLock.bind(reader);
                reader.releaseLock = () => {
                  release();
                  throw cleanup;
                };
                return reader;
              },
            });
            return new Response(body, { status: disposition === "rejected" ? 403 : 200 });
          },
        });
        const failure = await rejectedResponse(
          route === "put"
            ? client.put("destination", streamBytes([Uint8Array.of(17)]))
            : client.copy("source", "destination"),
        );
        if (disposition === "acknowledged") expect(failure).toBe(cleanup);
        else {
          expect(failure).toBeInstanceOf(AggregateError);
          if (!(failure instanceof AggregateError)) throw failure;
          expect(failure.errors).toHaveLength(2);
          expect(failure.errors[1]).toBe(cleanup);
          if (disposition === "unknown") expect(failure.errors[0]).toBeInstanceOf(S3CommitError);
          else expect(failure.errors[0]).toBeInstanceOf(S3Error);
        }
        expect(completes).toBe(1);
        expect(aborts).toBe(disposition === "rejected" ? 1 : 0);
      });
    }
  }

  it("does not borrow known HTTP refusal from a foreign transport S3Error", async () => {
    const foreign = new S3Error("foreign transport reason", new Response(null, { status: 403 }));
    let calls = 0;
    const client = createS3Client({
      ...options,
      fetch: async () => {
        calls++;
        throw foreign;
      },
    });
    const failure = await rejectedResponse(client.put("destination", Uint8Array.of(17)));
    expect(failure).toBeInstanceOf(S3CommitError);
    expect(failure).toMatchObject({ cause: foreign, effect: "unknown" });
    expect(calls).toBe(1);
  });

  it("aborts owned staging despite a foreign CommitError and retains abort cleanup failure", async () => {
    const foreign = new S3CommitError("other-invocation", new Error("borrowed unknown outcome"));
    const cleanup = new Error("actual remote abort failed");
    let aborts = 0;
    let completes = 0;
    const client = createS3Client({
      ...options,
      delayedMultipart: false,
      concurrency: 1,
      request: { retries: 0 },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>owned</UploadId></InitiateMultipartUploadResult>");
        }
        if (url.searchParams.has("partNumber")) throw foreign;
        if (request.method === "DELETE") {
          aborts++;
          throw cleanup;
        }
        completes++;
        return new Response(null);
      },
    });
    const failure = await rejectedResponse(client.put("destination", streamBytes([Uint8Array.of(17)])));
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw failure;
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toMatchObject({ errors: [foreign] });
    expect(failure.errors[1]).toBe(cleanup);
    expect(aborts).toBe(1);
    expect(completes).toBe(0);
  });

  it("interrupts a stalled producer on actual part failure and retains native source cancellation", async () => {
    await withReleases(async (releases) => {
      const stalled = Promise.withResolvers<void>();
      const cleanup = new Error("actual source cancellation failed");
      let reads = 0;
      let cancels = 0;
      let aborts = 0;
      let completes = 0;
      let native: ReadableStreamDefaultController<Uint8Array> | undefined;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          native = controller;
        },
        pull(controller) {
          if (reads++ === 0) controller.enqueue(new Uint8Array(S3_LIMITS.minPartBytes));
          else stalled.resolve();
        },
        cancel() {
          cancels++;
          throw cleanup;
        },
      }, { highWaterMark: 0 });
      const client = createS3Client({
        ...options,
        delayedMultipart: false,
        concurrency: 2,
        partSize: S3_LIMITS.minPartBytes,
        request: { retries: 0 },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.searchParams.has("uploads")) {
            return xml("<InitiateMultipartUploadResult><UploadId>owned</UploadId></InitiateMultipartUploadResult>");
          }
          if (url.searchParams.has("partNumber")) {
            await stalled.promise;
            return xml("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
          }
          if (request.method === "DELETE") {
            aborts++;
            return new Response(null, { status: 204 });
          }
          completes++;
          return new Response(null);
        },
      });
      const pending = client.put("destination", source);
      void pending.catch(() => {});
      releases.push(() => Promise.allSettled([pending]));
      releases.push(() => {
        stalled.resolve();
        native?.error(new Error("S3 stalled-input fixture teardown"));
      });
      await within(stalled.promise, "S3 owned pending input");
      const failure = await rejectedResponse(within(pending, "S3 failed mapper input retirement"));
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw failure;
      expect(failure.errors[0]).toMatchObject({ errors: [expect.any(S3Error)] });
      expect(failure.errors[1]).toBe(cleanup);
      expect(cancels).toBe(1);
      expect(source.locked).toBe(false);
      expect(aborts).toBe(1);
      expect(completes).toBe(0);
    });
  });
});
