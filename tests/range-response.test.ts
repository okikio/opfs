import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { createS3Client } from "../src/s3.ts";
import { createAzureClient } from "../src/azure.ts";
import { createGcsClient } from "../src/gcs.ts";

/** Provider fixtures keep authorization local and never contact a real account. */
function client(provider: "s3" | "azure", fetch: typeof globalThis.fetch, endpoint?: string, namespace = "fixture") {
  return provider === "s3"
    ? createS3Client({
      endpoint: endpoint ?? "https://s3.example.test",
      bucket: namespace,
      region: "us-east-1",
      credentials: { accessKeyId: "fixture", secretAccessKey: "fixture" },
      fetch,
    })
    : createAzureClient({
      endpoint: endpoint ?? "https://blob.example.test",
      container: namespace,
      credential: { kind: "sas", token: "sig=fixture" },
      fetch,
    });
}

describe("native object response admission", () => {
  for (const provider of ["s3", "azure"] as const) {
    for (
      const [name, status, headers] of [
        ["ignored range", 200, {}],
        ["missing range", 206, {}],
        ["wrong offset", 206, { "content-range": "bytes 0-1/4" }],
        ["short interior extent", 206, { "content-range": "bytes 1-1/4" }],
        ["unknown total", 206, { "content-range": "bytes 1-2/*" }],
        ["unsafe total", 206, { "content-range": "bytes 1-2/9007199254740992" }],
        ["wrong length", 206, { "content-range": "bytes 1-2/4", "content-length": "3" }],
        ["encoded extent", 206, { "content-range": "bytes 1-2/4", "content-encoding": "gzip" }],
      ] as const
    ) {
      it(`${provider} rejects ${name} and retires its body`, async () => {
        let cancelled = 0;
        const source = new ReadableStream<Uint8Array>({
          cancel() {
            cancelled++;
          },
        });
        const native = client(provider, () => Promise.resolve(new Response(source, { status, headers })));
        await expect(native.get("one", { at: 1, length: 2 })).rejects.toThrow(TypeError);
        expect(cancelled).toBe(1);
      });
    }
    it(`${provider} preserves rejection and body retirement failures`, async () => {
      const cleanup = new Error("retirement failed");
      const native = client(provider, () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              cancel() {
                throw cleanup;
              },
            }),
          ),
        ));
      await expect(native.get("one", { at: 1, length: 2 })).rejects.toMatchObject({
        errors: [expect.any(TypeError), cleanup],
      });
    });
    it(`${provider} admits an EOF-clamped extent and captures options before I/O`, async () => {
      const options = { at: 1, length: 8 };
      const native = client(provider, () => {
        options.at = 9;
        options.length = 1;
        return Promise.resolve(
          new Response(new Uint8Array([2, 3]), {
            status: 206,
            headers: { "content-range": "bytes 1-2/3", "content-length": "2" },
          }),
        );
      });
      const body = await native.get("one", options);
      expect(new Uint8Array(await new Response(body).arrayBuffer())).toEqual(new Uint8Array([2, 3]));
    });
    it(`${provider} refuses encoded complete objects`, async () => {
      const native = client(provider, () =>
        Promise.resolve(
          new Response(null, {
            headers: { "content-encoding": "gzip" },
          }),
        ));
      await expect(native.get("one")).rejects.toThrow(TypeError);
    });
    it(`${provider} separates endpoint and namespace identities without exposing credentials`, () => {
      const fetch = () => Promise.reject(new Error("No I/O expected"));
      const first = client(provider, fetch, "https://user:password@example.test/root?sig=secret#fragment");
      expect(first.identity).toBe(JSON.stringify([provider, "https://example.test", "/root", "fixture"]));
      expect(first.identity).not.toBe(client(provider, fetch, "https://elsewhere.test/root").identity);
      expect(first.identity).not.toBe(client(provider, fetch, undefined, "other").identity);
    });
  }
  it("gcs exposes its bucket namespace without acquiring credentials", () => {
    const first = createGcsClient({ bucket: "one" });
    expect(first.identity).toBe(JSON.stringify(["gcs", "https://storage.googleapis.com", "/", "one"]));
    expect(first.identity).not.toBe(createGcsClient({ bucket: "two" }).identity);
  });
});
