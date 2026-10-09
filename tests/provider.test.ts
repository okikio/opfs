import { after, before, describe, it } from "node:test";
import { close, withReleases } from "./close.ts";
import { isCancellation, isPart, settle } from "./provider-operation.ts";
import { expect } from "@std/expect";
import { toBytes } from "@std/streams/to-bytes";
import { parse } from "@std/xml/parse";

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
  S3_LIST_ENCODING,
  S3_SECRET_KEY,
  STORAGE_NAME,
} from "./provider/fixture.ts";
import { streamBytes } from "./stream.ts";
import { expectBytes, fixtureBytes, verifyBytes } from "./reliability.ts";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";

/**
 * Counts uploads only in an acquired, complete multipart listing document.
 *
 * Prefix-filtered cleanup checks need exhaustion, not a missing tag substring.
 * AWS defines Upload as a direct result child and IsTruncated as pagination
 * evidence. Namespace prefixes and XML formatting do not prove absence.
 * https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html
 */
function multipartUploads(value: string): number {
  const root = parse(value).root;
  if (root.name.local !== "ListMultipartUploadsResult") throw new SyntaxError("Expected multipart listing XML.");
  const children = root.children.filter((node) => node.type === "element");
  const fields = new Set([
    "Bucket",
    "KeyMarker",
    "UploadIdMarker",
    "NextKeyMarker",
    "NextUploadIdMarker",
    "MaxUploads",
    "IsTruncated",
    "Upload",
    "CommonPrefixes",
    "EncodingType",
    "Delimiter",
    "Prefix",
  ]);
  if (children.some((node) => !fields.has(node.name.local))) {
    throw new SyntaxError("Unexpected multipart listing field.");
  }
  if (root.children.some((node) => (node.type === "text" || node.type === "cdata") && node.text.trim() !== "")) {
    throw new SyntaxError("Expected multipart listing fields, not free text.");
  }
  for (const field of children) {
    if (
      field.name.local !== "Upload" && field.name.local !== "CommonPrefixes" &&
      field.children.some((node) => node.type === "element")
    ) {
      throw new SyntaxError("Expected scalar multipart listing metadata.");
    }
  }
  const truncated = children.filter((node) => node.name.local === "IsTruncated");
  if (truncated.length !== 1 || truncated[0]!.children.some((node) => node.type === "element")) {
    throw new SyntaxError("Expected scalar multipart pagination evidence.");
  }
  const complete = truncated[0]!.children.filter((node) => node.type === "text" || node.type === "cdata")
    .map((node) => node.text).join("").trim();
  if (complete !== "false" || children.some((node) => node.name.local === "CommonPrefixes")) {
    throw new SyntaxError("A partial or delimiter-grouped listing cannot prove cleanup.");
  }
  const uploads = children.filter((node) => node.name.local === "Upload");
  for (const upload of uploads) {
    for (const name of ["Key", "UploadId"]) {
      const values = upload.children.filter((node) => node.type === "element").filter((node) =>
        node.name.local === name
      );
      if (
        values.length !== 1 || values[0]!.children.some((node) => node.type === "element") ||
        values[0]!.children.filter((node) => node.type === "text" || node.type === "cdata")
            .map((node) => node.text).join("").length === 0
      ) {
        throw new SyntaxError("Expected a scalar multipart upload identity.");
      }
    }
  }
  return uploads.length;
}

it("requires complete semantic multipart-list evidence before certifying absence", () => {
  const complete = "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>";
  expect(multipartUploads(complete)).toBe(0);
  expect(
    multipartUploads(
      '<s:ListMultipartUploadsResult xmlns:s="http://s3.amazonaws.com/doc/2006-03-01/">\n<s:IsTruncated><![CDATA[false]]></s:IsTruncated>\n<s:Upload><s:Key>value</s:Key><s:UploadId>owned</s:UploadId></s:Upload>\n</s:ListMultipartUploadsResult>',
    ),
  ).toBe(1);
  for (
    const body of [
      "<ListMultipartUploadsResult>",
      "<Error><Code>AccessDenied</Code></Error>",
      "<ListMultipartUploadsResult/>",
      "<ListMultipartUploadsResult><IsTruncated>true</IsTruncated></ListMultipartUploadsResult>",
      "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><IsTruncated>false</IsTruncated></ListMultipartUploadsResult>",
      "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><Wrapper><Upload/></Wrapper></ListMultipartUploadsResult>",
      "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><Bucket><Upload/></Bucket></ListMultipartUploadsResult>",
      "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><Upload/></ListMultipartUploadsResult>",
      "<ListMultipartUploadsResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>value/</Prefix></CommonPrefixes></ListMultipartUploadsResult>",
    ]
  ) expect(() => multipartUploads(body)).toThrow(SyntaxError);
});

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
    listEncoding: S3_LIST_ENCODING,
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
  // This setup owns the response, including a nonempty already-exists acknowledgement.
  const text = await response.text();
  if (response.ok || response.status === 409) return;
  throw new Error(`Azurite container setup failed with HTTP ${response.status}: ${text}`);
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
  it("keeps spaces, literal plus and percent keys distinct through real S3 listing and recursive removal", async () => {
    const prefix = getPrefix("listing");
    const client = getS3Client();
    const fs = createFileSystem(createObjectAdapter(createS3DriverFromClient(client), { prefix }), {
      coordination: "local",
    });
    await withReleases(async (releases) => {
      releases.push(() => fs.close());
      releases.push(() => fs.emptyDir());
      const values = new Map([["a b", "space"], ["a+b", "plus"], ["a%20b", "percent"], [" space/+leaf", "nested"]]);
      for (const [name, body] of values) await fs.writeFile(`/${name}`, body, { parents: true });
      expect((await Array.fromAsync(fs.readDir("/"))).map((entry) => entry.name).sort()).toEqual([
        " space",
        "a b",
        "a%20b",
        "a+b",
      ]);
      expect((await Array.fromAsync(fs.readDir("/ space"))).map((entry) => entry.name)).toEqual(["+leaf"]);
      for (const [name, body] of values) expect(await fs.readText(`/${name}`)).toBe(body);
      const listed: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        // The unique namespace contains four values and one directory marker, plus a possible terminal page.
        expect(++pages).toBeLessThanOrEqual(values.size + 2);
        const page = await client.list({ prefix: `${prefix}/`, limit: 1, ...(cursor === undefined ? {} : { cursor }) });
        listed.push(...page.objects.map((entry) => entry.key));
        cursor = page.cursor;
      } while (cursor !== undefined);
      for (const name of values.keys()) expect(listed).toContain(`${prefix}/${name}`);
      await fs.emptyDir();
      expect(await Array.fromAsync(fs.readDir("/"))).toEqual([]);
      expect((await client.list({ prefix: `${prefix}/` })).objects).toEqual([]);
    });
  });

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
      await withReleases(async (releases) => {
        // Keep the operation failure beside cleanup failures; teardown must not hide the byte oracle.
        releases.push(() => fileSystem.close());
        releases.push(() => fileSystem.emptyDir());
        await verifyBytes(fileSystem);
      });
    });
  }

  for (const provider of ["s3", "azure"] as const) {
    it(`cancels an admitted ${provider} upload without publishing partial bytes`, async () =>
      await withReleases(async (releases) => {
        if (provider === "azure") await ensureAzureContainer();
        const prefix = getPrefix(`${provider}-abort`);
        const key = `${prefix}/old.bin`;
        const controller = new AbortController();
        let parts = 0;
        let cancelled = 0;
        const transport: typeof fetch = async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          const response = await fetch(input, init);
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          if (isPart(provider, key, url, method, response.status)) {
            parts += 1;
            controller.abort("cancel after a real provider part");
          }
          return response;
        };
        const client = provider === "s3"
          ? getS3Client({ fetch: transport, concurrency: 1, delayedMultipart: false, request: { retries: 0 } })
          : getAzureClient({ fetch: transport, concurrency: 1, request: { retries: 0 } });
        releases.push(() => client.delete(key));
        const old = fixtureBytes(63);
        // Setup latency cannot consume the streaming operation's watchdog.
        await client.put(key, old);
        const part = fixtureBytes(provider === "s3" ? S3_PART_SIZE : 1024 * 1024);
        let yielded = false;
        const source = new ReadableStream<Uint8Array>({
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
        const pending = settle(controller, () => client.put(key, source, { signal: controller.signal }));
        // Capture both outcomes immediately, including rejected null/undefined.
        const observed = pending.then(
          (value) => ({ ok: true as const, value }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
        let consumed = false;
        // Retire the upload before deleting its key, including assertion failures.
        releases.push(async () => {
          controller.abort(new Error("Provider scenario cleanup."));
          await close([
            async () => {
              const result = await observed;
              // The main oracle owns its consumed rejection; teardown only
              // reports a different/unconsumed failure, never repeats that event.
              if (!consumed && !result.ok && !isCancellation(result.reason, controller.signal)) {
                throw result.reason;
              }
            },
            async () => {
              if (!source.locked) await source.cancel();
            },
          ]);
        });
        const result = await observed;
        consumed = true;
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("The cancelled provider upload unexpectedly resolved.");
        if (!isCancellation(result.reason, controller.signal)) throw result.reason;
        expect(parts).toBe(1);
        expect(cancelled).toBe(1);
        expect(source.locked).toBe(false);
        expectBytes(await toBytes(await client.get(key)), old);
        if (provider === "s3") {
          const uploads = await client.request({ method: "GET", query: { uploads: "", prefix: key } });
          expect(uploads.ok).toBe(true);
          expect(multipartUploads(await uploads.text())).toBe(0);
        }
      }));
  }

  it("interoperates with the official AWS SDK in both write/read directions", async () =>
    await withReleases(async (releases) => {
      const client = getS3Client();
      const key = `${getPrefix("sdk")}/世界 %?#.bin`;
      releases.push(() => client.delete(key));
      const sdk = new S3Client({
        endpoint: getProviders().s3Endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      });
      releases.push(() => sdk.destroy());
      const bytes = fixtureBytes(65537);
      await sdk.send(new PutObjectCommand({ Bucket: STORAGE_NAME, Key: key, Body: bytes }));
      expectBytes(await toBytes(await client.get(key)), bytes);
      await client.put(key, bytes.subarray(7), { mediaType: "application/octet-stream" });
      const response = await sdk.send(new GetObjectCommand({ Bucket: STORAGE_NAME, Key: key }));
      expectBytes(await response.Body!.transformToByteArray(), bytes.subarray(7));
      expect(response.ContentType).toBe("application/octet-stream");
    }));

  it("interoperates with the official Azure SDK in both write/read directions", async () =>
    await withReleases(async (releases) => {
      await ensureAzureContainer();
      const client = getAzureClient();
      const key = `${getPrefix("sdk")}/世界 %?#.bin`;
      releases.push(() => client.delete(key));
      const sdk = new BlobServiceClient(
        getProviders().azureEndpoint,
        new StorageSharedKeyCredential(AZURE_ACCOUNT, AZURE_KEY),
      );
      const blob = sdk.getContainerClient(STORAGE_NAME).getBlockBlobClient(key);
      const bytes = fixtureBytes(65537);
      await blob.uploadData(bytes);
      expectBytes(await toBytes(await client.get(key)), bytes);
      await client.put(key, bytes.subarray(7), { mediaType: "application/octet-stream" });
      expectBytes(await blob.downloadToBuffer(), bytes.subarray(7));
      expect((await blob.getProperties()).contentType).toBe("application/octet-stream");
    }));

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
