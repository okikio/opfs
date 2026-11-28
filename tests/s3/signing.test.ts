/** S3: Authorization uses exact canonical bytes and request-local credentials. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client } from "../../src/backend/s3/client.ts";
import { RequestCapture } from "../http.ts";
import { streamBytes } from "../stream.ts";
import { credentials, S3CredentialSource } from "./fixture.ts";

describe("S3 client", () => {
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
});

it("preserves fixed S3 signing bytes with key caching enabled and disabled after crypto extraction", async () => {
  for (const signingKeyCache of [true, false]) {
    const order: string[] = [];
    const client = createS3Client({
      endpoint: "https://s3.amazonaws.com",
      bucket: "examplebucket",
      region: "us-east-1",
      credentials: () => {
        order.push("credentials");
        return credentials;
      },
      now: () => {
        order.push("clock");
        return new Date("2013-05-24T00:00:00.000Z");
      },
      signingKeyCache,
      fetch: async (_input, init) => {
        order.push("fetch");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request, " +
            "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
            "Signature=f9026f9c6df0d2208a26fd69dcb05b43269bda5a28e17f4186bb1570a3a600da",
        );
        return new Response(null);
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await client.request({ method: "GET", key: "test file.txt", query: { z: "last", a: "first" } });
    }
    expect(order).toEqual(["clock", "credentials", "fetch", "clock", "credentials", "fetch"]);
  }
});
