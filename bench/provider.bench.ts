import { env } from "node:process";

import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { toBytes } from "@std/streams/to-bytes";
import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createAzureClient } from "../src/azure.ts";
import { createAzureDriverFromClient } from "../src/driver/azure.ts";
import { createS3DriverFromClient } from "../src/driver/s3.ts";
import { createS3Client } from "../src/s3.ts";

import { AZURE_ACCOUNT, AZURE_KEY, S3_ACCESS_KEY, S3_SECRET_KEY, STORAGE_NAME } from "../tests/provider/fixture.ts";

/** Reads one provider endpoint supplied by the Testcontainers benchmark owner. */
function getEndpoint(name: "OPFS_S3_ENDPOINT" | "OPFS_AZURE_ENDPOINT"): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be supplied by bench/providers.ts.`);
  }
  return value;
}

/** SeaweedFS endpoint started outside the timed benchmark region. */
const S3_ENDPOINT = getEndpoint("OPFS_S3_ENDPOINT");
/** Azurite Blob endpoint started outside the timed benchmark region. */
const AZURE_ENDPOINT = getEndpoint("OPFS_AZURE_ENDPOINT");
/** Small transfer keeps request/setup overhead visible instead of saturating loopback bandwidth. */
const payload = new Uint8Array(256 * 1024);
payload.fill(7);
/** Multipart payload exercises each client's large-write scheduler separately. */
const multipart = new Uint8Array(6 * 1024 * 1024);
multipart.fill(11);
/** Unique namespace prevents one benchmark process from colliding with another. */
const prefix = `bench/${crypto.randomUUID()}`;

/** Official AWS SDK baseline against the same SeaweedFS endpoint. */
const aws = new AwsS3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  maxAttempts: 1,
});
/** Direct project S3 client with retries/metrics disabled for pure path overhead. */
const s3 = createS3Client({
  endpoint: S3_ENDPOINT,
  bucket: STORAGE_NAME,
  region: "us-east-1",
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  request: { retries: 0 },
  metrics: "none",
  partSize: 5 * 1024 * 1024,
});
/** Driver layer used to isolate backend metadata/planning overhead from protocol-client overhead. */
const s3Driver = createS3DriverFromClient(s3);
/** Direct object-adapter layer used to isolate translation overhead from facade overhead. */
const s3Adapter = createObjectAdapter(s3Driver, { prefix: `${prefix}/s3-adapter` });
/** Filesystem facade with instrumentation disabled for the lowest-overhead facade comparison. */
const s3Facade = createFileSystem(createObjectAdapter(s3Driver, { prefix: `${prefix}/s3-facade` }), {
  coordination: "none",
  metrics: "none",
});
/** Filesystem facade with basic counters enabled to measure instrumentation cost. */
const s3Measured = createFileSystem(createObjectAdapter(s3Driver, { prefix: `${prefix}/s3-metrics` }), {
  coordination: "none",
  metrics: "basic",
});

/** Official Azure SDK baseline against the same Azurite endpoint. */
const azureCredential = new StorageSharedKeyCredential(AZURE_ACCOUNT, AZURE_KEY);
/** Official Azure service client used only as the provider SDK baseline. */
const azureService = new BlobServiceClient(AZURE_ENDPOINT, azureCredential);
/** Official Azure container client scoped to the same logical container as project tests. */
const azureContainer = azureService.getContainerClient(STORAGE_NAME);
await azureContainer.createIfNotExists();
/** Direct project Azure client with retries/metrics disabled for pure path overhead. */
const azure = createAzureClient({
  endpoint: AZURE_ENDPOINT,
  container: STORAGE_NAME,
  credential: { kind: "shared-key", account: AZURE_ACCOUNT, key: AZURE_KEY },
  request: { retries: 0 },
  metrics: "none",
  blockSize: 1024 * 1024,
});
/** Driver layer used to isolate Azure backend metadata/planning overhead. */
const azureDriver = createAzureDriverFromClient(azure);
/** Direct Azure object-adapter layer used to isolate translation overhead. */
const azureAdapter = createObjectAdapter(azureDriver, { prefix: `${prefix}/azure-adapter` });
/** Azure facade with metrics disabled for the lowest-overhead facade comparison. */
const azureFacade = createFileSystem(createObjectAdapter(azureDriver, { prefix: `${prefix}/azure-facade` }), {
  coordination: "none",
  metrics: "none",
});
/** Azure facade with basic counters enabled to measure instrumentation cost. */
const azureMeasured = createFileSystem(createObjectAdapter(azureDriver, { prefix: `${prefix}/azure-metrics` }), {
  coordination: "none",
  metrics: "basic",
});

/** Materializes an AWS SDK GetObject body so all read cases include body consumption. */
async function readAws(key: string): Promise<void> {
  const result = await aws.send(new GetObjectCommand({ Bucket: STORAGE_NAME, Key: key }));
  await result.Body?.transformToByteArray();
}

/** Opens a fresh Web stream for each multipart attempt. */
function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Stable object key reused by the AWS SDK replacement/read samples. */
const awsKey = `${prefix}/aws.bin`;
/** Stable object key reused by the direct S3 client samples. */
const s3Key = `${prefix}/s3-client.bin`;
/** Stable object key reused by the S3 driver samples. */
const s3DriverKey = `${prefix}/s3-driver.bin`;
/** Stable blob key reused by the direct Azure client samples. */
const azureKey = `${prefix}/azure-client.bin`;
/** Stable blob key reused by the Azure driver samples. */
const azureDriverKey = `${prefix}/azure-driver.bin`;
/** Official SDK blob client reused by replacement/read samples. */
const azureOfficial = azureContainer.getBlockBlobClient(`${prefix}/azure-sdk.bin`);
await aws.send(new PutObjectCommand({ Bucket: STORAGE_NAME, Key: awsKey, Body: payload }));
await s3.put(s3Key, payload);
await s3Driver.put(s3DriverKey, payload);
await azureOfficial.uploadData(payload);
await azure.put(azureKey, payload);
await azureDriver.put(azureDriverKey, payload);
await s3Adapter.writeFile("/bench.bin", payload, { mode: "replace" });
await s3Facade.writeFile("/bench.bin", payload);
await s3Measured.writeFile("/bench.bin", payload);
await azureAdapter.writeFile("/bench.bin", payload, { mode: "replace" });
await azureFacade.writeFile("/bench.bin", payload);
await azureMeasured.writeFile("/bench.bin", payload);

bench("provider/s3 AWS SDK: 256 KiB replace + stat", async () => {
  await aws.send(new PutObjectCommand({ Bucket: STORAGE_NAME, Key: awsKey, Body: payload }));
  await aws.send(new HeadObjectCommand({ Bucket: STORAGE_NAME, Key: awsKey }));
});
bench("provider/s3 direct client: 256 KiB replace + stat", async () => {
  await s3.put(s3Key, payload);
});
bench("provider/s3 driver: 256 KiB replace + stat", async () => {
  await s3Driver.put(s3DriverKey, payload);
});
bench("provider/s3 direct adapter: 256 KiB replace + stat", async () => {
  await s3Adapter.writeFile("/bench.bin", payload, { mode: "replace" });
});
bench("provider/s3 facade metrics none: 256 KiB replace + stat", async () => {
  await s3Facade.writeFile("/bench.bin", payload);
});
bench("provider/s3 facade metrics basic: 256 KiB replace + stat", async () => {
  await s3Measured.writeFile("/bench.bin", payload);
});

bench("provider/s3 AWS SDK: 256 KiB read", async () => {
  await readAws(awsKey);
});
bench("provider/s3 direct client: 256 KiB read", async () => {
  await toBytes(await s3.get(s3Key));
});
bench("provider/s3 driver: 256 KiB read", async () => {
  await toBytes(await s3Driver.get(s3DriverKey));
});
bench("provider/s3 direct adapter: 256 KiB read", async () => {
  await s3Adapter.readFile("/bench.bin");
});
bench("provider/s3 facade metrics none: 256 KiB read", async () => {
  await s3Facade.readFile("/bench.bin");
});

bench("provider/s3 AWS Upload: 6 MiB multipart + stat", async () => {
  await new Upload({
    client: aws,
    params: { Bucket: STORAGE_NAME, Key: `${prefix}/aws-multipart.bin`, Body: multipart },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  }).done();
  await aws.send(new HeadObjectCommand({ Bucket: STORAGE_NAME, Key: `${prefix}/aws-multipart.bin` }));
});
bench("provider/s3 direct client: 6 MiB multipart + stat", async () => {
  await s3.put(`${prefix}/s3-multipart.bin`, stream(multipart), { size: multipart.byteLength });
});

bench("provider/azure official SDK: 256 KiB replace + stat", async () => {
  await azureOfficial.uploadData(payload);
  await azureOfficial.getProperties();
});
bench("provider/azure direct client: 256 KiB replace + stat", async () => {
  await azure.put(azureKey, payload);
});
bench("provider/azure driver: 256 KiB replace + stat", async () => {
  await azureDriver.put(azureDriverKey, payload);
});
bench("provider/azure direct adapter: 256 KiB replace + stat", async () => {
  await azureAdapter.writeFile("/bench.bin", payload, { mode: "replace" });
});
bench("provider/azure facade metrics none: 256 KiB replace + stat", async () => {
  await azureFacade.writeFile("/bench.bin", payload);
});
bench("provider/azure facade metrics basic: 256 KiB replace + stat", async () => {
  await azureMeasured.writeFile("/bench.bin", payload);
});

bench("provider/azure official SDK: 256 KiB read", async () => {
  await azureOfficial.downloadToBuffer();
});
bench("provider/azure direct client: 256 KiB read", async () => {
  await toBytes(await azure.get(azureKey));
});
bench("provider/azure driver: 256 KiB read", async () => {
  await toBytes(await azureDriver.get(azureDriverKey));
});
bench("provider/azure direct adapter: 256 KiB read", async () => {
  await azureAdapter.readFile("/bench.bin");
});
bench("provider/azure facade metrics none: 256 KiB read", async () => {
  await azureFacade.readFile("/bench.bin");
});

try {
  await run();
} finally {
  await s3Facade.close();
  await s3Measured.close();
  await azureFacade.close();
  await azureMeasured.close();
  aws.destroy();
}
