import { after, before, describe, it } from "node:test";
import { withReleases } from "./close.ts";
import { expect } from "@std/expect";
import { toBytes } from "@std/streams/to-bytes";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { type AzureClientOptionsType, createAzureClient } from "../src/azure.ts";
import { createAzureDriverFromClient } from "../src/driver/azure.ts";
import { createS3DriverFromClient } from "../src/driver/s3.ts";
import { createS3Client, type S3ClientOptionsType } from "../src/s3.ts";
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
import { expectBytes, fixtureBytes, verifyBytes } from "./reliability.ts";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

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
function getS3Client(options: Partial<S3ClientOptionsType> = {}) {
  return createS3Client({
    endpoint: getProviders().s3Endpoint,
    bucket: STORAGE_NAME,
    region: "us-east-1",
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    partSize: S3_PART_SIZE,
    concurrency: 2,
    ...options,
  });
}

/** Creates the Azurite client for the current Testcontainers endpoint. */
function getAzureClient(options: Partial<AzureClientOptionsType> = {}) {
  return createAzureClient({
    endpoint: getProviders().azureEndpoint,
    container: STORAGE_NAME,
    credential: { kind: "shared-key", account: AZURE_ACCOUNT, key: AZURE_KEY },
    blockSize: 1024 * 1024,
    concurrency: 2,
    ...options,
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
  for (const provider of ["s3", "azure"] as const) {
    it(`preserves filesystem byte/range semantics over the real ${provider} service`, async () => {
      if (provider === "azure") await ensureAzureContainer();
      const driver = provider === "s3"
        ? createS3DriverFromClient(getS3Client())
        : createAzureDriverFromClient(getAzureClient());
      const prefix = getPrefix(provider);
      const fileSystem = createFileSystem(createObjectAdapter(driver, { prefix }), {
        coordination: "local",
        lockPrefix: prefix,
      });
      try {
        await verifyBytes(fileSystem);
      } finally {
        try {
          await fileSystem.emptyDir();
        } finally {
          await fileSystem.close();
        }
      }
    });
  }

  for (const provider of ["s3", "azure"] as const) {
    it(`cancels an admitted ${provider} upload without publishing partial bytes`, async () => {
      if (provider === "azure") await ensureAzureContainer();
      const controller = new AbortController();
      let parts = 0;
      let cancelled = 0;
      let stalled: ReadableStreamDefaultController<Uint8Array> | undefined;
      const transport: typeof fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const response = await fetch(input, init);
        if (url.searchParams.has("partNumber") || url.searchParams.get("comp") === "block") {
          parts += 1;
          controller.abort("cancel after a real provider part");
        }
        return response;
      };
      const client = provider === "s3"
        ? getS3Client({ fetch: transport, concurrency: 1, delayedMultipart: false, request: { retries: 0 } })
        : getAzureClient({ fetch: transport, concurrency: 1, request: { retries: 0 } });
      const prefix = getPrefix(`${provider}-abort`);
      const key = `${prefix}/old.bin`;
      const old = fixtureBytes(63);
      const part = fixtureBytes(provider === "s3" ? S3_PART_SIZE : 1024 * 1024);
      let yielded = false;
      const source = new ReadableStream<Uint8Array>({
        start(stream) {
          stalled = stream;
        },
        pull(stream) {
          if (!yielded) {
            yielded = true;
            stream.enqueue(part);
          }
        },
        cancel() {
          cancelled += 1;
        },
      }, { highWaterMark: 0 });
      let rescued = false;
      const rescue = setTimeout(() => {
        rescued = true;
        try {
          stalled?.close();
        } catch { /* Cancellation already closed the source. */ }
      }, 5000);
      try {
        await client.put(key, old);
        await expect(client.put(key, source, { signal: controller.signal })).rejects.toBe(
          "cancel after a real provider part",
        );
        expect(rescued).toBe(false);
        expect(parts).toBe(1);
        expect(cancelled).toBe(1);
        expectBytes(await toBytes(await client.get(key)), old);
        if (provider === "s3") {
          const uploads = await client.request({ method: "GET", query: { uploads: "", prefix: key } });
          expect(uploads.ok).toBe(true);
          expect((await uploads.text()).includes("<Upload>")).toBe(false);
        }
      } finally {
        clearTimeout(rescue);
        try {
          stalled?.close();
        } catch { /* An aborted producer is already closed. */ }
        await client.delete(key);
      }
    });
  }

  it("interoperates with the official AWS SDK in both write/read directions", async () => {
    const client = getS3Client();
    const key = `${getPrefix("sdk")}/世界 %?#.bin`;
    const sdk = new S3Client({
      endpoint: getProviders().s3Endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    });
    const bytes = fixtureBytes(65537);
    try {
      await sdk.send(new PutObjectCommand({ Bucket: STORAGE_NAME, Key: key, Body: bytes }));
      expectBytes(await toBytes(await client.get(key)), bytes);
      await client.put(key, bytes.subarray(7), { mediaType: "application/octet-stream" });
      const response = await sdk.send(new GetObjectCommand({ Bucket: STORAGE_NAME, Key: key }));
      expectBytes(await response.Body!.transformToByteArray(), bytes.subarray(7));
      expect(response.ContentType).toBe("application/octet-stream");
    } finally {
      sdk.destroy();
      await client.delete(key);
    }
  });

  it("interoperates with the official Azure SDK in both write/read directions", async () => {
    await ensureAzureContainer();
    const client = getAzureClient();
    const key = `${getPrefix("sdk")}/世界 %?#.bin`;
    const sdk = new BlobServiceClient(
      getProviders().azureEndpoint,
      new StorageSharedKeyCredential(AZURE_ACCOUNT, AZURE_KEY),
    );
    const blob = sdk.getContainerClient(STORAGE_NAME).getBlockBlobClient(key);
    const bytes = fixtureBytes(65537);
    try {
      await blob.uploadData(bytes);
      expectBytes(await toBytes(await client.get(key)), bytes);
      await client.put(key, bytes.subarray(7), { mediaType: "application/octet-stream" });
      expectBytes(await blob.downloadToBuffer(), bytes.subarray(7));
      expect((await blob.getProperties()).contentType).toBe("application/octet-stream");
    } finally {
      await client.delete(key);
    }
  });

  it("exercises S3 signing, ranges, conditions, multipart upload, copy, listing, and filesystem translation", async () =>
    await withReleases(async (releases) => {
      const client = getS3Client();
      const prefix = getPrefix("s3");
      const basic = `${prefix}/basic.txt`;
      const large = `${prefix}/large.bin`;
      const copied = `${prefix}/copied.txt`;
      const facadeKey = `${prefix}/facade/state.txt`;
      // Every key deletion is attempted and retained beside an original failure.
      for (const key of [basic, large, copied, facadeKey, `${prefix}/facade/`]) {
        releases.push(() => client.delete(key));
      }

      {
        const original = new TextEncoder().encode("0123456789");
        const written = await client.put(basic, original, { mediaType: "text/plain", ifNoneMatch: "*" });
        expect(written.size).toBe(original.byteLength);
        if (written.etag === undefined) {
          throw new Error("S3 provider did not return an ETag for a completed object write.");
        }
        expect((await client.head(basic))?.etag).toBe(written.etag);
        expect(new TextDecoder().decode(await toBytes(await client.get(basic, { at: 3, length: 4 })))).toBe("3456");
        await expect(client.put(basic, new TextEncoder().encode("must not replace"), { ifNoneMatch: "*" })).rejects
          .toMatchObject({ status: 412 });
        expectBytes(await toBytes(await client.get(basic)), original);

        const first = new Uint8Array(S3_PART_SIZE);
        first.fill(7);
        const second = new Uint8Array(31);
        second.fill(9);
        await client.put(large, streamBytes([first, second]), { size: first.byteLength + second.byteLength });
        expect((await client.head(large))?.size).toBe(first.byteLength + second.byteLength);
        expectBytes(await toBytes(await client.get(large)), Uint8Array.from([...first, ...second]));

        await client.copy!(basic, copied, { sourceIfMatch: written.etag });
        expect(new TextDecoder().decode(await toBytes(await client.get(copied)))).toBe("0123456789");
        const page = await client.list({ prefix: `${prefix}/`, delimiter: "/" });
        expect(page.objects.some((entry) => entry.key === basic)).toBe(true);

        const fileSystem = createFileSystem(createObjectAdapter(createS3DriverFromClient(client), { prefix }), {
          coordination: "none",
        });
        try {
          await fileSystem.writeFile("/facade/state.txt", "through facade", { parents: true });
          expect(await fileSystem.readText("/facade/state.txt")).toBe("through facade");
          expect((await client.head(facadeKey))?.size).toBe(14);
        } finally {
          await fileSystem.close();
        }
      }
    }));

  it("exercises Azure Shared Key, ranges, conditions, block upload, copy, listing, and filesystem translation", async () =>
    await withReleases(async (releases) => {
      await ensureAzureContainer();
      const client = getAzureClient();
      const prefix = getPrefix("azure");
      const basic = `${prefix}/basic.txt`;
      const large = `${prefix}/large.bin`;
      const copied = `${prefix}/copied.txt`;
      const facadeKey = `${prefix}/facade/state.txt`;
      // Every key deletion is attempted and retained beside an original failure.
      for (const key of [basic, large, copied, facadeKey, `${prefix}/facade/`]) {
        releases.push(() => client.delete(key));
      }

      {
        const original = new TextEncoder().encode("0123456789");
        const written = await client.put(basic, original, { mediaType: "text/plain", ifNoneMatch: "*" });
        expect(written.size).toBe(original.byteLength);
        if (written.etag === undefined) {
          throw new Error("Azure provider did not return an ETag for a completed blob write.");
        }
        expect((await client.head(basic))?.etag).toBe(written.etag);
        expect(new TextDecoder().decode(await toBytes(await client.get(basic, { at: 3, length: 4 })))).toBe("3456");
        await expect(client.put(basic, new TextEncoder().encode("must not replace"), { ifNoneMatch: "*" })).rejects
          .toMatchObject({ status: 409, code: "BlobAlreadyExists" });
        expectBytes(await toBytes(await client.get(basic)), original);

        const first = new Uint8Array(1024 * 1024);
        first.fill(3);
        const second = new Uint8Array(1024 * 1024 + 17);
        second.fill(4);
        await client.put(large, streamBytes([first, second]), { size: first.byteLength + second.byteLength });
        expect((await client.head(large))?.size).toBe(first.byteLength + second.byteLength);
        expectBytes(await toBytes(await client.get(large)), Uint8Array.from([...first, ...second]));

        await client.copy!(basic, copied, { sourceIfMatch: written.etag });
        expect(new TextDecoder().decode(await toBytes(await client.get(copied)))).toBe("0123456789");
        const page = await client.list({ prefix: `${prefix}/`, delimiter: "/" });
        expect(page.objects.some((entry) => entry.key === basic)).toBe(true);

        const fileSystem = createFileSystem(createObjectAdapter(createAzureDriverFromClient(client), { prefix }), {
          coordination: "none",
        });
        try {
          await fileSystem.writeFile("/facade/state.txt", "through facade", { parents: true });
          expect(await fileSystem.readText("/facade/state.txt")).toBe("through facade");
          expect((await client.head(facadeKey))?.size).toBe(14);
        } finally {
          await fileSystem.close();
        }
      }
    }));
});
