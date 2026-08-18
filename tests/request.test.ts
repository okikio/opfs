import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { RequestMetrics, sendRequest } from "../src/request.ts";

/** Stable URL used by request-policy tests without opening a real network connection. */
const TEST_URL = new URL("https://storage.example/object");

describe("request policy", () => {
  it("supports a zero-delay retry policy without violating @std/async validation", async () => {
    let fetches = 0;
    const metrics = new RequestMetrics();
    const response = await sendRequest(
      async () => ({ input: TEST_URL }),
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: fetches === 1 ? 503 : 200 });
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      },
    );

    expect(response.status).toBe(200);
    expect(fetches).toBe(2);
    expect(metrics.snapshot()).toMatchObject({ requests: 2, retries: 1, failures: 0, responses: 2 });
  });

  it("bypasses the retry engine for an explicitly single-attempt request", async () => {
    let fetches = 0;
    const response = await sendRequest(
      async () => ({ input: TEST_URL }),
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 503 });
        },
        policy: { retries: 5, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        replayable: false,
      },
    );

    expect(response.status).toBe(503);
    expect(fetches).toBe(1);
  });

  it("does not count or retry deterministic request preparation failures", async () => {
    const metrics = new RequestMetrics();
    let fetches = 0;
    let preparations = 0;

    await expect(sendRequest(
      async () => {
        preparations += 1;
        throw new TypeError("invalid signing input");
      },
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 200 });
        },
        policy: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      },
    )).rejects.toThrow("invalid signing input");

    expect(preparations).toBe(1);
    expect(fetches).toBe(0);
    expect(metrics.snapshot()).toMatchObject({ requests: 0, retries: 0, failures: 1, responses: 0 });
  });

  it("retries a transport failure and returns the next response", async () => {
    const metrics = new RequestMetrics();
    let fetches = 0;

    const response = await sendRequest(
      async () => ({ input: TEST_URL }),
      {
        fetch: async () => {
          fetches += 1;
          if (fetches === 1) throw new TypeError("temporary network failure");
          return new Response(null, { status: 200 });
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
        metrics,
      },
    );

    expect(response.status).toBe(200);
    expect(fetches).toBe(2);
    expect(metrics.snapshot()).toMatchObject({ requests: 2, retries: 1, failures: 0, responses: 1 });
  });

  it("retries an attempt timeout during preparation without inventing an HTTP retry", async () => {
    const metrics = new RequestMetrics();
    let preparations = 0;
    let fetches = 0;

    const response = await sendRequest(
      async (signal) => {
        preparations += 1;
        if (preparations === 1) {
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return { input: TEST_URL };
      },
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 200 });
        },
        policy: { retries: 1, minDelayMs: 0, maxDelayMs: 0, jitter: 0, timeoutMs: 5 },
        metrics,
      },
    );

    expect(response.status).toBe(200);
    expect(preparations).toBe(2);
    expect(fetches).toBe(1);
    expect(metrics.snapshot()).toMatchObject({ requests: 1, retries: 0, failures: 0, responses: 1 });
  });

  it("treats caller cancellation as authoritative and does not retry it", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller stopped request", "AbortError"));
    let preparations = 0;
    let fetches = 0;

    await expect(sendRequest(
      async () => {
        preparations += 1;
        return { input: TEST_URL };
      },
      {
        fetch: async () => {
          fetches += 1;
          return new Response(null, { status: 200 });
        },
        signal: controller.signal,
        policy: { retries: 4, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      },
    )).rejects.toMatchObject({ name: "AbortError" });

    expect(preparations).toBe(0);
    expect(fetches).toBe(0);
  });
});
