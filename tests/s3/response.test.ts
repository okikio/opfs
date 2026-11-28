/** S3: Response acknowledgement and retirement retain their own authority and failures. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client, S3Error } from "../../src/backend/s3/client.ts";
import { within } from "../gate.ts";
import { withReleases } from "../close.ts";
import { readResponse } from "../../src/response.ts";
import { credentials, rejectedResponse } from "./fixture.ts";

describe("Internal provider response ownership", () => {
  it("awaits unused-body retirement without pulling or materializing it", async () => {
    await withReleases(async (releases) => {
      const admitted = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      let pulls = 0;
      let cancellations = 0;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            pulls++;
          },
          async cancel() {
            cancellations++;
            admitted.resolve();
            await finish.promise;
          },
        }, { highWaterMark: 0 }),
      );
      const receipt = { etag: "acknowledged" };
      let settled = false;
      const pending = readResponse(response, () => receipt).finally(() => settled = true);
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      await within(admitted.promise, "response retirement admission");
      // Give an early-return owner time to settle while actual retirement is held.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(pulls).toBe(0);
      finish.resolve();
      expect(await pending).toBe(receipt);
      expect(cancellations).toBe(1);
    });
  });

  it("keeps fully parsed body authority without a second disposal", async () => {
    let cancellations = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("complete acknowledgement"));
          controller.close();
        },
        cancel() {
          cancellations++;
        },
      }),
    );
    expect(await readResponse(response, (text) => text())).toBe("complete acknowledgement");
    expect(cancellations).toBe(0);
    expect(response.body?.locked).toBe(false);
  });

  it("keeps reader retirement outside valid multipart XML acknowledgement classification", async () => {
    const disposal = new Error("Authored post-acknowledgement reader retirement failure.");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            '<CompleteMultipartUploadResult><ETag>"final"</ETag></CompleteMultipartUploadResult>',
          ),
        );
        controller.close();
      },
    });
    const acquire = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      value() {
        const reader = acquire();
        const unlock = reader.releaseLock.bind(reader);
        reader.releaseLock = () => {
          unlock();
          throw disposal;
        };
        return reader;
      },
    });
    let requests = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () => {
        requests++;
        return new Response(body);
      },
    });
    expect(
      await rejectedResponse(client.completeUpload({ key: "value", id: "owned-upload" }, [
        { number: 1, etag: '"part"' },
      ], { expectedSize: 1 })),
    ).toBe(disposal);
    expect(requests).toBe(1);
    expect(body.locked).toBe(false);
  });

  it("refuses a typed part acknowledgement whose response reader is borrowed", async () => {
    await withReleases(async (releases) => {
      let cancellations = 0;
      let requests = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const response = new Response(body, { headers: { etag: '"part"' } });
      const borrowed = body.getReader();
      releases.push(() => borrowed.releaseLock());
      releases.push(() => borrowed.cancel());
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => {
          requests++;
          return response;
        },
      });
      const reason = await rejectedResponse(
        client.uploadPart({ key: "value", id: "owned-upload" }, 1, new Uint8Array([65])),
      );
      expect(reason).toBeInstanceOf(TypeError);
      expect(requests).toBe(1);
      expect(body.locked).toBe(true);
      expect(cancellations).toBe(0);
    });
  });

  for (const reason of [undefined, null, new Error("Authored disposal failure.")]) {
    it(`preserves a sole disposal failure (${String(reason)})`, async () => {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw reason;
          },
        }),
      );
      expect(await rejectedResponse(readResponse(response, () => "acknowledged"))).toBe(reason);
    });
  }

  for (const primary of [undefined, null, new Error("Authored acknowledgement failure.")]) {
    it(`retains an acknowledgement failure and independent disposal failure (${String(primary)})`, async () => {
      const disposal = new Error("Authored disposal failure.");
      const response = new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            throw disposal;
          },
        }),
      );
      const observed = await rejectedResponse(readResponse(response, () => {
        throw primary;
      }));
      expect(observed).toBeInstanceOf(AggregateError);
      if (!(observed instanceof AggregateError)) throw new Error("Expected independent response failures.");
      expect(observed.errors).toEqual([primary, disposal]);
      expect(observed.cause).toBe(primary);
    });
  }

  it("retires accepted S3 missing deletes and missing multipart aborts", async () => {
    let cancelled = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled++;
            },
          }, { highWaterMark: 0 }),
          { status: 404 },
        ),
    });
    await client.delete("missing");
    await client.abortUpload({ key: "missing", id: "missing-upload" });
    expect(cancelled).toBe(2);
  });

  it("retires internally owned present/missing metadata responses", async () => {
    let requests = 0;
    let cancellations = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () => {
        requests++;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellations++;
            },
          }, { highWaterMark: 0 }),
          {
            status: requests === 1 ? 404 : 200,
            headers: { "content-length": "3", etag: "own" },
          },
        );
      },
    });
    expect(await client.head("missing")).toBeNull();
    expect(await client.head("present")).toMatchObject({ size: 3, etag: "own" });
    expect(cancellations).toBe(2);
  });

  it("retires successful S3 part headers and retains missing-ETag plus disposal faults", async () => {
    let cancelled = 0;
    let valid = true;
    const disposal = new Error("Part body disposal failed.");
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled++;
              if (!valid) throw disposal;
            },
          }, { highWaterMark: 0 }),
          { headers: valid ? { etag: "actual-part" } : {} },
        ),
    });
    expect(await client.uploadPart({ key: "value", id: "upload" }, 1, new Uint8Array([17]))).toEqual({
      number: 1,
      etag: "actual-part",
    });
    valid = false;
    const observed = await rejectedResponse(client.uploadPart({ key: "value", id: "upload" }, 2, new Uint8Array([31])));
    if (!(observed instanceof AggregateError)) throw new Error("Expected independent response failures.");
    expect(observed.errors[0]).toBeInstanceOf(S3Error);
    expect(observed.errors[1]).toBe(disposal);
    expect(observed.cause).toBe(observed.errors[0]);
    expect(cancelled).toBe(2);
  });

  it("does not call an acknowledged PUT cleanup fault an unknown publication or retry it", async () => {
    const disposal = new Error("Acknowledged body disposal failed.");
    let requests = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      request: { retries: 3 },
      fetch: async () => {
        requests++;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw disposal;
            },
          }),
          {
            headers: { etag: "acknowledged" },
          },
        );
      },
    });
    expect(await rejectedResponse(client.put("value", new Uint8Array([17])))).toBe(disposal);
    expect(requests).toBe(1);
  });

  it("leaves raw S3 requests and successful object streams with their caller", async () => {
    let cancelled = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled++;
            },
          }, { highWaterMark: 0 }),
        ),
    });
    const response = await client.request({ method: "GET" });
    const stream = await client.get("value");
    expect(cancelled).toBe(0);
    await response.body?.cancel();
    await stream.cancel();
    expect(cancelled).toBe(2);
  });

  for (const reason of [undefined, null, new Error("Authored error-body read failure.")]) {
    it(`keeps HTTP authority after a mid-body read failure (${String(reason)})`, async () => {
      let pulls = 0;
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("<Error>"));
          else controller.error(reason);
        },
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => new Response(body, { status: 403, headers: { "x-amz-request-id": "authored-mid-read" } }),
      });
      const observed = await rejectedResponse(client.put("value", new Uint8Array([17])));
      if (!(observed instanceof S3Error)) throw new Error("Expected the actual HTTP provider error.");
      expect(observed.status).toBe(403);
      expect(observed.requestId).toBe("authored-mid-read");
      expect(Object.hasOwn(observed, "cause")).toBe(true);
      expect(observed.cause).toBe(reason);
      expect(body.locked).toBe(false);
      expect(cancellations).toBe(0);
    });

    it(`keeps the HTTP error primary while retaining body-read failure (${String(reason)})`, async () => {
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(reason);
              },
            }),
            { status: 403, headers: { "x-amz-request-id": "authored-request", "x-amz-id-2": "authored-host" } },
          ),
      });
      const observed = await rejectedResponse(client.put("value", new Uint8Array([17])));
      expect(observed).toBeInstanceOf(S3Error);
      if (!(observed instanceof S3Error)) throw new Error("Expected the actual HTTP provider error.");
      expect(observed.status).toBe(403);
      expect(observed.requestId).toBe("authored-request");
      expect(observed.hostId).toBe("authored-host");
      expect(Object.hasOwn(observed, "cause")).toBe(true);
      expect(observed.cause).toBe(reason);
    });
  }

  it("keeps malformed proxy XML as secondary evidence without inventing a service code", async () => {
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () => new Response("<Error><broken", { status: 403, headers: { "x-amz-request-id": "authored" } }),
    });
    const observed = await rejectedResponse(client.put("value", new Uint8Array([17])));
    if (!(observed instanceof S3Error)) throw new Error("Expected the actual HTTP provider error.");
    expect(observed.status).toBe(403);
    expect(observed.requestId).toBe("authored");
    expect(observed.code).toBeUndefined();
    expect(observed.cause).toBeInstanceOf(Error);
  });
});
