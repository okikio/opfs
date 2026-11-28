/** Azure: Response acknowledgement and retirement retain their own authority and failures. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AZURE_LIMITS, AzureError, createAzureClient } from "../../src/backend/azure/client.ts";
import { streamBytes } from "../stream.ts";
import { rejectedResponse } from "./fixture.ts";

describe("Azure internal response ownership", () => {
  const options = {
    endpoint: "https://account.example.test",
    container: "owned",
    credential: { kind: "sas" as const, token: "sig=authored" },
  };

  it("retires missing DELETE and successful/missing internally owned metadata responses", async () => {
    let requests = 0;
    let cancellations = 0;
    const client = createAzureClient({
      ...options,
      fetch: async () => {
        requests++;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellations++;
            },
          }, { highWaterMark: 0 }),
          {
            status: requests <= 2 ? 404 : 200,
            headers: { "content-length": "3", etag: "own" },
          },
        );
      },
    });
    await client.delete("missing");
    expect(await client.head("missing")).toBeNull();
    expect(await client.head("present")).toMatchObject({ size: 3, etag: "own" });
    expect(cancellations).toBe(3);
  });

  it("retires each accepted streamed block and the final block-list acknowledgement", async () => {
    let cancellations = 0;
    const routes: string[] = [];
    const client = createAzureClient({
      ...options,
      blockSize: 2,
      concurrency: 1,
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        routes.push(url.searchParams.get("comp") ?? "bytes");
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellations++;
            },
          }, { highWaterMark: 0 }),
          {
            status: 201,
            headers: { etag: "actual-commit" },
          },
        );
      },
    });
    expect(await client.put("value", streamBytes([new Uint8Array([17, 31, 47])]))).toMatchObject({
      size: 3,
      etag: "actual-commit",
    });
    expect(routes).toEqual(["block", "block", "blocklist"]);
    expect(cancellations).toBe(3);
  });

  it("retires accepted URL-copy blocks and their final commit without reading source bytes", async () => {
    const sourceSize = AZURE_LIMITS.copyBlobBytes + 1;
    let cancellations = 0;
    const routes: string[] = [];
    const client = createAzureClient({
      ...options,
      blockSize: AZURE_LIMITS.copyBlobBytes,
      concurrency: 1,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (init?.method === "HEAD") {
          return new Response(null, { headers: { "content-length": String(sourceSize), etag: "pinned-source" } });
        }
        routes.push(url.searchParams.get("comp") ?? "copy");
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellations++;
            },
          }, { highWaterMark: 0 }),
          {
            status: 201,
            headers: { etag: "actual-copy" },
          },
        );
      },
    });
    expect(await client.copy("source", "destination")).toMatchObject({ size: sourceSize, etag: "actual-copy" });
    expect(routes).toEqual(["block", "block", "blocklist"]);
    expect(cancellations).toBe(3);
  });

  it("a valid synchronous copy acknowledgement followed by disposal failure is not replayed or uncertain", async () => {
    const disposal = new Error("Acknowledged copy disposal failed.");
    let publications = 0;
    const client = createAzureClient({
      ...options,
      request: { retries: 3 },
      fetch: async (_input, init) => {
        if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "3", etag: "source" } });
        publications++;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw disposal;
            },
          }),
          {
            status: 201,
            headers: { "x-ms-copy-status": "success", etag: "copy" },
          },
        );
      },
    });
    expect(await rejectedResponse(client.copy("source", "destination"))).toBe(disposal);
    expect(publications).toBe(1);
  });

  it("preserves uncertain copy acknowledgement and independent body disposal failure", async () => {
    const disposal = new Error("Uncertain copy disposal failed.");
    let publications = 0;
    const client = createAzureClient({
      ...options,
      fetch: async (_input, init) => {
        if (init?.method === "HEAD") return new Response(null, { headers: { "content-length": "3", etag: "source" } });
        publications++;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw disposal;
            },
          }),
          { status: 201 },
        );
      },
    });
    const observed = await rejectedResponse(client.copy("source", "destination"));
    if (!(observed instanceof AggregateError)) throw new Error("Expected independent response failures.");
    expect(observed.errors[0]).toMatchObject({ effect: "unknown", key: "destination" });
    expect(observed.errors[1]).toBe(disposal);
    expect(observed.cause).toBe(observed.errors[0]);
    expect(publications).toBe(1);
  });

  it("an acknowledged Put Blob disposal fault remains its exact fault without a replay", async () => {
    const disposal = new Error("Acknowledged blob disposal failed.");
    let publications = 0;
    const client = createAzureClient({
      ...options,
      request: { retries: 3 },
      fetch: async () => {
        publications++;
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              throw disposal;
            },
          }),
          {
            status: 201,
            headers: { etag: "acknowledged" },
          },
        );
      },
    });
    expect(await rejectedResponse(client.put("value", new Uint8Array([17])))).toBe(disposal);
    expect(publications).toBe(1);
  });

  it("leaves raw requests and successful object body streams with the caller", async () => {
    let cancellations = 0;
    const client = createAzureClient({
      ...options,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellations++;
            },
          }, { highWaterMark: 0 }),
        ),
    });
    const response = await client.request({ method: "GET" });
    const stream = await client.get("value");
    expect(cancellations).toBe(0);
    await response.body?.cancel();
    await stream.cancel();
    expect(cancellations).toBe(2);
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
      const client = createAzureClient({
        ...options,
        fetch: async () =>
          new Response(body, {
            status: 403,
            headers: { "x-ms-error-code": "AuthoredDenied", "x-ms-request-id": "authored-mid-read" },
          }),
      });
      const observed = await rejectedResponse(client.put("value", new Uint8Array([17])));
      if (!(observed instanceof AzureError)) throw new Error("Expected the actual HTTP provider error.");
      expect(observed.status).toBe(403);
      expect(observed.code).toBe("AuthoredDenied");
      expect(observed.requestId).toBe("authored-mid-read");
      expect(Object.hasOwn(observed, "cause")).toBe(true);
      expect(observed.cause).toBe(reason);
      expect(body.locked).toBe(false);
      expect(cancellations).toBe(0);
    });

    it(`keeps HTTP status/code/request identity and secondary body-read failure (${String(reason)})`, async () => {
      const client = createAzureClient({
        ...options,
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(reason);
              },
            }),
            { status: 403, headers: { "x-ms-error-code": "AuthoredDenied", "x-ms-request-id": "authored" } },
          ),
      });
      const observed = await rejectedResponse(client.put("value", new Uint8Array([17])));
      if (!(observed instanceof AzureError)) throw new Error("Expected the actual HTTP provider error.");
      expect(observed.status).toBe(403);
      expect(observed.code).toBe("AuthoredDenied");
      expect(observed.requestId).toBe("authored");
      expect(Object.hasOwn(observed, "cause")).toBe(true);
      expect(observed.cause).toBe(reason);
    });
  }

  it("keeps malformed proxy XML secondary while preserving header error authority", async () => {
    const client = createAzureClient({
      ...options,
      fetch: async () =>
        new Response("<Error><broken", {
          status: 403,
          headers: { "x-ms-error-code": "AuthoredDenied", "x-ms-request-id": "authored" },
        }),
    });
    const observed = await rejectedResponse(client.put("value", new Uint8Array([17])));
    if (!(observed instanceof AzureError)) throw new Error("Expected the actual HTTP provider error.");
    expect(observed.status).toBe(403);
    expect(observed.code).toBe("AuthoredDenied");
    expect(observed.requestId).toBe("authored");
    expect(observed.cause).toBeInstanceOf(Error);
  });
});
