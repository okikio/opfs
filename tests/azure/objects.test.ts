/** Azure: Object metadata and borrowed client ownership remain explicit through wire operations. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AzureError, createAzureClient } from "../../src/backend/azure/client.ts";
import { createAzureDriver } from "../../src/backend/azure/driver.ts";
import { streamBytes } from "../stream.ts";
import { xml } from "./fixture.ts";

describe("Azure Blob client", () => {
  it("reports direct clients as owned and injected clients as borrowed", () => {
    const options = {
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas" as const, token: "?sig=secret" },
      fetch: async () => new Response(null, { status: 200 }),
    };
    const client = createAzureClient(options);

    // The driver always borrows: the caller made the client and keeps it.
    expect(createAzureDriver(client).inspect().ownership).toBe("borrowed");
  });

  it("rejects invalid Azure metadata before provider I/O", async () => {
    let requests = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () => {
        requests += 1;
        return new Response(null, { status: 201 });
      },
    });

    for (
      const metadata of [
        { "bad-key": "value" },
        { valid_key: "caf\u00e9" },
        { Duplicate: "first", duplicate: "second" },
      ]
    ) {
      try {
        await client.put("metadata.bin", new Uint8Array([1]), { metadata });
        throw new Error("expected Azure metadata validation failure");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
      }
    }

    expect(requests).toBe(0);
  });

  it("exposes behavior-changing Azure optimizations as independent switches", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      blockUpload: false,
      serverCopy: false,
      fetch: async () => new Response(null, { status: 500 }),
    });

    expect(client.optimizations).toEqual({ blockUpload: false, serverCopy: false });
    expect(client.capabilities.streamWrite).toBe(false);
    expect(client.capabilities.copy).toBe(false);

    await expect(client.put("stream.bin", streamBytes([new Uint8Array([1])]))).rejects.toThrow(TypeError);
    await expect(client.copy!("source.bin", "copy.bin")).rejects.toThrow(TypeError);
  });

  it("parses Azure list responses with prefixes and continuation markers", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () =>
        xml(`
        <EnumerationResults>
          <Blobs>
            <Blob>
              <Name>root/a.txt</Name>
              <Properties>
                <Content-Length>4</Content-Length>
                <Content-Type>text/plain</Content-Type>
                <Etag>&quot;e&quot;</Etag>
              </Properties>
            </Blob>
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
      fetch: async () =>
        xml("<Error><Code>AuthorizationFailure</Code><Message>denied</Message></Error>", {
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

  it("keeps HTTP evidence when a proxy returns a malformed non-Azure failure body", async () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      fetch: async () =>
        new Response("upstream gateway failed", {
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
});
