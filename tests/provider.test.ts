import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { toBytes } from "@std/streams/to-bytes";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createAzureClient } from "../src/azure.ts";
import { createS3Client } from "../src/s3.ts";
import { streamBytes } from "./stream.ts";

/** Official Azurite development account used only by the local emulator. */
const AZURITE_ACCOUNT = "devstoreaccount1";
/** Official Azurite development key documented by the Azurite project. */
const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
/** Provider container/bucket created by the Docker fixture. */
const STORAGE_NAME = "opfs-test";
/** Exact S3 multipart minimum used to force multipart behavior with a small fixture. */
const S3_PART_SIZE = 5 * 1024 * 1024;

/** Returns a unique object-key prefix so failed test cleanup cannot collide with another run. */
function getPrefix(provider: string): string {
  return `integration/${provider}/${crypto.randomUUID()}`;
}

/** Creates the local SeaweedFS S3 client used by Docker-backed integration tests. */
function getS3Client() {
  return createS3Client({
    endpoint: "http://127.0.0.1:8333",
    bucket: STORAGE_NAME,
    region: "us-east-1",
    credentials: { accessKeyId: "admin", secretAccessKey: "secret" },
    partSize: S3_PART_SIZE,
    concurrency: 2,
  });
}

/** Creates the local Azurite client with Shared Key authentication. */
function getAzureClient() {
  return createAzureClient({
    endpoint: `http://127.0.0.1:10000/${AZURITE_ACCOUNT}`,
    container: STORAGE_NAME,
    credential: { kind: "shared-key", account: AZURITE_ACCOUNT, key: AZURITE_KEY },
    blockSize: 1024 * 1024,
    concurrency: 2,
  });
}

/** Ensures the Azurite container exists before blob operations begin. */
async function ensureAzureContainer(): Promise<void> {
  const client = getAzureClient();
  const response = await client.request({ method: "PUT", query: { restype: "container" } });
  if (response.ok || response.status === 409) return;
  throw new Error(`Azurite container setup failed with HTTP ${response.status}: ${await response.text()}`);
}

describe("Docker-backed object providers", () => {
  it("exercises S3 signing, ranges, conditions, multipart upload, copy, listing, and filesystem translation", async () => {
    const client = getS3Client();
    const prefix = getPrefix("s3");
    const basic = `${prefix}/basic.txt`;
    const large = `${prefix}/large.bin`;
    const copied = `${prefix}/copied.txt`;
    const facadeKey = `${prefix}/facade/state.txt`;

    try {
      const original = new TextEncoder().encode("0123456789");
      const written = await client.put(basic, original, { mediaType: "text/plain", ifNoneMatch: "*" });
      expect(written.size).toBe(original.byteLength);
      if (written.etag === undefined) throw new Error("S3 provider did not return an ETag for a completed object write.");
      expect((await client.head(basic))?.etag).toBe(written.etag);
      expect(new TextDecoder().decode(await toBytes(await client.get(basic, { at: 3, length: 4 })))).toBe("3456");
      await expect(client.put(basic, original, { ifNoneMatch: "*" })).rejects.toBeDefined();

      const first = new Uint8Array(S3_PART_SIZE);
      first.fill(7);
      const second = new Uint8Array(31);
      second.fill(9);
      await client.put(large, streamBytes([first, second]), { size: first.byteLength + second.byteLength });
      expect((await client.head(large))?.size).toBe(first.byteLength + second.byteLength);

      await client.copy!(basic, copied, { sourceIfMatch: written.etag });
      expect(new TextDecoder().decode(await toBytes(await client.get(copied)))).toBe("0123456789");
      const page = await client.list({ prefix: `${prefix}/`, delimiter: "/" });
      expect(page.objects.some((entry) => entry.key === basic)).toBe(true);

      await using fileSystem = createFileSystem(createObjectAdapter(client, { prefix }), { coordination: "none" });
      await fileSystem.writeFile("/facade/state.txt", "through facade", { parents: true });
      expect(await fileSystem.readText("/facade/state.txt")).toBe("through facade");
      expect((await client.head(facadeKey))?.size).toBe(14);
    } finally {
      for (const key of [basic, large, copied, facadeKey, `${prefix}/facade/`]) {
        await client.delete(key).catch(() => undefined);
      }
    }
  });

  it("exercises Azure Shared Key, ranges, conditions, block upload, copy, listing, and filesystem translation", async () => {
    await ensureAzureContainer();
    const client = getAzureClient();
    const prefix = getPrefix("azure");
    const basic = `${prefix}/basic.txt`;
    const large = `${prefix}/large.bin`;
    const copied = `${prefix}/copied.txt`;
    const facadeKey = `${prefix}/facade/state.txt`;

    try {
      const original = new TextEncoder().encode("0123456789");
      const written = await client.put(basic, original, { mediaType: "text/plain", ifNoneMatch: "*" });
      expect(written.size).toBe(original.byteLength);
      if (written.etag === undefined) throw new Error("Azure provider did not return an ETag for a completed blob write.");
      expect((await client.head(basic))?.etag).toBe(written.etag);
      expect(new TextDecoder().decode(await toBytes(await client.get(basic, { at: 3, length: 4 })))).toBe("3456");
      await expect(client.put(basic, original, { ifNoneMatch: "*" })).rejects.toBeDefined();

      const first = new Uint8Array(1024 * 1024);
      first.fill(3);
      const second = new Uint8Array(1024 * 1024 + 17);
      second.fill(4);
      await client.put(large, streamBytes([first, second]), { size: first.byteLength + second.byteLength });
      expect((await client.head(large))?.size).toBe(first.byteLength + second.byteLength);

      await client.copy!(basic, copied, { sourceIfMatch: written.etag });
      expect(new TextDecoder().decode(await toBytes(await client.get(copied)))).toBe("0123456789");
      const page = await client.list({ prefix: `${prefix}/`, delimiter: "/" });
      expect(page.objects.some((entry) => entry.key === basic)).toBe(true);

      await using fileSystem = createFileSystem(createObjectAdapter(client, { prefix }), { coordination: "none" });
      await fileSystem.writeFile("/facade/state.txt", "through facade", { parents: true });
      expect(await fileSystem.readText("/facade/state.txt")).toBe("through facade");
      expect((await client.head(facadeKey))?.size).toBe(14);
    } finally {
      for (const key of [basic, large, copied, facadeKey, `${prefix}/facade/`]) {
        await client.delete(key).catch(() => undefined);
      }
    }
  });
});
