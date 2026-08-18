/// <reference types="bun-types" />
import { toBytes } from "@std/streams/to-bytes";
import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createS3DriverFromClient } from "../src/driver/s3.ts";
import { createS3Client } from "../src/s3.ts";

import { S3_ACCESS_KEY, S3_SECRET_KEY, STORAGE_NAME } from "../tests/provider/fixture.ts";

/** Bun S3 file methods measured by the provider benchmark. */
interface BunS3FileType {
  /** Reads provider metadata without materializing the object body. */
  stat(): Promise<unknown>;
  /** Materializes the object for the direct native read baseline. */
  bytes(): Promise<Uint8Array>;
  /** Opens Bun's multipart network sink. */
  writer(options: { readonly partSize: number; readonly queueSize: number; readonly retry: number }): BunS3WriterType;
}

/** Bun multipart sink used for the native provider baseline. */
interface BunS3WriterType {
  /** Queues bytes into the multipart upload. */
  write(data: Uint8Array): number | Promise<number>;
  /** Flushes pending parts and commits the object. */
  end(): void | Promise<void>;
}

/** Bun S3 client methods required by this benchmark. */
interface BunS3ClientType {
  /** Replaces one object. */
  write(path: string, data: Uint8Array): Promise<number>;
  /** Opens one lazy remote object. */
  file(path: string): BunS3FileType;
}

/** Constructor shape for Bun's native S3 client. */
interface BunS3ClientConstructorType {
  new (options: {
    readonly endpoint: string;
    readonly bucket: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly virtualHostedStyle: boolean;
    readonly retry: number;
    readonly partSize: number;
    readonly queueSize: number;
  }): BunS3ClientType;
}

/** Bun runtime subset required for the native S3 comparison lane. */
interface BunProviderRuntimeType {
  readonly S3Client: BunS3ClientConstructorType;
}

/** Resolves Bun lazily so the Deno check matrix can inspect this benchmark source. */
function getBun() {
  const runtime = Reflect.get(globalThis, "Bun");
  if (runtime === undefined || typeof runtime?.S3Client !== "function") {
    throw new TypeError("Bun provider benchmark requires the Bun runtime.");
  }
  return runtime;
}

/** Bun runtime under test. */
const bunRuntime = getBun();

/** Reads one environment value through Bun's Node-compatible process global without ambient Node declarations. */
function getEnv(name: string): string | undefined {
  const runtimeProcess = Reflect.get(globalThis, "process") as
    | { readonly env?: Record<string, string | undefined> }
    | undefined;
  return runtimeProcess?.env?.[name];
}

/** SeaweedFS endpoint started by the Node Testcontainers benchmark owner. */
const S3_ENDPOINT = getEnv("OPFS_S3_ENDPOINT");
if (S3_ENDPOINT === undefined || S3_ENDPOINT.length === 0) {
  throw new Error("OPFS_S3_ENDPOINT must be supplied by bench/providers.ts.");
}
/** Logical bucket shared with the other provider baselines. */
const BUCKET = STORAGE_NAME;
/** Unique namespace prevents concurrent Bun benchmark runs from colliding. */
const PREFIX = `bench/bun/${crypto.randomUUID()}`;
/** Small payload keeps client and abstraction overhead visible on loopback. */
const payload = new Uint8Array(256 * 1024);
payload.fill(17);
/** Multipart payload exercises each streaming scheduler above the five-MiB S3 minimum. */
const multipart = new Uint8Array(6 * 1024 * 1024);
multipart.fill(19);

/** Bun's current native Rust-backed S3 client baseline. */
const bun = new bunRuntime.S3Client({
  endpoint: S3_ENDPOINT,
  bucket: BUCKET,
  region: "us-east-1",
  accessKeyId: S3_ACCESS_KEY,
  secretAccessKey: S3_SECRET_KEY,
  virtualHostedStyle: false,
  retry: 0,
  partSize: 5 * 1024 * 1024,
  queueSize: 4,
});
/** Project direct SigV4 client with retry and metrics overhead disabled. */
const s3 = createS3Client({
  endpoint: S3_ENDPOINT,
  bucket: BUCKET,
  region: "us-east-1",
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  request: { retries: 0 },
  metrics: "none",
  partSize: 5 * 1024 * 1024,
  concurrency: 4,
});
/** Driver layer used to isolate project backend overhead from the direct client. */
const driver = createS3DriverFromClient(s3);
/** Direct object-adapter layer used to isolate translation overhead. */
const adapter = createObjectAdapter(driver, { prefix: `${PREFIX}/adapter` });
/** Filesystem facade with metrics disabled. */
const facade = createFileSystem(createObjectAdapter(driver, { prefix: `${PREFIX}/facade` }), {
  coordination: "none",
  metrics: "none",
});
/** Filesystem facade with basic counters enabled. */
const measured = createFileSystem(createObjectAdapter(driver, { prefix: `${PREFIX}/metrics` }), {
  coordination: "none",
  metrics: "basic",
});

/** Stable object key reused by Bun S3 replacement/read samples. */
const bunKey = `${PREFIX}/bun.bin`;
/** Stable object key reused by direct project client samples. */
const directKey = `${PREFIX}/direct.bin`;
/** Stable object key reused by project driver samples. */
const driverKey = `${PREFIX}/driver.bin`;
await bun.write(bunKey, payload);
await bun.file(bunKey).stat();
await s3.put(directKey, payload);
await driver.put(driverKey, payload);
await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
await facade.writeFile("/bench.bin", payload);
await measured.writeFile("/bench.bin", payload);

bench("provider/s3 Bun S3Client: 256 KiB replace + stat", async () => {
  await bun.write(bunKey, payload);
  await bun.file(bunKey).stat();
});
bench("provider/s3 project direct client: 256 KiB replace + stat", async () => {
  await s3.put(directKey, payload);
});
bench("provider/s3 project driver: 256 KiB replace + stat", async () => {
  await driver.put(driverKey, payload);
});
bench("provider/s3 project direct adapter: 256 KiB replace + stat", async () => {
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
});
bench("provider/s3 project facade metrics none: 256 KiB replace + stat", async () => {
  await facade.writeFile("/bench.bin", payload);
});
bench("provider/s3 project facade metrics basic: 256 KiB replace + stat", async () => {
  await measured.writeFile("/bench.bin", payload);
});

bench("provider/s3 Bun S3File: 256 KiB read", async () => {
  await bun.file(bunKey).bytes();
});
bench("provider/s3 project direct client: 256 KiB read", async () => {
  await toBytes(await s3.get(directKey));
});
bench("provider/s3 project driver: 256 KiB read", async () => {
  await toBytes(await driver.get(driverKey));
});
bench("provider/s3 project direct adapter: 256 KiB read", async () => {
  await adapter.readFile("/bench.bin");
});
bench("provider/s3 project facade metrics none: 256 KiB read", async () => {
  await facade.readFile("/bench.bin");
});

bench("provider/s3 Bun NetworkSink: 6 MiB multipart + stat", async () => {
  const key = `${PREFIX}/bun-multipart.bin`;
  const writer = bun.file(key).writer({ partSize: 5 * 1024 * 1024, queueSize: 4, retry: 0 });
  await writer.write(multipart);
  await writer.end();
  await bun.file(key).stat();
});
bench("provider/s3 project direct client: 6 MiB multipart + stat", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(multipart);
      controller.close();
    },
  });
  await s3.put(`${PREFIX}/direct-multipart.bin`, source, { size: multipart.byteLength });
});

try {
  await run();
} finally {
  await facade.close();
  await measured.close();
}
