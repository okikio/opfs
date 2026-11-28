/** S3: Multipart writes retain part order, provider limits and cancellation. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client, S3_LIMITS, S3Error } from "../../src/backend/s3/client.ts";
import { streamBytes } from "../stream.ts";
import { within } from "../gate.ts";
import { withReleases } from "../close.ts";
import { completedParts, credentials, rejectedResponse, xml } from "./fixture.ts";

describe("S3 client", () => {
  it("keeps mapper-only cancellation while an owned s3 part response retires", async () => {
    await withReleases(async (releases) => {
      const reason = new Error("Authored cancellation after a part acknowledgement.");
      const controller = new AbortController();
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let pulls = 0;
      let cancellations = 0;
      let retirements = 0;
      let parts = 0;
      let completed = 0;
      let aborted = 0;
      let settled = false;
      const source = new ReadableStream<Uint8Array>({
        pull(stream) {
          if (pulls++ === 0) stream.enqueue(new Uint8Array(5 * 1024 * 1024));
        },
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const client = createS3Client({
        endpoint: "https://storage.example",
        bucket: "bucket",
        region: "auto",
        credentials,
        delayedMultipart: false,
        partSize: 5 * 1024 * 1024,
        concurrency: 1,
        request: { retries: 0 },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (request.method === "POST" && url.searchParams.has("uploads")) {
            return xml("<InitiateMultipartUploadResult><UploadId>owned</UploadId></InitiateMultipartUploadResult>");
          }
          if (request.method === "PUT" && url.searchParams.has("partNumber")) {
            parts++;
            controller.abort(reason);
            return new Response(
              new ReadableStream<Uint8Array>({
                async cancel() {
                  retirements++;
                  admitted.resolve();
                  await finish.promise;
                  throw reason;
                },
              }, { highWaterMark: 0 }),
              { headers: { etag: '"part"' } },
            );
          }
          if (request.method === "POST" && url.searchParams.has("uploadId")) completed++;
          if (request.method === "DELETE" && url.searchParams.has("uploadId")) aborted++;
          return new Response(null, { status: 204 });
        },
      });
      const pending = rejectedResponse(client.put("mapper-cancel.bin", source, { signal: controller.signal }))
        .finally(() => {
          settled = true;
        });
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => controller.abort(reason));
      await within(admitted.promise, "owned part response retirement admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      // Caller abort has already retired input, while response retirement still
      // prevents this operation from settling or completing its publication.
      expect(source.locked).toBe(false);
      expect(cancellations).toBe(1);
      expect(completed).toBe(0);
      finish.resolve();
      const failure = await within(pending, "owned part response retirement settlement");
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected the actual operation-owned mapper aggregate.");
      }
      expect(failure.errors).toHaveLength(1);
      expect(failure.errors[0]).toBe(reason);
      expect(parts).toBe(1);
      expect(retirements).toBe(1);
      expect(completed).toBe(0);
      expect(aborted).toBe(1);
      expect(pulls).toBe(1);
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  for (const failure of ["producer", "caller"] as const) {
    it(`preserves the ${failure} reason after admitted S3 chunks drain`, async () => {
      const reason = new Error(`${failure} terminal reason`);
      const controller = new AbortController();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let requests = 0;
      let completed = 0;
      let aborted = 0;
      let cancelled = 0;
      let pulls = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(stream) {
          if (pulls++ === 0) stream.enqueue(new Uint8Array(5 * 1024 * 1024));
          else if (failure === "producer") stream.error(reason);
        },
        cancel() {
          cancelled += 1;
        },
      }, { highWaterMark: 0 });
      const client = createS3Client({
        endpoint: "https://storage.example",
        bucket: "bucket",
        region: "auto",
        credentials,
        delayedMultipart: false,
        partSize: 5 * 1024 * 1024,
        concurrency: 2,
        request: { retries: 0 },
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (request.method === "POST" && url.searchParams.has("uploads")) {
            return xml("<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>");
          }
          if (request.method === "PUT" && url.searchParams.has("partNumber")) {
            requests += 1;
            entered.resolve();
            if (failure === "caller") controller.abort(reason);
            await release.promise;
            return new Response(null, { status: 200, headers: { etag: '"part"' } });
          }
          if (request.method === "POST" && url.searchParams.has("uploadId")) completed += 1;
          if (request.method === "DELETE" && url.searchParams.has("uploadId")) aborted += 1;
          return new Response(null, { status: 204 });
        },
      });
      const pending = client.put("failure.bin", source, { signal: controller.signal });
      void pending.catch(() => {});
      try {
        await within(entered.promise, "provider chunk admission");
        release.resolve();
        await expect(within(pending, "provider source failure")).rejects.toBe(reason);
        expect(requests).toBe(1);
        expect(completed).toBe(0);
        expect(source.locked).toBe(false);
        if (failure === "caller") expect(cancelled).toBe(1);
        expect(aborted).toBe(1);
      } finally {
        controller.abort(reason);
        release.resolve();
        await within(Promise.allSettled([pending]), "provider fixture drain");
      }
    });
  }

  it("treats an embedded CompleteMultipartUpload error as a failure even after HTTP 200", async () => {
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.searchParams.has("uploadId")) {
          return xml(
            `<Error><Code>InternalError</Code><Message>assembly failed</Message><RequestId>r1</RequestId></Error>`,
          );
        }
        return new Response(null, { status: 200 });
      },
    });

    try {
      await client.completeUpload({ key: "large.bin", id: "upload" }, [{ number: 1, etag: '"part"' }]);
      throw new Error("expected embedded multipart failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3Error);
      if (error instanceof S3Error) {
        expect(error.code).toBe("InternalError");
        expect(error.requestId).toBe("r1");
      }
    }
  });

  it("places multipart write preconditions on completion rather than initiation", async () => {
    const requests: Request[] = [];
    const fiveMiB = 5 * 1024 * 1024;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      partSize: fiveMiB,
      concurrency: 2,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          return new Response(null, { status: 200, headers: { etag: `\"p${url.searchParams.get("partNumber")}\"` } });
        }
        if (request.method === "POST" && url.searchParams.has("uploadId")) {
          return xml('<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>');
        }
        if (request.method === "HEAD") {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(fiveMiB + 1), etag: '"final"' },
          });
        }
        return new Response(null, { status: 200 });
      },
    });

    const body = streamBytes([new Uint8Array(fiveMiB), new Uint8Array([1])]);
    await client.put("large.bin", body, { ifMatch: '"old"' });

    const initiate = requests.find((request) =>
      request.method === "POST" && new URL(request.url).searchParams.has("uploads")
    );
    const complete = requests.find((request) =>
      request.method === "POST" && new URL(request.url).searchParams.has("uploadId")
    );
    expect(initiate?.headers.has("if-match")).toBe(false);
    expect(complete?.headers.get("if-match")).toBe('"old"');
  });

  it("delays multipart creation for a small unknown-length stream by default", async () => {
    const requests: Request[] = [];
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "3", etag: '"small"' } });
        }
        return new Response(null, { status: 200, headers: { etag: '"small"' } });
      },
    });

    await client.put("small.bin", streamBytes([new Uint8Array([1, 2, 3])]));

    expect(requests.some((request) => request.method === "POST" && new URL(request.url).searchParams.has("uploads")))
      .toBe(false);
    expect(requests.some((request) => request.method === "PUT" && !new URL(request.url).searchParams.has("partNumber")))
      .toBe(true);
  });

  it("can disable delayed multipart when request lifecycle parity is required", async () => {
    const requests: Request[] = [];
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      delayedMultipart: false,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>u-small</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          return new Response(null, { status: 200, headers: { etag: '"part-1"' } });
        }
        if (request.method === "POST" && url.searchParams.has("uploadId")) {
          return xml('<CompleteMultipartUploadResult><ETag>"small"</ETag></CompleteMultipartUploadResult>');
        }
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "3", etag: '"small"' } });
        }
        return new Response(null, { status: 500 });
      },
    });

    await client.put("small.bin", streamBytes([new Uint8Array([1, 2, 3])]));

    expect(requests.some((request) => request.method === "POST" && new URL(request.url).searchParams.has("uploads")))
      .toBe(true);
    expect(requests.some((request) => request.method === "PUT" && new URL(request.url).searchParams.has("partNumber")))
      .toBe(true);
  });

  it("aborts multipart state when the streamed byte count does not match the declared size", async () => {
    const requests: Request[] = [];
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      delayedMultipart: false,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>size-upload</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          return new Response(null, { status: 200, headers: { etag: '"part"' } });
        }
        if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 500 });
      },
    });

    await expect(client.put(
      "wrong-size.bin",
      streamBytes([new Uint8Array([1])]),
      { size: 2 },
    )).rejects.toThrow(RangeError);

    expect(requests.some((request) => request.method === "DELETE")).toBe(true);
    expect(requests.some((request) => request.method === "POST" && new URL(request.url).searchParams.has("uploadId")))
      .toBe(false);
  });

  it("keeps the object ceiling equal to the exact multipart part-count limit", () => {
    expect(S3_LIMITS.maxObjectBytes).toBe(S3_LIMITS.maxPartBytes * S3_LIMITS.maxParts);
  });

  it("rejects multipart sizes outside the documented S3 part range", () => {
    expect(() =>
      createS3Client({
        endpoint: "https://storage.example",
        bucket: "bucket",
        region: "auto",
        credentials,
        partSize: S3_LIMITS.minPartBytes - 1,
      })
    ).toThrow(RangeError);

    expect(() =>
      createS3Client({
        endpoint: "https://storage.example",
        bucket: "bucket",
        region: "auto",
        credentials,
        partSize: S3_LIMITS.maxPartBytes + 1,
      })
    ).toThrow(RangeError);
  });

  it("sorts multipart parts and rejects duplicate part numbers before commit", async () => {
    const requests: Request[] = [];
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return xml("<CompleteMultipartUploadResult><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>");
      },
    });

    await client.completeUpload(
      { key: "ordered.bin", id: "upload" },
      [{ number: 2, etag: '"b"' }, { number: 1, etag: '"a"' }],
      { expectedSize: 10 },
    );
    const body = await requests[0]!.text();
    // Parse the transmitted XML independently of the production request builder.
    // Entity spelling and whitespace do not change the provider's part contract.
    const transmitted = completedParts(body);
    expect(transmitted).toEqual([{ PartNumber: "1", ETag: '"a"' }, { PartNumber: "2", ETag: '"b"' }]);
    expect(requests[0]!.headers.get("x-amz-mp-object-size")).toBe("10");

    await expect(client.completeUpload(
      { key: "duplicate.bin", id: "upload" },
      [{ number: 1, etag: '"a"' }, { number: 1, etag: '"b"' }],
    )).rejects.toThrow(RangeError);
    expect(requests).toHaveLength(1);
  });

  it("rejects an impossible declared object size before it starts multipart work", async () => {
    let fetches = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
    });

    await expect(client.put(
      "too-large.bin",
      streamBytes([new Uint8Array([1])]),
      { size: S3_LIMITS.maxObjectBytes + 1 },
    )).rejects.toThrow(RangeError);
    expect(fetches).toBe(0);
  });

  it("uses a separate bounded signal to abort multipart state after caller cancellation", async () => {
    const controller = new AbortController();
    const reason = new DOMException("caller cancelled", "AbortError");
    let cleanupSignal: AbortSignal | undefined;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      abortTimeoutMs: 5_000,
      delayedMultipart: false,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          controller.abort(reason);
          return xml("<InitiateMultipartUploadResult><UploadId>cancelled</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          throw init?.signal instanceof AbortSignal && init.signal.aborted
            ? init.signal.reason
            : new Error("part request should receive caller cancellation");
        }
        if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
          cleanupSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 500 });
      },
    });

    await expect(client.put(
      "cancelled.bin",
      streamBytes([new Uint8Array([1])]),
      { signal: controller.signal },
    )).rejects.toBe(reason);

    expect(cleanupSignal).toBeDefined();
    expect(cleanupSignal).not.toBe(controller.signal);
    expect(cleanupSignal?.aborted).toBe(false);
  });
});
