import { after, before, describe, it } from "node:test";
import { expect } from "@std/expect";
import { toBytes } from "@std/streams/to-bytes";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createAzureClient } from "../src/azure.ts";
import { createS3Client } from "../src/s3.ts";
import {
  AZURE_ACCOUNT,
  AZURE_KEY,
  openProviders,
  type ProviderFixture,
  S3_ACCESS_KEY,
  S3_SECRET_KEY,
  STORAGE_NAME,
} from "./provider/fixture.ts";
import { streamBytes } from "./stream.ts";

/** Exact S3 multipart minimum used to force multipart behavior with a small fixture. */
const S3_PART_SIZE = 5 * 1024 * 1024;
/** Provider resources are shared across the suite so container startup is not repeated per assertion. */
let providers: ProviderFixture | undefined;

/** Returns the active provider fixture or fails if suite setup did not complete. */
function getProviders(): ProviderFixture {
  if (providers === undefined) throw new Error("Provider fixture is not open.");
  return providers;
}

/** Returns a unique object-key prefix so failed test cleanup cannot collide with another run. */
function getPrefix(provider: string): string {
  return `integration/${provider}/${crypto.randomUUID()}`;
}

/** Creates the SeaweedFS S3 client for the current Testcontainers endpoint. */
function getS3Client() {
  return createS3Client({
    endpoint: getProviders().s3Endpoint,
    bucket: STORAGE_NAME,
    region: "us-east-1",
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    partSize: S3_PART_SIZE,
    concurrency: 2,
  });
}

/** Creates the Azurite client for the current Testcontainers endpoint. */
function getAzureClient() {
  return createAzureClient({
    endpoint: getProviders().azureEndpoint,
    container: STORAGE_NAME,
    credential: { kind: "shared-key", account: AZURE_ACCOUNT, key: AZURE_KEY },
    blockSize: 1024 * 1024,
    concurrency: 2,
  });
}

/** Ensures the logical Azure container exists before blob operations begin. */
async function ensureAzureContainer(): Promise<void> {
  const client = getAzureClient();
  const response = await client.request({ method: "PUT", query: { restype: "container" } });
  if (response.ok || response.status === 409) return;
  throw new Error(`Azurite container setup failed with HTTP ${response.status}: ${await response.text()}`);
}

before(async () => {
  providers = await openProviders();
});

after(async () => {
  const fixture = providers;
  providers = undefined;
  if (fixture !== undefined) await fixture.close();
});

describe("Testcontainers-backed object providers", () => {
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
