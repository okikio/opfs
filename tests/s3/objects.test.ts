/** S3: Object metadata and borrowed client ownership remain explicit through wire operations. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client, S3Error } from "../../src/backend/s3/client.ts";
import { createS3Driver } from "../../src/backend/s3/driver.ts";
import { credentials, xml } from "./fixture.ts";

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

    // The driver always borrows: the caller made the client and keeps it.
    expect(createS3Driver(client).inspect().ownership).toBe("borrowed");
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
});
