/** Azure: Request policy preserves replay, credential refresh and native stream ownership. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createAzureClient } from "../../src/backend/azure/client.ts";
import { changeStreamPrototype } from "../stream.ts";

describe("Azure request policy", () => {
  it("retries replayable 503 responses and rebuilds authorization per attempt", async () => {
    let attempts = 0;
    let authCalls = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: {
        kind: "headers",
        get: () => ({ authorization: `test-${++authCalls}` }),
      },
      request: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async (_input, init) => {
        attempts += 1;
        expect(init?.redirect).toBe("manual");
        return new Response(null, { status: attempts === 1 ? 503 : 200 });
      },
    });

    const response = await client.request({ method: "PUT", key: "retry.bin", body: new Uint8Array([1]) });

    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(authCalls).toBe(2);
    expect(client.getMetrics().retries).toBe(1);
  });

  it("retries a replayable Fetch transport failure and returns the next response", async () => {
    let attempts = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: { kind: "sas", token: "sv=test&sig=test" },
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

  it("does not retry deterministic authorization failures", async () => {
    let authCalls = 0;
    let fetches = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: {
        kind: "headers",
        get: () => {
          authCalls += 1;
          throw new TypeError("invalid authorization input");
        },
      },
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 200 });
      },
    });

    await expect(client.request({ method: "GET", key: "key" })).rejects.toThrow("invalid authorization input");
    expect(authCalls).toBe(1);
    expect(fetches).toBe(0);
  });

  it("lets a low-level caller disable retry for a replayable request", async () => {
    let attempts = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: { kind: "sas", token: "sv=test&sig=test" },
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

  it("does not retry a one-shot streamed request body", async () => {
    let attempts = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "container",
      credential: { kind: "sas", token: "sv=test&sig=test" },
      request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      fetch: async () => {
        attempts += 1;
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

  for (const length of [false, true]) {
    it(`applies one-shot duplex and Shared Key length admission to a native stream across supported prototype changes with length ${length}`, async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      const prototype: object = runInNewContext("({})");
      const detached = changeStreamPrototype(body, prototype);
      expect(body instanceof ReadableStream).toBe(!detached);
      let attempts = 0;
      const client = createAzureClient({
        endpoint: "https://account.blob.core.windows.net",
        container: "container",
        credential: { kind: "shared-key", account: "account", key: btoa("authored key") },
        request: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        fetch: async (input, init) => {
          attempts++;
          expect(Reflect.get(init!, "duplex")).toBe("half");
          expect(new Headers(init?.headers).get("content-length")).toBe("0");
          expect([...new Uint8Array(await new Request(input, init).arrayBuffer())]).toEqual([]);
          return new Response(null, { status: 503 });
        },
      });
      const pending = client.request({
        method: "PUT",
        key: "stream.bin",
        body,
        ...(length ? { headers: { "content-length": "0" } } : {}),
      });
      if (length) {
        expect((await pending).status).toBe(503);
        expect(attempts).toBe(1);
      } else {
        await expect(pending).rejects.toBeInstanceOf(TypeError);
        expect(attempts).toBe(0);
        expect(body.locked).toBe(false);
      }
      // A dispatched request transfers its body to native Fetch. The client's
      // length refusal, in contrast, must not acquire the caller's stream.
    });
  }
});
