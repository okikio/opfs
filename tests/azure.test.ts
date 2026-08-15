import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { AZURE_LIMITS, AzureError, createAzureClient } from "../src/azure.ts";
import { RequestCapture } from "./http.ts";
import { streamBytes } from "./stream.ts";

/** Creates one Azure-style XML response without coupling tests to an HTTP server. */
function xml(value: string, init: ResponseInit = {}): Response {
  return new Response(value, { status: 200, headers: { "content-type": "application/xml", ...(init.headers ?? {}) }, ...init });
}

/** Refreshable bearer source used to prove per-request token resolution. */
class BearerTokenSource {
  /** Number of token requests observed. */
  calls = 0;

  /** Returns one token value that identifies its refresh call. */
  get(): string {
    this.calls += 1;
    return `token-${this.calls}`;
  }
}

describe("Azure Blob client", () => {
  it("keeps SAS authorization on the source URL during provider-side copy", async () => {
    const requests: Request[] = [];
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sv=2026-04-06&sig=secret" },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "4", etag: "\"etag\"" } });
        }
        return new Response(null, { status: 202, headers: { "x-ms-copy-status": "success" } });
      },
    });

    await client.copy!("source.txt", "copy.txt");

    const copy = requests.find((request) => request.method === "PUT");
    expect(copy?.headers.get("x-ms-copy-source")).toContain("/data/source.txt?");
    expect(copy?.headers.get("x-ms-copy-source")).toContain("sig=secret");
    expect(copy?.headers.get("x-ms-requires-sync")).toBe("true");
  });

  it("uses Put Block From URL for blobs above the 256 MiB synchronous copy limit", async () => {
    const requests: Request[] = [];
    const size = 256 * 1024 * 1024 + 1;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "bearer", token: "token" },
      blockSize: 100 * 1024 * 1024,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method === "HEAD" && url.pathname.endsWith("/source.bin")) {
          return new Response(null, { status: 200, headers: { "content-length": String(size), etag: "\"source-etag\"" } });
        }
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": String(size), etag: "\"copy-etag\"" } });
        }
        return new Response(null, { status: 201 });
      },
    });

    await client.copy!("source.bin", "copy.bin", { sourceIfMatch: "\"source-etag\"" });

    const blocks = requests.filter((request) => new URL(request.url).searchParams.get("comp") === "block");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]?.headers.get("x-ms-source-range")).toBe(`bytes=0-${100 * 1024 * 1024 - 1}`);
    expect(blocks[0]?.headers.get("x-ms-copy-source-authorization")).toBe("Bearer token");
    expect(blocks[0]?.headers.get("x-ms-source-if-match")).toBe("\"source-etag\"");
    expect(requests.some((request) => new URL(request.url).searchParams.get("comp") === "blocklist")).toBe(true);
  });

  it("rejects direct server-side copy when the selected service version predates the API", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      version: "2017-11-09",
      fetch: async () => new Response(null, { status: 500 }),
    });

    await expect(client.copy!("source.bin", "copy.bin")).rejects.toBeInstanceOf(AzureError);
  });

  it("parses Azure list responses with prefixes and continuation markers", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () => xml(`
        <EnumerationResults>
          <Blobs>
            <Blob><Name>root/a.txt</Name><Properties><Content-Length>4</Content-Length><Content-Type>text/plain</Content-Type><Etag>&quot;e&quot;</Etag></Properties></Blob>
            <BlobPrefix><Name>root/nested/</Name></BlobPrefix>
          </Blobs>
          <NextMarker>next</NextMarker>
        </EnumerationResults>`),
    });

    const page = await client.list({ prefix: "root/", delimiter: "/" });
    expect(page.objects[0]?.key).toBe("root/a.txt");
    expect(page.objects[0]?.mediaType).toBe("text/plain");
    expect(page.prefixes).toEqual(["root/nested/"]);
    expect(page.cursor).toBe("next");
  });

  it("retains Azure request IDs and service codes on failures", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () => xml("<Error><Code>AuthorizationFailure</Code><Message>denied</Message></Error>", {
        status: 403,
        headers: { "x-ms-request-id": "request-1" },
      }),
    });

    try {
      await client.get("private.txt");
      throw new Error("expected Azure failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AzureError);
      if (error instanceof AzureError) {
        expect(error.code).toBe("AuthorizationFailure");
        expect(error.requestId).toBe("request-1");
      }
    }
  });
  it("creates the documented Azurite Shared Key canonical signature", async () => {
    let request: Request | undefined;
    const client = createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential: {
        kind: "shared-key",
        account: "devstoreaccount1",
        key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
      },
      now: () => new Date("2026-08-14T12:00:00.000Z"),
      fetch: async (input, init) => {
        request = new Request(input, init);
        return new Response(null, { status: 201 });
      },
    });

    await client.request({ method: "PUT", query: { restype: "container" } });

    expect(request?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:h5gDRN/kZdrsO5FfUgKPNZGwb9UgFzqZvIDC5iVFi94=",
    );
    expect(request?.headers.get("x-ms-date")).toBe("Fri, 14 Aug 2026 12:00:00 GMT");
    expect(request?.headers.get("content-length")).toBe("0");
  });


  it("rejects Shared Key service versions older than the implemented signing format", () => {
    expect(() => createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential: {
        kind: "shared-key",
        account: "devstoreaccount1",
        key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
      },
      version: "2009-07-17",
    })).toThrow(RangeError);
  });

  it("signs zero Content-Length according to the selected Shared Key service version", async () => {
    const oldCapture = new RequestCapture();
    const modernCapture = new RequestCapture();
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const options = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    await createAzureClient({ ...options, version: "2014-02-14", fetch: oldCapture.fetch.bind(oldCapture) }).request({
      method: "PUT",
      key: "zero.bin",
      body: new Uint8Array(),
    });
    await createAzureClient({ ...options, version: "2015-02-21", fetch: modernCapture.fetch.bind(modernCapture) }).request({
      method: "PUT",
      key: "zero.bin",
      body: new Uint8Array(),
    });

    expect(oldCapture.latest?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:l0m1mkwouin+1Fe6pBOf3LgSCgsrZMzD4luPiqfRonQ=",
    );
    expect(modernCapture.latest?.headers.get("authorization")).toBe(
      "SharedKey devstoreaccount1:JHL00B0fQHliBPS7Gz7O2DcsyB3DwEnHjFUUxfTKvIY=",
    );
  });

  it("omits empty x-ms headers before 2016-05-31 and signs them from that version onward", async () => {
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const base = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    const legacyEmpty = new RequestCapture();
    const legacyAbsent = new RequestCapture();
    await createAzureClient({ ...base, version: "2015-02-21", fetch: legacyEmpty.fetch.bind(legacyEmpty) }).request({
      method: "HEAD",
      key: "value",
      headers: { "x-ms-meta-empty": "" },
    });
    await createAzureClient({ ...base, version: "2015-02-21", fetch: legacyAbsent.fetch.bind(legacyAbsent) }).request({
      method: "HEAD",
      key: "value",
    });

    const modernEmpty = new RequestCapture();
    const modernAbsent = new RequestCapture();
    await createAzureClient({ ...base, version: "2016-05-31", fetch: modernEmpty.fetch.bind(modernEmpty) }).request({
      method: "HEAD",
      key: "value",
      headers: { "x-ms-meta-empty": "" },
    });
    await createAzureClient({ ...base, version: "2016-05-31", fetch: modernAbsent.fetch.bind(modernAbsent) }).request({
      method: "HEAD",
      key: "value",
    });

    expect(legacyEmpty.latest?.headers.get("authorization")).toBe(legacyAbsent.latest?.headers.get("authorization"));
    expect(modernEmpty.latest?.headers.get("authorization")).not.toBe(modernAbsent.latest?.headers.get("authorization"));
  });

  it("validates block size against the selected Azure REST service version", () => {
    expect(() => createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      version: "2015-04-05",
      blockSize: AZURE_LIMITS.legacyBlockBytes + 1,
    })).toThrow(RangeError);
  });

  it("keeps destination conditions off Put Block and applies them at Put Block List", async () => {
    const requests: Request[] = [];
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      blockSize: 4,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "6", etag: "\"done\"" } });
        }
        return new Response(null, { status: 201 });
      },
    });

    const body = streamBytes([new Uint8Array([1, 2, 3, 4, 5, 6])]);
    await client.put("stream.bin", body, { ifNoneMatch: "*", size: 6 });

    const blocks = requests.filter((request) => new URL(request.url).searchParams.get("comp") === "block");
    const commit = requests.find((request) => new URL(request.url).searchParams.get("comp") === "blocklist");
    expect(blocks.every((request) => !request.headers.has("if-none-match"))).toBe(true);
    expect(commit?.headers.get("if-none-match")).toBe("*");
  });

  it("rejects source bearer copy authorization before service version 2020-10-02", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "bearer", token: "token" },
      version: "2019-12-12",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": "4", etag: "\"source\"" } });
        }
        return new Response(null, { status: 201 });
      },
    });

    await expect(client.copy!("source.bin", "copy.bin")).rejects.toBeInstanceOf(AzureError);
  });

  it("canonicalizes Shared Key query fields independently from insertion order", async () => {
    const first = new RequestCapture();
    const second = new RequestCapture();
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const base = {
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    };

    await createAzureClient({ ...base, fetch: first.fetch.bind(first) }).request({
      method: "GET",
      query: { restype: "container", comp: "list", prefix: "root/" },
    });
    await createAzureClient({ ...base, fetch: second.fetch.bind(second) }).request({
      method: "GET",
      query: { prefix: "root/", comp: "list", restype: "container" },
    });

    expect(first.latest?.headers.get("authorization")).toBe(second.latest?.headers.get("authorization"));
  });


  it("collapses unquoted Shared Key whitespace without changing quoted-string whitespace", async () => {
    const now = () => new Date("2026-08-14T12:00:00.000Z");
    const credential = {
      kind: "shared-key" as const,
      account: "devstoreaccount1",
      key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    };
    const compact = new RequestCapture();
    const spaced = new RequestCapture();
    const quoted = new RequestCapture();

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: compact.fetch.bind(compact),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha beta "two spaces"' } });

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: spaced.fetch.bind(spaced),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha   beta "two spaces"' } });

    await createAzureClient({
      endpoint: "http://127.0.0.1:10000/devstoreaccount1",
      container: "opfs-test",
      credential,
      now,
      fetch: quoted.fetch.bind(quoted),
    }).request({ method: "HEAD", key: "value", headers: { "x-ms-meta-note": 'alpha beta "two  spaces"' } });

    expect(compact.latest?.headers.get("authorization")).toBe(spaced.latest?.headers.get("authorization"));
    expect(compact.latest?.headers.get("authorization")).not.toBe(quoted.latest?.headers.get("authorization"));
  });

  it("keeps HTTP evidence when a proxy returns a malformed non-Azure failure body", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () => new Response("upstream gateway failed", {
        status: 502,
        headers: { "x-ms-request-id": "gateway-request" },
      }),
    });

    try {
      await client.get("state.bin");
      throw new Error("expected gateway failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AzureError);
      if (error instanceof AzureError) {
        expect(error.status).toBe(502);
        expect(error.requestId).toBe("gateway-request");
        expect(error.code).toBeUndefined();
        expect(error.message).toContain("HTTP 502");
      }
    }
  });

  it("uses SAS query authorization without adding an Authorization header", async () => {
    const capture = new RequestCapture();
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sv=2026-04-06&sig=secret" },
      fetch: capture.fetch.bind(capture),
    });

    await client.request({ method: "HEAD", key: "state.bin" });

    expect(capture.latest?.headers.has("authorization")).toBe(false);
    expect(new URL(capture.latest!.url).searchParams.get("sig")).toBe("secret");
  });

  it("resolves a bearer token immediately before every request", async () => {
    const token = new BearerTokenSource();
    const capture = new RequestCapture();
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "bearer", token: token.get.bind(token) },
      fetch: capture.fetch.bind(capture),
    });

    await client.request({ method: "HEAD", key: "one" });
    await client.request({ method: "HEAD", key: "two" });

    expect(token.calls).toBe(2);
    expect(capture.requests[0]?.headers.get("authorization")).toBe("Bearer token-1");
    expect(capture.requests[1]?.headers.get("authorization")).toBe("Bearer token-2");
  });

  it("does not advertise server-side copy for caller-defined authorization headers", () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "headers", get: () => ({ authorization: "Provider token" }) },
    });

    expect(client.capabilities.copy).toBe(false);
  });

  it("expands a known streamed block size to stay within 50,000 committed blocks", async () => {
    const requests: Request[] = [];
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      blockSize: 1,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return new Response(null, { status: 201 });
      },
    });

    await expect(client.put(
      "planned.bin",
      streamBytes([new Uint8Array([1, 2, 3, 4])]),
      { size: AZURE_LIMITS.maxCommittedBlocks + 1 },
    )).rejects.toThrow(RangeError);

    const blocks = requests.filter((request) => new URL(request.url).searchParams.get("comp") === "block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.headers.get("content-length")).toBe("2");
    expect(blocks[1]?.headers.get("content-length")).toBe("2");
    expect(requests.some((request) => new URL(request.url).searchParams.get("comp") === "blocklist")).toBe(false);
  });

  it("rejects a declared blob larger than the selected service-version block plan before Fetch", async () => {
    let fetches = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
    });
    const max = AZURE_LIMITS.currentBlockBytes * AZURE_LIMITS.maxCommittedBlocks;

    await expect(client.put(
      "too-large.bin",
      streamBytes([new Uint8Array([1])]),
      { size: max + 1 },
    )).rejects.toThrow(RangeError);
    expect(fetches).toBe(0);
  });

});

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
});
