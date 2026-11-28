/** S3: Request policy preserves replay, credential refresh and native stream ownership. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createS3Client } from "../../src/backend/s3/client.ts";
import { changeStreamPrototype } from "../stream.ts";
import { credentials, S3CredentialSource } from "./fixture.ts";

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
