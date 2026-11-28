/** S3: Server-side copies preserve source authorization, range conditions and failure evidence. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client, S3_LIMITS, S3Error } from "../../src/backend/s3/client.ts";
import { credentials, xml } from "./fixture.ts";

describe("S3 client", () => {
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
});
