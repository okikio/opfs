import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createS3Client, S3_LIMITS, S3Error } from "../src/s3.ts";
import { createS3Driver, createS3DriverFromClient } from "../src/driver/s3.ts";
import { RequestCapture } from "./http.ts";
import { streamBytes } from "./stream.ts";

/** AWS documentation credentials used only for deterministic Signature Version 4 tests. */
const credentials = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

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

  it("parses ListObjectsV2 without a protocol-specific XML regex", async () => {
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

    const parts = requests.filter((request) => new URL(request.url).searchParams.has("partNumber"));
    expect(parts).toHaveLength(5);
    expect(parts[0]?.headers.get("x-amz-copy-source-range")).toBe(`bytes=0-${1024 * 1024 * 1024 - 1}`);
    expect(parts[0]?.headers.get("x-amz-copy-source-if-match")).toBe('"source"');
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
    expect(body.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(body.indexOf("<PartNumber>2</PartNumber>"));
    expect(requests[0]!.headers.get("x-amz-mp-object-size")).toBe("10");

    await expect(client.completeUpload(
      { key: "duplicate.bin", id: "upload" },
      [{ number: 1, etag: '"a"' }, { number: 1, etag: '"b"' }],
    )).rejects.toThrow(RangeError);
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
          controller.abort(new DOMException("caller cancelled", "AbortError"));
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
    )).rejects.toBeDefined();

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

    await expect(client.createUpload("ambiguous.bin")).rejects.toBeDefined();
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

  it("surfaces redirects without following a signed request", async () => {
    let targetHits = 0;
    const client = createS3Client({
      endpoint: "https://storage.example",
      bucket: "bucket",
      region: "auto",
      credentials,
      fetch: async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: 307, headers: { location: "https://other.example/bucket/key" } });
      },
    });

    const response = await client.request({ method: "GET", key: "key" });
    if (response.url === "https://other.example/bucket/key") targetHits += 1;

    expect(response.status).toBe(307);
    expect(targetHits).toBe(0);
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
