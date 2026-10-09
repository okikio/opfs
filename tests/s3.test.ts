import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { Buffer } from "node:buffer";
import { runInNewContext } from "node:vm";
import { parse } from "@std/xml/parse";

import { createS3Client, S3_LIMITS, S3CommitError, S3Error } from "../src/s3.ts";
import { createS3Driver, createS3DriverFromClient } from "../src/driver/s3.ts";
import { RequestCapture } from "./http.ts";
import { changeStreamPrototype, streamBytes } from "./stream.ts";
import { within } from "./gate.ts";
import { isStream } from "../src/body.ts";
import { withReleases } from "./close.ts";
import { readResponse } from "../src/response.ts";

/** Reads transmitted multipart scalar fields independently of the request builder. */
function completedParts(value: string): Record<string, string>[] {
  const root = parse(value).root;
  if (root.name.local !== "CompleteMultipartUpload") throw new SyntaxError("Expected multipart completion XML.");
  return root.children.filter((node) => node.type === "element").map((part) => {
    if (part.name.local !== "Part") throw new SyntaxError("Expected direct Part entries.");
    const fields = part.children.filter((node) => node.type === "element");
    if (
      fields.length !== 2 || fields.filter((field) => field.name.local === "PartNumber").length !== 1 ||
      fields.filter((field) => field.name.local === "ETag").length !== 1
    ) {
      throw new SyntaxError("Expected one part number and ETag.");
    }
    return Object.fromEntries(fields.map((field) => {
      if (field.children.some((node) => node.type === "element")) throw new SyntaxError("Expected scalar part fields.");
      return [
        field.name.local,
        field.children.filter((node) => node.type === "text" || node.type === "cdata")
          .map((node) => node.text).join(""),
      ];
    }));
  });
}

it("reads equal completion fields across XML formatting and character-data spellings", () => {
  // XML 1.0 section 3.1 treats character references and CDATA as scalar content.
  // https://www.w3.org/TR/xml/#sec-starttags
  for (
    const body of [
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part></CompleteMultipartUpload>",
      '<CompleteMultipartUpload>\n  <Part>\n    <PartNumber>1</PartNumber>\n    <ETag><![CDATA["a"]]></ETag>\n  </Part>\n</CompleteMultipartUpload>',
    ]
  ) expect(completedParts(body)).toEqual([{ PartNumber: "1", ETag: '"a"' }]);
  expect(() =>
    completedParts(
      "<CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag><Value>a</Value></ETag></Part></CompleteMultipartUpload>",
    )
  )
    .toThrow(SyntaxError);
});

/** AWS documentation credentials used only for deterministic Signature Version 4 tests. */
const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

/** Captures thrown undefined independently from successful resolution. */
async function rejectedResponse(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (error) {
    return error;
  }
  throw new Error("Expected response retirement to reject.");
}

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

/** Creates one S3-style XML response without coupling tests to an HTTP server. */
function xml(value: string, init: ResponseInit = {}): Response {
  return new Response(value, {
    status: 200,
    headers: { "content-type": "application/xml", ...(init.headers ?? {}) },
    ...init,
  });
}

/** Refreshable credential source used to prove per-request SigV4 resolution. */
class S3CredentialSource {
  /** Number of times the client requested fresh credentials. */
  calls = 0;

  /** Returns valid temporary credentials with a request-specific session token. */
  get(): typeof credentials & { sessionToken: string } {
    this.calls += 1;
    return { ...credentials, sessionToken: `session-${this.calls}` };
  }
}

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
  it("reports direct clients as owned and injected clients as borrowed", () => {
    const options = {
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async () => new Response(null, { status: 200 }),
    };
    const client = createS3Client(options);

    expect(createS3Driver(options).inspect().ownership).toBe("owned");
    expect(createS3DriverFromClient(client).inspect().ownership).toBe("borrowed");
  });

  it("creates a deterministic Signature Version 4 request", async () => {
    let request: Request | undefined;
    const client = createS3Client({
      endpoint: "https://s3.amazonaws.com",
      bucket: "examplebucket",
      region: "us-east-1",
      credentials,
      now: () => new Date("2013-05-24T00:00:00.000Z"),
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 200 });
      },
    });

    await client.request({ method: "GET", key: "test file.txt", query: { z: "last", a: "first" } });

    expect(request?.url).toBe("https://s3.amazonaws.com/examplebucket/test%20file.txt?a=first&z=last");
    expect(request?.headers.get("x-amz-date")).toBe("20130524T000000Z");
    expect(request?.headers.get("authorization")).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=f9026f9c6df0d2208a26fd69dcb05b43269bda5a28e17f4186bb1570a3a600da",
    );
  });

  it("parses namespaced ListObjectsV2 objects, prefixes, and continuation tokens", async () => {
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async () =>
        xml(`<?xml version="1.0" encoding="UTF-8"?>
        <ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
          <Contents><Key>root/a.txt</Key><LastModified>2026-08-14T12:00:00.000Z</LastModified><ETag>&quot;a&quot;</ETag><Size>4</Size></Contents>
          <CommonPrefixes><Prefix>root/nested/</Prefix></CommonPrefixes>
          <NextContinuationToken>next-token</NextContinuationToken>
        </ListBucketResult>`),
    });

    const page = await client.list({ prefix: "root/", delimiter: "/" });
    expect(page.objects[0]?.key).toBe("root/a.txt");
    expect(page.objects[0]?.size).toBe(4);
    expect(page.prefixes).toEqual(["root/nested/"]);
    expect(page.cursor).toBe("next-token");
  });

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

  it("retains provider request identity on S3 errors", async () => {
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async () =>
        xml(
          "<Error><Code>AccessDenied</Code><Message>denied</Message><RequestId>request-1</RequestId><HostId>host-1</HostId></Error>",
          { status: 403 },
        ),
    });

    try {
      await client.get("private.txt");
      throw new Error("expected S3 failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3Error);
      if (error instanceof S3Error) {
        expect(error.code).toBe("AccessDenied");
        expect(error.requestId).toBe("request-1");
        expect(error.hostId).toBe("host-1");
      }
    }
  });
  it("treats an embedded CopyObject error as a failure even after HTTP 200", async () => {
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (request.method === "HEAD" && request.url.endsWith("/source.bin")) {
          return new Response(null, { status: 200, headers: { "content-length": "4", etag: '"source"' } });
        }
        if (request.method === "PUT") {
          return xml(
            "<Error><Code>SlowDown</Code><Message>copy failed</Message><RequestId>copy-r1</RequestId></Error>",
          );
        }
        return new Response(null, { status: 404 });
      },
    });

    try {
      await client.copy!("source.bin", "copy.bin");
      throw new Error("expected embedded copy failure");
    } catch (error) {
      expect(error).toBeInstanceOf(S3Error);
      if (error instanceof S3Error) {
        expect(error.code).toBe("SlowDown");
        expect(error.requestId).toBe("copy-r1");
      }
    }
  });

  it("uses UploadPartCopy rather than CopyObject above the 5 GB single-copy limit", async () => {
    const requests: Request[] = [];
    const size = S3_LIMITS.maxCopyBytes + 1;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      copyPartSize: 1024 * 1024 * 1024,
      concurrency: 2,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "HEAD" && url.pathname.endsWith("/source.bin")) {
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(size), etag: '"source"', "content-type": "application/octet-stream" },
          });
        }
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>copy-upload</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          const number = url.searchParams.get("partNumber");
          return xml(`<CopyPartResult><ETag>&quot;p${number}&quot;</ETag></CopyPartResult>`);
        }
        if (request.method === "POST" && url.searchParams.has("uploadId")) {
          return xml("<CompleteMultipartUploadResult><ETag>&quot;final&quot;</ETag></CompleteMultipartUploadResult>");
        }
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": String(size), etag: '"final"' } });
        }
        return new Response(null, { status: 200 });
      },
    });

    await client.copy!("source.bin", "copy.bin", { sourceIfMatch: '"source"' });

    // Concurrent signing can send the second request first. Part numbers define the copy order.
    const parts = requests.filter((request) => new URL(request.url).searchParams.has("partNumber")).sort((
      left,
      right,
    ) =>
      Number(new URL(left.url).searchParams.get("partNumber")) -
      Number(new URL(right.url).searchParams.get("partNumber"))
    );
    expect(parts).toHaveLength(5);
    const partBytes = 1024 * 1024 * 1024;
    for (const [index, part] of parts.entries()) {
      expect(new URL(part.url).searchParams.get("partNumber")).toBe(String(index + 1));
      expect(part.headers.get("x-amz-copy-source-range")).toBe(
        `bytes=${index * partBytes}-${Math.min(size, (index + 1) * partBytes) - 1}`,
      );
      expect(part.headers.get("x-amz-copy-source-if-match")).toBe('"source"');
    }
    expect(requests.some((request) => request.method === "PUT" && !new URL(request.url).searchParams.has("partNumber")))
      .toBe(false);
  });

  it("surfaces embedded UploadPartCopy failures and aborts the unfinished multipart copy", async () => {
    let aborted = false;
    const size = S3_LIMITS.maxCopyBytes + 1;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      copyPartSize: 1024 * 1024 * 1024,
      concurrency: 1,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (request.method === "HEAD" && url.pathname.endsWith("/source.bin")) {
          return new Response(null, { status: 200, headers: { "content-length": String(size), etag: '"source"' } });
        }
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>copy-upload</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          return xml(
            "<Error><Code>SlowDown</Code><Message>copy part failed</Message><RequestId>part-r1</RequestId></Error>",
          );
        }
        if (request.method === "DELETE" && url.searchParams.has("uploadId")) {
          aborted = true;
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 500 });
      },
    });

    try {
      await client.copy!("source.bin", "copy.bin");
      throw new Error("expected multipart copy failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      if (error instanceof AggregateError) {
        const provider = error.errors.find((entry): entry is S3Error => entry instanceof S3Error);
        expect(provider?.code).toBe("SlowDown");
        expect(provider?.requestId).toBe("part-r1");
      }
    }
    expect(aborted).toBe(true);
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

  it("applies source conditions to multipart copy and destination conditions only at commit", async () => {
    const requests: Request[] = [];
    const size = S3_LIMITS.maxCopyBytes + 1;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      copyPartSize: 1024 * 1024 * 1024,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "HEAD" && url.pathname.endsWith("/source.bin")) {
          return new Response(null, { status: 200, headers: { "content-length": String(size), etag: '"source"' } });
        }
        if (request.method === "POST" && url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>u</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "PUT" && url.searchParams.has("partNumber")) {
          return xml("<CopyPartResult><ETag>&quot;part&quot;</ETag></CopyPartResult>");
        }
        if (request.method === "POST" && url.searchParams.has("uploadId")) {
          return xml("<CompleteMultipartUploadResult><ETag>&quot;done&quot;</ETag></CompleteMultipartUploadResult>");
        }
        return new Response(null, { status: 200, headers: { "content-length": String(size), etag: '"done"' } });
      },
    });

    await client.copy!("source.bin", "copy.bin", {
      sourceIfMatch: '"source"',
      sourceIfNoneMatch: '"stale"',
      ifNoneMatch: "*",
    });

    const part = requests.find((request) => new URL(request.url).searchParams.has("partNumber"));
    const complete = requests.find((request) =>
      request.method === "POST" && new URL(request.url).searchParams.has("uploadId")
    );
    expect(part?.headers.get("x-amz-copy-source-if-match")).toBe('"source"');
    expect(part?.headers.get("x-amz-copy-source-if-none-match")).toBe('"stale"');
    expect(part?.headers.has("if-none-match")).toBe(false);
    expect(complete?.headers.get("if-none-match")).toBe("*");
  });

  it("uses virtual-hosted addressing and canonical encoded query ordering", async () => {
    const capture = new RequestCapture();
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket-name",
      region: "us-east-1",
      credentials,
      addressing: "virtual",
      now: () => new Date("2026-08-14T12:00:00.000Z"),
      fetch: capture.fetch.bind(capture),
    });

    await client.request({
      method: "GET",
      key: "folder/a b.txt",
      query: { z: ["2", "1"], "a b": "!*" },
    });

    expect(capture.latest?.url).toBe(
      "https://bucket-name.storage.example/folder/a%20b.txt?a%20b=%21%2A&z=1&z=2",
    );
    expect(capture.latest?.headers.get("authorization")).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date",
    );
  });

  it("resolves temporary credentials for every request and signs the session token", async () => {
    const source = new S3CredentialSource();
    const capture = new RequestCapture();
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials: source.get.bind(source),
      now: () => new Date("2026-08-14T12:00:00.000Z"),
      fetch: capture.fetch.bind(capture),
    });

    await client.request({ method: "HEAD", key: "one" });
    await client.request({ method: "HEAD", key: "two" });

    expect(source.calls).toBe(2);
    expect(capture.requests[0]?.headers.get("x-amz-security-token")).toBe("session-1");
    expect(capture.requests[1]?.headers.get("x-amz-security-token")).toBe("session-2");
    expect(capture.requests[0]?.headers.get("authorization")).toContain("x-amz-security-token");
  });

  it("uses UNSIGNED-PAYLOAD for an unmaterialized low-level stream", async () => {
    const capture = new RequestCapture();
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      fetch: capture.fetch.bind(capture),
    });

    await client.request({
      method: "PUT",
      key: "stream.bin",
      body: streamBytes([new Uint8Array([1, 2, 3])]),
    });

    expect(capture.latest?.headers.get("x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");
  });

  it("hashes replayable low-level Web bodies instead of weakening them to UNSIGNED-PAYLOAD", async () => {
    const bodies: BodyInit[] = [
      new Uint8Array([1, 2, 3]).buffer,
      new Uint8Array([1, 2, 3]),
      new Blob([new Uint8Array([1, 2, 3])]),
    ];

    for (const body of bodies) {
      const capture = new RequestCapture();
      const client = createS3Client({
        endpoint: "https://storage.example",
        bucket: "bucket",
        region: "us-east-1",
        credentials,
        fetch: capture.fetch.bind(capture),
      });

      await client.request({ method: "PUT", key: "body.bin", body });
      expect(capture.latest?.headers.get("x-amz-content-sha256")).toBe(
        "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
      );
    }
  });

  it("hashes URLSearchParams using the exact Fetch form body serialization", async () => {
    const capture = new RequestCapture();
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "us-east-1",
      credentials,
      fetch: capture.fetch.bind(capture),
    });

    await client.request({
      method: "POST",
      key: "form",
      body: new URLSearchParams({ a: "1", b: "two" }),
    });

    expect(capture.latest?.headers.get("x-amz-content-sha256")).toBe(
      "c06685fc4150186a5cdd90d87b503c941ef9dc60c9617ac388cf15f193f5bef1",
    );
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

describe("S3 request policy", () => {
  it("retries replayable 503 responses, refreshes credentials, and records request metrics", async () => {
    let attempts = 0;
    const source = new S3CredentialSource();
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials: () => source.get(),
      request: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: attempts === 1 ? 503 : 200 });
      },
    });

    const response = await client.request({ method: "PUT", key: "retry.bin", body: new Uint8Array([1]) });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(source.calls).toBe(2);
    expect(client.getMetrics().requests).toBe(2);
    expect(client.getMetrics().retries).toBe(1);
  });

  it("retries a replayable Fetch transport failure and returns the next response", async () => {
    let attempts = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      request: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("temporary network failure");
        return new Response(null, { status: 200 });
      },
    });

    const response = await client.request({ method: "GET", key: "retry-network.bin" });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(client.getMetrics().retries).toBe(1);
    expect(client.getMetrics().failures).toBe(0);
  });

  it("does not retry deterministic credential failures", async () => {
    let credentialCalls = 0;
    let fetches = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials: () => {
        credentialCalls += 1;
        throw new TypeError("invalid credential source");
      },
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 200 });
      },
    });

    await expect(client.request({ method: "GET", key: "key" })).rejects.toThrow("invalid credential source");
    expect(credentialCalls).toBe(1);
    expect(fetches).toBe(0);
  });

  it("does not retry multipart initiation when the response is ambiguous", async () => {
    let attempts = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
        return new Response("<Error><Code>SlowDown</Code></Error>", { status: 503 });
      },
    });

    await expect(client.createUpload("ambiguous.bin")).rejects.toMatchObject({
      name: "S3Error",
      status: 503,
      code: "SlowDown",
    });
    expect(attempts).toBe(1);
  });

  it("lets a low-level caller disable retry for a replayable body", async () => {
    let attempts = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
        return new Response(null, { status: 503 });
      },
    });

    const response = await client.request({ method: "PUT", key: "once.bin", body: new Uint8Array([1]), retry: false });
    expect(response.status).toBe(503);
    expect(attempts).toBe(1);
  });

  it("does not retry a one-shot ReadableStream body", async () => {
    let attempts = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async (_input, init) => {
        attempts += 1;
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 503 });
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    const response = await client.request({ method: "PUT", key: "stream.bin", body });

    expect(response.status).toBe(503);
    expect(attempts).toBe(1);
  });

  it("keeps a native request stream across supported prototype changes one-shot with Fetch duplex", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const prototype: object = runInNewContext("({})");
    const detached = changeStreamPrototype(body, prototype);
    expect(body instanceof ReadableStream).toBe(!detached);
    let attempts = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async (input, init) => {
        attempts++;
        expect(Reflect.get(init!, "duplex")).toBe("half");
        expect([...new Uint8Array(await new Request(input, init).arrayBuffer())]).toEqual([]);
        return new Response(null, { status: 503 });
      },
    });
    const response = await client.request({ method: "PUT", key: "stream.bin", body });
    expect(response.status).toBe(503);
    expect(attempts).toBe(1);
    // Fetch owns the request body's reader after dispatch. Its native Request
    // consumption above proves EOF; releasing that reader is not this client's API.
  });

  it("surfaces redirects without following a signed request", async () => {
    const urls: string[] = [];
    const redirect = new Response(null, { status: 307, headers: { location: "https://other.example/bucket/key" } });
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async (input, init) => {
        urls.push(String(input));
        expect(init?.redirect).toBe("manual");
        return redirect;
      },
    });

    const response = await client.request({ method: "GET", key: "key" });

    expect(response.status).toBe(307);
    expect(response).toBe(redirect);
    expect(urls).toEqual(["https://storage.example/bucket/key"]);
  });

  it("applies a per-attempt timeout without requiring the caller to race the promise", async () => {
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      request: { retries: 0, timeoutMs: 5 },
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    });

    await expect(client.request({ method: "GET", key: "slow" })).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

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

describe("S3 source admission precedes publication", () => {
  it("rejects an invalid byte chunk, retires input, and leaves the destination unchanged", async () => {
    const destination = Uint8Array.of(17, 31, 47);
    let published = destination;
    let cancels = 0;
    let aborts = 0;
    let completions = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        Reflect.apply(controller.enqueue, controller, ["not bytes"]);
      },
      cancel() {
        cancels++;
      },
    });
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      delayedMultipart: false,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        if (url.searchParams.has("uploads")) {
          return xml("<InitiateMultipartUploadResult><UploadId>owned</UploadId></InitiateMultipartUploadResult>");
        }
        if (request.method === "DELETE") {
          aborts++;
          return new Response(null, { status: 204 });
        }
        completions++;
        published = new Uint8Array();
        return new Response(null);
      },
    });
    expect(await rejectedResponse(client.put("destination", source))).toBeInstanceOf(TypeError);
    expect(published).toBe(destination);
    expect(completions).toBe(0);
    expect(aborts).toBe(1);
    expect(cancels).toBe(1);
    expect(source.locked).toBe(false);
  });

  it("retires already acquired input beside failed multipart initialization", async () => {
    const primary = new Error("actual initiation transport failure");
    const cleanup = new Error("actual input cancellation failure");
    let cancels = 0;
    let calls = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancels++;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      delayedMultipart: false,
      fetch: async () => {
        calls++;
        throw primary;
      },
    });
    expect(await rejectedResponse(client.put("destination", source))).toMatchObject({ errors: [primary, cleanup] });
    expect(cancels).toBe(1);
    expect(calls).toBe(1);
    expect(source.locked).toBe(false);
  });
});

describe("validated multipart allocation ownership", () => {
  for (const route of ["direct", "put", "copy"] as const) {
    for (const abortFails of [false, true]) {
      it(`${route} retains acquired allocation through failed response retirement and ${abortFails ? "failed" : "successful"} abort`, async () => {
        await withReleases(async (releases) => {
          const retirement = new Error("actual initialization reader release failure");
          const abortFault = new Error("actual remote abort response retirement failure");
          const inputRetiring = Promise.withResolvers<void>();
          const inputReleased = Promise.withResolvers<void>();
          const abortRetiring = Promise.withResolvers<void>();
          const abortReleased = Promise.withResolvers<void>();
          let aborted = 0;
          let parts = 0;
          let completed = 0;
          const client = createS3Client({
            endpoint: "https://s3.example.test",
            bucket: "owned",
            region: "us-east-1",
            credentials,
            delayedMultipart: false,
            request: { retries: 0 },
            fetch: async (input, init) => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (request.method === "HEAD") {
                return new Response(null, {
                  headers: {
                    "content-length": String(S3_LIMITS.maxCopyBytes + 1),
                    etag: '"source"',
                  },
                });
              }
              if (url.searchParams.has("uploads")) {
                const response = xml(
                  "<InitiateMultipartUploadResult><UploadId>owned+opaque</UploadId></InitiateMultipartUploadResult>",
                );
                const acquire = response.body!.getReader.bind(response.body);
                Object.defineProperty(response.body, "getReader", {
                  value() {
                    const reader = acquire();
                    const release = reader.releaseLock.bind(reader);
                    reader.releaseLock = () => {
                      release();
                      throw retirement;
                    };
                    return reader;
                  },
                });
                return response;
              }
              if (request.method === "DELETE") {
                aborted++;
                expect(url.searchParams.get("uploadId")).toBe("owned+opaque");
                expect(request.signal.aborted).toBe(false);
                if (route === "put") expect(source?.locked).toBe(false);
                return new Response(
                  new ReadableStream<Uint8Array>({
                    async cancel() {
                      abortRetiring.resolve();
                      await abortReleased.promise;
                      if (abortFails) throw abortFault;
                    },
                  }, { highWaterMark: 0 }),
                );
              }
              if (url.searchParams.has("partNumber")) parts++;
              else completed++;
              throw new Error("Initialization failure must not admit parts or publication");
            },
          });
          const source = new ReadableStream<Uint8Array>({
            async cancel() {
              inputRetiring.resolve();
              await inputReleased.promise;
            },
          }, { highWaterMark: 0 });
          const pending = route === "direct"
            ? client.createUpload("destination")
            : route === "put"
            ? client.put("destination", source)
            : client.copy("source", "destination");
          let settled = false;
          const observed = pending.then(
            () => {
              settled = true;
              throw new Error("Expected initialization retirement failure");
            },
            (reason: unknown) => {
              settled = true;
              return reason;
            },
          );
          void observed.catch(() => {});
          releases.push(async () => {
            await within(Promise.allSettled([observed]), "allocation owner fixture drain");
          });
          releases.push(() => {
            inputReleased.resolve();
            abortReleased.resolve();
          });
          if (route === "put") {
            await within(inputRetiring.promise, "allocation failed initialization input drain");
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(aborted).toBe(0);
            expect(settled).toBe(false);
            inputReleased.resolve();
          }
          await within(abortRetiring.promise, "allocation abort body retirement");
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          expect(settled).toBe(false);
          expect(aborted).toBe(1);
          abortReleased.resolve();
          const failure = await within(observed, "allocation owner terminal outcome");
          if (abortFails) expect(failure).toMatchObject({ errors: [retirement, abortFault] });
          else expect(failure).toBe(retirement);
          expect(parts).toBe(0);
          expect(completed).toBe(0);
          expect(aborted).toBe(1);
        });
      });
    }
  }

  for (
    const payload of [
      "<Other><UploadId>not-owned</UploadId></Other>",
      "<InitiateMultipartUploadResult><UploadId>one</UploadId><UploadId>two</UploadId></InitiateMultipartUploadResult>",
      "<InitiateMultipartUploadResult><Nested><UploadId>not-owned</UploadId></Nested></InitiateMultipartUploadResult>",
    ]
  ) {
    it(`does not invent allocation from malformed identity ${payload}`, async () => {
      let requests = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => {
          requests++;
          return xml(payload);
        },
      });
      await expect(client.createUpload("destination")).rejects.toBeInstanceOf(SyntaxError);
      expect(requests).toBe(1);
    });
  }

  it("transfers a successfully retired public allocation unchanged without aborting it", async () => {
    let requests = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async () => {
        requests++;
        return xml("<InitiateMultipartUploadResult><UploadId>owned+opaque</UploadId></InitiateMultipartUploadResult>");
      },
    });
    expect(await client.createUpload("destination")).toEqual({ key: "destination", id: "owned+opaque" });
    expect(requests).toBe(1);
  });
});

describe("S3 materialized put byte admission", () => {
  const positive = [
    ["empty", () => new Uint8Array(0), []],
    ["shared empty", () => new Uint8Array(new SharedArrayBuffer(0)), []],
    ["shared offset", () => {
      const view = new Uint8Array(new SharedArrayBuffer(4));
      view.set([99, 17, 31, 98]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["offset", () => Uint8Array.of(99, 17, 31, 88).subarray(1, 3), [17, 31]],
    ["Buffer offset", () => Buffer.from([99, 17, 31, 88]).subarray(1, 3), [17, 31]],
    ["subclass", () => {
      class Bytes extends Uint8Array {}
      return new Bytes([17, 31]);
    }, [17, 31]],
    ["foreign realm offset", () => {
      const bytes: unknown = runInNewContext("new Uint8Array([99,17,31,88]).subarray(1,3)");
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes instanceof Uint8Array).toBe(false);
      return bytes;
    }, [17, 31]],
    ["resizable offset", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const view = new Uint8Array(backing);
      view.set([99, 17, 31, 88]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["resizable tracking empty", () => {
      const backing = new ArrayBuffer(2, { maxByteLength: 4 });
      const view = new Uint8Array(backing);
      backing.resize(0);
      return view;
    }, []],
  ] as const;
  for (const [kind, create, expected] of positive) {
    it(`accepts genuine readable ${kind} with exact request bytes`, async () => {
      let calls = 0;
      let observed: number[] | undefined;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          observed = [...new Uint8Array(await request.arrayBuffer())];
          return new Response(null, { headers: { etag: '"accepted"' } });
        },
      });
      const bytes: unknown = create();
      await Reflect.apply(client.put, client, ["destination", bytes]);
      expect(calls).toBe(1);
      expect(observed).toEqual(expected);
    });
  }

  const invalid = [
    ["detached zero-length view", () => {
      const bytes = Uint8Array.of(17);
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["out-of-bounds zero-length view", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const bytes = new Uint8Array(backing, 2, 2);
      backing.resize(1);
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["Int8Array", () => new Int8Array([17])],
    ["Uint16Array", () => new Uint16Array([17])],
    ["DataView", () => new DataView(new ArrayBuffer(1))],
    ["tag spoof", () => ({ [Symbol.toStringTag]: "Uint8Array", byteLength: 0 })],
    ["ordinary object", () => ({ byteLength: 0 })],
  ] as const;
  for (const [kind, create] of invalid) {
    it(`rejects ${kind} before request or remote allocation`, async () => {
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => {
          calls++;
          return new Response(null, { headers: { etag: '"unexpected"' } });
        },
      });
      const bytes: unknown = create();
      await expect(Reflect.apply(client.put, client, ["destination", bytes])).rejects.toBeInstanceOf(TypeError);
      expect(calls).toBe(0);
    });
  }
});

describe("S3 materialized part byte admission", () => {
  const positive = [
    ["empty", () => new Uint8Array(0), []],
    ["shared empty", () => new Uint8Array(new SharedArrayBuffer(0)), []],
    ["shared offset", () => {
      const view = new Uint8Array(new SharedArrayBuffer(4));
      view.set([99, 17, 31, 98]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["offset", () => Uint8Array.of(99, 17, 31, 88).subarray(1, 3), [17, 31]],
    ["Buffer offset", () => Buffer.from([99, 17, 31, 88]).subarray(1, 3), [17, 31]],
    ["subclass", () => {
      class Bytes extends Uint8Array {}
      return new Bytes([17, 31]);
    }, [17, 31]],
    ["foreign realm offset", () => {
      const bytes: unknown = runInNewContext("new Uint8Array([99,17,31,88]).subarray(1,3)");
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes instanceof Uint8Array).toBe(false);
      return bytes;
    }, [17, 31]],
    ["resizable offset", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const view = new Uint8Array(backing);
      view.set([99, 17, 31, 88]);
      return view.subarray(1, 3);
    }, [17, 31]],
    ["resizable tracking empty", () => {
      const backing = new ArrayBuffer(2, { maxByteLength: 4 });
      const view = new Uint8Array(backing);
      backing.resize(0);
      return view;
    }, []],
  ] as const;
  for (const [kind, create, expected] of positive) {
    it(`accepts genuine readable ${kind} with exact request bytes`, async () => {
      let calls = 0;
      let observed: number[] | undefined;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          observed = [...new Uint8Array(await request.arrayBuffer())];
          return new Response(null, { headers: { etag: '"accepted"' } });
        },
      });
      const bytes: unknown = create();
      await Reflect.apply(client.uploadPart, client, [{ key: "destination", id: "caller-owned" }, 1, bytes]);
      expect(calls).toBe(1);
      expect(observed).toEqual(expected);
    });
  }

  const invalid = [
    ["detached zero-length view", () => {
      const bytes = Uint8Array.of(17);
      structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["out-of-bounds zero-length view", () => {
      const backing = new ArrayBuffer(4, { maxByteLength: 8 });
      const bytes = new Uint8Array(backing, 2, 2);
      backing.resize(1);
      expect(bytes.byteLength).toBe(0);
      return bytes;
    }],
    ["Int8Array", () => new Int8Array([17])],
    ["Uint16Array", () => new Uint16Array([17])],
    ["DataView", () => new DataView(new ArrayBuffer(1))],
    ["tag spoof", () => ({ [Symbol.toStringTag]: "Uint8Array", byteLength: 0 })],
    ["ordinary object", () => ({ byteLength: 0 })],
  ] as const;
  for (const [kind, create] of invalid) {
    it(`rejects ${kind} before request or remote allocation`, async () => {
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async () => {
          calls++;
          return new Response(null, { headers: { etag: '"unexpected"' } });
        },
      });
      const bytes: unknown = create();
      await expect(Reflect.apply(client.uploadPart, client, [{ key: "destination", id: "caller-owned" }, 1, bytes]))
        .rejects.toBeInstanceOf(TypeError);
      expect(calls).toBe(0);
    });
  }
});

describe("S3 body union admission across delayedMultipart", () => {
  for (const enabled of [false, true]) {
    for (const kind of ["ordinary", "tag", "duck", "getter"] as const) {
      it(`rejects ${kind} pretender before retirement under delayedMultipart=${enabled}`, async () => {
        let effects = 0;
        let calls = 0;
        const bytes: unknown = kind === "ordinary"
          ? { byteLength: 0 }
          : kind === "tag"
          ? { [Symbol.toStringTag]: "Uint8Array", byteLength: 0 }
          : kind === "duck"
          ? {
            getReader() {
              effects++;
              throw new Error("Borrowed reader must not be acquired");
            },
            cancel() {
              effects++;
              throw new Error("Borrowed cancellation must not be called");
            },
          }
          : Object.defineProperties({}, {
            getReader: {
              get() {
                effects++;
                throw new Error("Pretender getter must not be evaluated");
              },
            },
            cancel: {
              get() {
                effects++;
                throw new Error("Pretender cancellation getter must not be evaluated");
              },
            },
          });
        const client = createS3Client({
          endpoint: "https://s3.example.test",
          bucket: "owned",
          region: "us-east-1",
          credentials,
          delayedMultipart: enabled,
          fetch: async () => {
            calls++;
            return new Response(null);
          },
        });
        const failure = await rejectedResponse(Reflect.apply(client.put, client, ["destination", bytes]));
        expect(failure).toBeInstanceOf(TypeError);
        expect(failure).not.toBeInstanceOf(AggregateError);
        expect(effects).toBe(0);
        expect(calls).toBe(0);
      });
    }

    it(`preserves branded readable empty bytes across supported prototype changes under delayedMultipart=${enabled}`, async () => {
      let reads = 0;
      let cancels = 0;
      let calls = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
        cancel() {
          cancels++;
        },
      }, { highWaterMark: 0 });
      const foreign: unknown = runInNewContext("({})");
      if (typeof foreign !== "object" || foreign === null) {
        throw new Error("Foreign prototype fixture must be an object");
      }
      expect(foreign instanceof Object).toBe(false);
      const detached = changeStreamPrototype(source, foreign);
      expect(source instanceof ReadableStream).toBe(!detached);
      const acquire = source.getReader.bind(source);
      Object.defineProperty(source, "getReader", {
        value() {
          reads++;
          return acquire();
        },
      });
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        delayedMultipart: enabled,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          const url = new URL(request.url);
          if (url.searchParams.has("uploads")) {
            return xml(
              "<InitiateMultipartUploadResult><UploadId>owned-empty</UploadId></InitiateMultipartUploadResult>",
            );
          }
          if (request.method === "DELETE") return new Response(null, { status: 204 });
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([]);
          return new Response(null, { headers: { etag: '"empty"' } });
        },
      });
      const receipt = await client.put("destination", source);
      expect(receipt.size).toBe(0);
      expect(calls).toBe(enabled ? 1 : 3);
      expect(reads).toBe(1);
      expect(cancels).toBe(0);
      expect(source.locked).toBe(false);
    });
  }
});

describe("S3 readable bytes across delayedMultipart", () => {
  for (const enabled of [false, true]) {
    it(`accepts genuine foreign bytes under delayedMultipart=${enabled}`, async () => {
      const bytes: unknown = runInNewContext("new Uint8Array([99,17,31,88]).subarray(1,3)");
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes instanceof Uint8Array).toBe(false);
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        delayedMultipart: enabled,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([17, 31]);
          return new Response(null, { status: 201, headers: { etag: '"bytes"' } });
        },
      });
      const receipt = await Reflect.apply(client.put, client, ["destination", bytes]);
      expect(receipt.size).toBe(2);
      expect(calls).toBe(1);
    });
    for (const kind of ["detached", "out-of-bounds"] as const) {
      it(`rejects ${kind} zero-length backing under delayedMultipart=${enabled}`, async () => {
        let calls = 0;
        const client = createS3Client({
          endpoint: "https://s3.example.test",
          bucket: "owned",
          region: "us-east-1",
          credentials,
          delayedMultipart: enabled,
          fetch: async () => {
            calls++;
            return new Response(null);
          },
        });
        const backing = new ArrayBuffer(4, { maxByteLength: 8 });
        const bytes = new Uint8Array(backing, 2, 2);
        if (kind === "detached") structuredClone(backing, { transfer: [backing] });
        else backing.resize(1);
        expect(bytes.byteLength).toBe(0);
        const failure = await rejectedResponse(client.put("destination", bytes));
        expect(failure).toBeInstanceOf(TypeError);
        expect(failure).not.toBeInstanceOf(AggregateError);
        expect(calls).toBe(0);
      });
    }
  }
});

it("native body admission does not acquire, pull, cancel or evaluate a shadowed locked getter", async () => {
  let reads = 0;
  let pulls = 0;
  let cancels = 0;
  let getters = 0;
  const source = new ReadableStream<Uint8Array>({
    pull() {
      pulls++;
    },
    cancel() {
      cancels++;
    },
  }, { highWaterMark: 0 });
  const acquire = source.getReader.bind(source);
  Object.defineProperty(source, "getReader", {
    value() {
      reads++;
      return acquire();
    },
  });
  Object.defineProperty(source, "locked", {
    get() {
      getters++;
      throw new Error("Shadowed stream getter must not establish brand");
    },
  });
  try {
    expect(isStream(source)).toBe(true);
    expect(isStream({
      getReader() {
        reads++;
      },
      cancel() {
        cancels++;
      },
    })).toBe(false);
    expect(reads).toBe(0);
    expect(pulls).toBe(0);
    expect(cancels).toBe(0);
    expect(getters).toBe(0);
  } finally {
    await source.cancel();
  }
});

describe("S3 intrinsic byte metadata", () => {
  for (const poisoned of [false, true]) {
    it(`uses the two native bytes despite ${poisoned ? "throwing range getters" : "a shadowed zero length"}`, async () => {
      const bytes = Uint8Array.of(99, 7, 8, 98).subarray(1, 3);
      Object.defineProperty(bytes, "byteLength", { value: 0 });
      if (poisoned) {
        for (const name of ["buffer", "byteOffset", "subarray", Symbol.iterator]) {
          Object.defineProperty(bytes, name, {
            get() {
              throw new Error("Borrowed metadata was consulted.");
            },
          });
        }
      }
      let calls = 0;
      const client = createS3Client({
        endpoint: "https://s3.example.test",
        bucket: "owned",
        region: "us-east-1",
        credentials,
        fetch: async (input, init) => {
          calls++;
          const request = new Request(input, init);
          expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([7, 8]);
          const digest = await crypto.subtle.digest("SHA-256", Uint8Array.of(7, 8));
          const expectedHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
          expect(request.headers.get("x-amz-content-sha256")).toBe(expectedHash);
          return new Response(null, { status: 200, headers: { etag: '"accepted"' } });
        },
      });
      const receipt = await client.put("destination", bytes);
      expect(receipt.size).toBe(2);
      expect(calls).toBe(1);
      await expect(client.put("destination", bytes, { size: 0 })).rejects.toBeInstanceOf(RangeError);
      expect(calls).toBe(1);
    });
  }
});

for (const kind of ["shared", "resizable"] as const) {
  it(`captures ${kind} wire bytes and receipt size before credential-time source changes`, async () => {
    const backing = kind === "shared" ? new SharedArrayBuffer(4) : new ArrayBuffer(4, { maxByteLength: 8 });
    const whole = new Uint8Array(backing);
    whole.set([99, 7, 8, 98]);
    const bytes = whole.subarray(1, 3);
    let authorizations = 0;
    const change = () => {
      authorizations++;
      if (backing instanceof ArrayBuffer) backing.resize(0);
      else whole.set([0, 9, 10, 0]);
    };
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials: () => {
        change();
        return credentials;
      },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([7, 8]);
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.of(7, 8));
        const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
        expect(request.headers.get("x-amz-content-sha256")).toBe(hash);
        return new Response(null, { status: 200, headers: { etag: '"accepted"' } });
      },
    });
    const receipt = await client.put("destination", bytes, { size: 2 });
    expect(receipt.size).toBe(2);
    expect(authorizations).toBe(1);
  });
}

it("retains raw BodyInit view kinds while ignoring borrowed range metadata", async () => {
  for (const kind of ["DataView", "Uint16Array"] as const) {
    const backing = Uint8Array.of(7, 8).buffer;
    const bytes = kind === "DataView" ? new DataView(backing) : new Uint16Array(backing);
    for (const name of ["buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(bytes, name, {
        get() {
          throw new Error("Borrowed BodyInit metadata was consulted.");
        },
      });
    }
    let calls = 0;
    const client = createS3Client({
      endpoint: "https://s3.example.test",
      bucket: "owned",
      region: "us-east-1",
      credentials,
      fetch: async (input, init) => {
        calls++;
        const request = new Request(input, init);
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([7, 8]);
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.of(7, 8));
        const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
        expect(request.headers.get("x-amz-content-sha256")).toBe(hash);
        return new Response(null);
      },
    });
    const response = await client.request({ method: "PUT", key: "raw", body: bytes });
    expect(response.ok).toBe(true);
    expect(calls).toBe(1);
  }
});
