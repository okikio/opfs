import { S3Client as BunS3Client } from "bun";
import { toBytes } from "@std/streams/to-bytes";
import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createS3Client } from "../src/s3.ts";

import { S3_ACCESS_KEY, S3_SECRET_KEY, STORAGE_NAME } from "../tests/provider/fixture.ts";

/** SeaweedFS endpoint started by the Node Testcontainers benchmark owner. */
const S3_ENDPOINT = Bun.env.OPFS_S3_ENDPOINT;
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
const bun = new BunS3Client({
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
/** Direct object-adapter layer used to isolate translation overhead. */
const adapter = createObjectAdapter(s3, { prefix: `${PREFIX}/adapter` });
/** Filesystem facade with metrics disabled. */
const facade = createFileSystem(createObjectAdapter(s3, { prefix: `${PREFIX}/facade` }), {
  coordination: "none",
  metrics: "none",
});
/** Filesystem facade with basic counters enabled. */
const measured = createFileSystem(createObjectAdapter(s3, { prefix: `${PREFIX}/metrics` }), {
  coordination: "none",
  metrics: "basic",
});

/** Stable object key reused by Bun S3 replacement/read samples. */
const bunKey = `${PREFIX}/bun.bin`;
/** Stable object key reused by direct project client samples. */
const directKey = `${PREFIX}/direct.bin`;
await bun.write(bunKey, payload);
await bun.file(bunKey).stat();
await s3.put(directKey, payload);
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
