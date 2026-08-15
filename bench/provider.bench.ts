import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { toBytes } from "@std/streams/to-bytes";
import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createAzureClient } from "../src/azure.ts";
import { createS3Client } from "../src/s3.ts";

/** Local provider fixture names match tests/provider/compose.yml. */
const STORAGE_NAME = "opfs-test";
const S3_ENDPOINT = "http://127.0.0.1:8333";
const AZURITE_ACCOUNT = "devstoreaccount1";
const AZURITE_KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const AZURE_ENDPOINT = `http://127.0.0.1:10000/${AZURITE_ACCOUNT}`;
/** Small transfer keeps request/setup overhead visible instead of saturating loopback bandwidth. */
const payload = new Uint8Array(256 * 1024);
payload.fill(7);
/** Multipart payload exercises each client's large-write scheduler separately. */
const multipart = new Uint8Array(6 * 1024 * 1024);
multipart.fill(11);
const prefix = `bench/${crypto.randomUUID()}`;

/** Official AWS SDK baseline against the same SeaweedFS endpoint. */
const aws = new AwsS3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "admin", secretAccessKey: "secret" },
  maxAttempts: 1,
});
/** Direct project S3 client with retries/metrics disabled for pure path overhead. */
const s3 = createS3Client({
  endpoint: S3_ENDPOINT,
  bucket: STORAGE_NAME,
  region: "us-east-1",
  credentials: { accessKeyId: "admin", secretAccessKey: "secret" },
  request: { retries: 0 },
  metrics: "none",
  partSize: 5 * 1024 * 1024,
});
const s3Adapter = createObjectAdapter(s3, { prefix: `${prefix}/s3-adapter` });
const s3Facade = createFileSystem(createObjectAdapter(s3, { prefix: `${prefix}/s3-facade` }), {
  coordination: "none",
  metrics: "none",
});
const s3Measured = createFileSystem(createObjectAdapter(s3, { prefix: `${prefix}/s3-metrics` }), {
  coordination: "none",
  metrics: "basic",
});

/** Official Azure SDK baseline against the same Azurite endpoint. */
const azureCredential = new StorageSharedKeyCredential(AZURITE_ACCOUNT, AZURITE_KEY);
const azureService = new BlobServiceClient(AZURE_ENDPOINT, azureCredential);
const azureContainer = azureService.getContainerClient(STORAGE_NAME);
await azureContainer.createIfNotExists();
/** Direct project Azure client with retries/metrics disabled for pure path overhead. */
const azure = createAzureClient({
  endpoint: AZURE_ENDPOINT,
  container: STORAGE_NAME,
  credential: { kind: "shared-key", account: AZURITE_ACCOUNT, key: AZURITE_KEY },
  request: { retries: 0 },
  metrics: "none",
  blockSize: 1024 * 1024,
});
const azureAdapter = createObjectAdapter(azure, { prefix: `${prefix}/azure-adapter` });
const azureFacade = createFileSystem(createObjectAdapter(azure, { prefix: `${prefix}/azure-facade` }), {
  coordination: "none",
  metrics: "none",
});
const azureMeasured = createFileSystem(createObjectAdapter(azure, { prefix: `${prefix}/azure-metrics` }), {
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

const awsKey = `${prefix}/aws.bin`;
const s3Key = `${prefix}/s3-client.bin`;
const azureKey = `${prefix}/azure-client.bin`;
const azureOfficial = azureContainer.getBlockBlobClient(`${prefix}/azure-sdk.bin`);
await aws.send(new PutObjectCommand({ Bucket: STORAGE_NAME, Key: awsKey, Body: payload }));
await s3.put(s3Key, payload);
await azureOfficial.uploadData(payload);
await azure.put(azureKey, payload);
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
