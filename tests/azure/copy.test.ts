/** Azure: Server-side copies preserve source authorization, range conditions and failure evidence. */
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { AzureError, createAzureClient } from "../../src/backend/azure/client.ts";

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
          return new Response(null, { status: 200, headers: { "content-length": "4", etag: '"etag"' } });
        }
        return new Response(null, { status: 202, headers: { "x-ms-copy-status": "success" } });
      },
    });

    await client.copy!("source.txt", "copy.txt");

    const copy = requests.find((request) => request.method === "PUT");
    expect(copy?.headers.get("x-ms-copy-source")).toContain("/data/source.txt?");
    expect(copy?.headers.get("x-ms-copy-source")).toContain("sig=secret");
    expect(new URL(copy!.headers.get("x-ms-copy-source")!).searchParams.get("api-version")).toBe("2026-04-06");
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
          return new Response(null, {
            status: 200,
            headers: { "content-length": String(size), etag: '"source-etag"' },
          });
        }
        if (request.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-length": String(size), etag: '"copy-etag"' } });
        }
        return new Response(null, { status: 201 });
      },
    });

    await client.copy!("source.bin", "copy.bin", { sourceIfMatch: '"source-etag"' });

    const blocks = requests.filter((request) => new URL(request.url).searchParams.get("comp") === "block").sort(
      (left, right) =>
        Number(left.headers.get("x-ms-source-range")?.match(/^bytes=(\d+)/)?.[1]) -
        Number(right.headers.get("x-ms-source-range")?.match(/^bytes=(\d+)/)?.[1]),
    );
    expect(blocks).toHaveLength(3);
    const blockBytes = 100 * 1024 * 1024;
    for (const [index, block] of blocks.entries()) {
      expect(block.headers.get("x-ms-source-range")).toBe(
        `bytes=${index * blockBytes}-${Math.min(size, (index + 1) * blockBytes) - 1}`,
      );
      expect(block.headers.get("x-ms-copy-source-authorization")).toBe("Bearer token");
      expect(block.headers.get("x-ms-source-if-match")).toBe('"source-etag"');
    }
    expect(requests.some((request) => new URL(request.url).searchParams.get("comp") === "blocklist")).toBe(true);
  });

  it("rejects direct server-side copy before provider I/O when the service version predates the API", async () => {
    let fetches = 0;
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "sas", token: "?sig=secret" },
      version: "2017-11-09",
      fetch: async () => {
        fetches += 1;
        return new Response(null, { status: 500 });
      },
    });

    await expect(client.copy!("source.bin", "copy.bin")).rejects.toMatchObject({ name: "AzureError", status: 400 });
    expect(fetches).toBe(0);
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
          return new Response(null, { status: 200, headers: { "content-length": "4", etag: '"source"' } });
        }
        return new Response(null, { status: 201 });
      },
    });

    await expect(client.copy!("source.bin", "copy.bin")).rejects.toBeInstanceOf(AzureError);
  });

  it("does not advertise server-side copy for caller-defined authorization headers", () => {
    const client = createAzureClient({
      endpoint: "https://account.blob.core.windows.net",
      container: "data",
      credential: { kind: "headers", get: () => ({ authorization: "Provider token" }) },
    });

    expect(client.capabilities.copy).toBe(false);
  });
});
