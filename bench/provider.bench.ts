import { env } from "node:process";

import { GetObjectCommand, PutObjectCommand, S3Client as AwsS3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { toBytes } from "@std/streams/to-bytes";
import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as makePayload, report } from "./result.ts";
import { expectEtag, expectReceipt, observeProvider } from "./provider-contract.ts";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createAzureClient } from "../src/azure.ts";
import { createAzureDriverFromClient } from "../src/driver/azure.ts";
import { createS3DriverFromClient } from "../src/driver/s3.ts";
import { createS3Client } from "../src/s3.ts";

import {
  AZURE_ACCOUNT,
  AZURE_KEY,
  S3_ACCESS_KEY,
  S3_LIST_ENCODING,
  S3_SECRET_KEY,
  STORAGE_NAME,
} from "../tests/provider/fixture.ts";

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
const payload = makePayload(256 * 1024);
/** Multipart payload exercises each client's large-write scheduler separately. */
const multipart = makePayload(6 * 1024 * 1024);
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
/** Direct project S3 client with retries and metrics disabled for the primitive acknowledgement workload. */
const s3 = createS3Client({
  listEncoding: S3_LIST_ENCODING,
  endpoint: S3_ENDPOINT,
  bucket: STORAGE_NAME,
  region: "us-east-1",
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  request: { retries: 0 },
  metrics: "none",
  partSize: 5 * 1024 * 1024,
  concurrency: 4,
});
/** Driver layer exposes the same publication route with backend metadata and planning available. */
const s3Driver = createS3DriverFromClient(s3);
/** Object-adapter layer adds file/directory conflict admission before publication. */
const s3Adapter = createObjectAdapter(s3Driver, { prefix: `${prefix}/s3-adapter` });
/** Filesystem facade includes file admission with instrumentation disabled. */
const s3Facade = createFileSystem(createObjectAdapter(s3Driver, { prefix: `${prefix}/s3-facade` }), {
  coordination: "none",
  metrics: "none",
});
/** Filesystem facade with basic counters enabled to measure instrumentation cost. */
const s3Measured = createFileSystem(createObjectAdapter(s3Driver, { prefix: `${prefix}/s3-metrics` }), {
  coordination: "none",
  metrics: "basic",
});
/** Explicit adapter admission provides the opt-in replacement comparison. */
const s3Delegated = createFileSystem(createObjectAdapter(s3Driver, { prefix: `${prefix}/s3-delegated` }), {
  coordination: "none",
  metrics: "none",
  optimizations: { writeAdmission: true },
});

/** Official Azure SDK baseline against the same Azurite endpoint. */
const azureCredential = new StorageSharedKeyCredential(AZURE_ACCOUNT, AZURE_KEY);
/** Official Azure service client used only as the provider SDK baseline. */
const azureService = new BlobServiceClient(AZURE_ENDPOINT, azureCredential, { retryOptions: { maxTries: 1 } });
/** Official Azure container client scoped to the same logical container as project tests. */
const azureContainer = azureService.getContainerClient(STORAGE_NAME);
/** Direct project Azure client with retries and metrics disabled for the primitive acknowledgement workload. */
const azure = createAzureClient({
  endpoint: AZURE_ENDPOINT,
  container: STORAGE_NAME,
  credential: { kind: "shared-key", account: AZURE_ACCOUNT, key: AZURE_KEY },
  request: { retries: 0 },
  metrics: "none",
  blockSize: 1024 * 1024,
  concurrency: 4,
});
/** Driver layer exposes the Azure publication route with backend metadata and planning available. */
const azureDriver = createAzureDriverFromClient(azure);
/** Azure object-adapter layer adds file/directory conflict admission before publication. */
const azureAdapter = createObjectAdapter(azureDriver, { prefix: `${prefix}/azure-adapter` });
/** Azure facade includes file admission with instrumentation disabled. */
const azureFacade = createFileSystem(createObjectAdapter(azureDriver, { prefix: `${prefix}/azure-facade` }), {
  coordination: "none",
  metrics: "none",
});
/** Azure facade with basic counters enabled to measure instrumentation cost. */
const azureMeasured = createFileSystem(createObjectAdapter(azureDriver, { prefix: `${prefix}/azure-metrics` }), {
  coordination: "none",
  metrics: "basic",
});
/** Explicit Azure adapter admission provides the opt-in replacement comparison. */
const azureDelegated = createFileSystem(createObjectAdapter(azureDriver, { prefix: `${prefix}/azure-delegated` }), {
  coordination: "none",
  metrics: "none",
  optimizations: { writeAdmission: true },
});

/** Materializes an AWS SDK GetObject body so all read cases include body consumption. */
async function readAws(key: string): Promise<Uint8Array> {
  const result = await aws.send(new GetObjectCommand({ Bucket: STORAGE_NAME, Key: key }));
  if (!result.Body) throw new Error("AWS benchmark body is missing.");
  return await result.Body.transformToByteArray();
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
/** Untimed native transports prove protocol work; direct endpoint clients below own all timings. */
async function verifyPublicationContracts(): Promise<void> {
  const cleanups: (() => void | Promise<void>)[] = [];
  let failed = false;
  let primary: unknown;
  try {
    const observedS3 = await observeProvider(S3_ENDPOINT);
    cleanups.push(() => observedS3.close());
    const observedAzure = await observeProvider(AZURE_ENDPOINT);
    cleanups.push(() => observedAzure.close());
    const sdk = new AwsS3Client({
      endpoint: observedS3.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      maxAttempts: 1,
    });
    cleanups.push(() => sdk.destroy());
    const project = createS3Client({
      listEncoding: S3_LIST_ENCODING,
      endpoint: observedS3.endpoint,
      bucket: STORAGE_NAME,
      region: "us-east-1",
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      request: { retries: 0 },
      metrics: "none",
      partSize: 5 * 1024 * 1024,
      concurrency: 4,
    });
    const blobs = createAzureClient({
      endpoint: observedAzure.endpoint,
      container: STORAGE_NAME,
      credential: { kind: "shared-key", account: AZURE_ACCOUNT, key: AZURE_KEY },
      request: { retries: 0 },
      metrics: "none",
      blockSize: 1024 * 1024,
      concurrency: 4,
    });
    const official = new BlobServiceClient(observedAzure.endpoint, azureCredential, { retryOptions: { maxTries: 1 } })
      .getContainerClient(STORAGE_NAME);
    await official.createIfNotExists();
    const one = { "PUT object": 1 };
    const multiple = { "POST initiate": 1, "PUT part": 2, "POST commit": 1 };
    const blocks = { "PUT block": 6, "PUT commit": 1 };
    const key = `${prefix}/oracle.bin`;
    const ack = await observedS3.check("AWS acknowledged replace", () =>
      sdk.send(
        new PutObjectCommand({
          Bucket: STORAGE_NAME,
          Key: key,
          Body: payload,
        }),
      ), one);
    expectEtag(ack.ETag, "AWS acknowledged replace");
    const awsBytes = await sdk.send(new GetObjectCommand({ Bucket: STORAGE_NAME, Key: key }));
    if (!awsBytes.Body) throw new Error("AWS oracle body missing.");
    expectBytes(await awsBytes.Body.transformToByteArray(), payload, "AWS acknowledged replace");
    const large = await observedS3.check("AWS acknowledged multipart", () =>
      new Upload({
        client: sdk,
        params: { Bucket: STORAGE_NAME, Key: key, Body: multipart },
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
      }).done(), multiple);
    expectEtag(large.ETag, "AWS acknowledged multipart");
    const awsLarge = await sdk.send(new GetObjectCommand({ Bucket: STORAGE_NAME, Key: key }));
    if (!awsLarge.Body) throw new Error("AWS multipart oracle body missing.");
    expectBytes(await awsLarge.Body.transformToByteArray(), multipart, "AWS acknowledged multipart");
    for (
      const [name, client, observer] of [
        ["S3", project, observedS3],
        ["Azure", blobs, observedAzure],
      ] as const
    ) {
      const driver = name === "S3" ? createS3DriverFromClient(project) : createAzureDriverFromClient(blobs);
      expectReceipt(
        await observer.check(`${name} client acknowledged replace`, () => client.put(key, payload), one),
        payload,
        name,
      );
      expectBytes(await toBytes(await client.get(key)), payload, `${name} client acknowledged replace`);
      expectReceipt(
        await observer.check(`${name} driver acknowledged replace`, () => driver.put(key, payload), one),
        payload,
        name,
      );
      expectBytes(await toBytes(await driver.get(key)), payload, `${name} driver acknowledged replace`);
      expectReceipt(
        await observer.check(`${name} acknowledged large publication`, () =>
          client.put(key, stream(multipart), {
            size: multipart.byteLength,
          }), name === "S3" ? multiple : blocks),
        multipart,
        name,
      );
      expectBytes(await toBytes(await client.get(key)), multipart, `${name} large publication`);
      const adapter = createObjectAdapter(driver, { prefix: `${prefix}/oracle/${name}/adapter` });
      const facade = createFileSystem(createObjectAdapter(driver, { prefix: `${prefix}/oracle/${name}/facade` }), {
        coordination: "none",
        metrics: "none",
      });
      const measured = createFileSystem(createObjectAdapter(driver, { prefix: `${prefix}/oracle/${name}/metrics` }), {
        coordination: "none",
        metrics: "basic",
      });
      const delegated = createFileSystem(
        createObjectAdapter(driver, { prefix: `${prefix}/oracle/${name}/delegated` }),
        {
          coordination: "none",
          metrics: "none",
          optimizations: { writeAdmission: true },
        },
      );
      cleanups.push(() => facade.close(), () => measured.close(), () => delegated.close());
      // Existing-file samples isolate repeatable projection guards from first-create lookup cost.
      await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
      await facade.writeFile("/bench.bin", payload);
      await measured.writeFile("/bench.bin", payload);
      await delegated.writeFile("/bench.bin", payload);
      await observer.check(`${name} adapter projected replace`, () =>
        adapter.writeFile("/bench.bin", payload, {
          mode: "replace",
        }), { "HEAD stat": 2, "GET list": 1, "PUT object": 1 });
      expectBytes(await adapter.readFile("/bench.bin"), payload, `${name} adapter projected replace`);
      for (const [label, fs] of [["none", facade], ["basic", measured], ["admission-delegated", delegated]] as const) {
        await observer.check(
          `${name} facade metrics ${label} projected replace`,
          () => fs.writeFile("/bench.bin", payload),
          {
            "HEAD stat": label === "admission-delegated" ? 2 : 4,
            "GET list": label === "admission-delegated" ? 1 : 2,
            "PUT object": 1,
          },
        );
        expectBytes(await fs.readFile("/bench.bin"), payload, `${name} facade metrics ${label} projected replace`);
      }
    }
    const blob = official.getBlockBlobClient(key);
    expectEtag(
      (await observedAzure.check("Azure SDK acknowledged replace", () => blob.uploadData(payload), one)).etag,
      "Azure SDK acknowledged replace",
    );
    expectBytes(new Uint8Array(await blob.downloadToBuffer()), payload, "Azure SDK acknowledged replace");
    expectEtag(
      (await observedAzure.check("Azure SDK acknowledged blocks", () =>
        blob.uploadData(multipart, {
          blockSize: 1024 * 1024,
          maxSingleShotSize: 0,
          concurrency: 4,
        }), blocks)).etag,
      "Azure SDK acknowledged blocks",
    );
    expectBytes(new Uint8Array(await blob.downloadToBuffer()), multipart, "Azure SDK acknowledged blocks");
  } catch (reason) {
    failed = true;
    primary = reason;
    throw reason;
  } finally {
    await finish(cleanups, failed ? [primary] : []);
  }
}

let failed = false;
let primary: unknown;
try {
  await verifyPublicationContracts();
  await azureContainer.createIfNotExists();
  await aws.send(new PutObjectCommand({ Bucket: STORAGE_NAME, Key: awsKey, Body: payload }));
  await s3.put(s3Key, payload);
  await s3Driver.put(s3DriverKey, payload);
  await azureOfficial.uploadData(payload);
  await azure.put(azureKey, payload);
  await azureDriver.put(azureDriverKey, payload);
  await s3Adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await s3Facade.writeFile("/bench.bin", payload);
  await s3Measured.writeFile("/bench.bin", payload);
  await s3Delegated.writeFile("/bench.bin", payload);
  await azureAdapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await azureFacade.writeFile("/bench.bin", payload);
  await azureMeasured.writeFile("/bench.bin", payload);
  await azureDelegated.writeFile("/bench.bin", payload);

  /** Provider timings start only after all layers return exact bytes, including large uploads. */
  expectBytes(await readAws(awsKey), payload, "AWS SDK");
  expectBytes(await toBytes(await s3.get(s3Key)), payload, "S3 client");
  expectBytes(await toBytes(await s3Driver.get(s3DriverKey)), payload, "S3 driver");
  expectBytes(new Uint8Array(await azureOfficial.downloadToBuffer()), payload, "Azure SDK");
  expectBytes(await toBytes(await azure.get(azureKey)), payload, "Azure client");
  expectBytes(await toBytes(await azureDriver.get(azureDriverKey)), payload, "Azure driver");
  expectBytes(await s3Adapter.readFile("/bench.bin"), payload, "s3Adapter");
  expectBytes(await s3Facade.readFile("/bench.bin"), payload, "s3Facade");
  expectBytes(await s3Measured.readFile("/bench.bin"), payload, "s3Measured");
  expectBytes(await s3Delegated.readFile("/bench.bin"), payload, "s3Delegated");
  expectBytes(await azureAdapter.readFile("/bench.bin"), payload, "azureAdapter");
  expectBytes(await azureFacade.readFile("/bench.bin"), payload, "azureFacade");
  expectBytes(await azureMeasured.readFile("/bench.bin"), payload, "azureMeasured");
  expectBytes(await azureDelegated.readFile("/bench.bin"), payload, "azureDelegated");
  await new Upload({
    client: aws,
    params: { Bucket: STORAGE_NAME, Key: `${prefix}/aws-multipart.bin`, Body: multipart },
    queueSize: 4,
    partSize: 5 * 1024 * 1024,
  }).done();
  expectBytes(await readAws(`${prefix}/aws-multipart.bin`), multipart, "AWS multipart");
  await s3.put(`${prefix}/s3-multipart.bin`, stream(multipart), { size: multipart.byteLength });
  expectBytes(await toBytes(await s3.get(`${prefix}/s3-multipart.bin`)), multipart, "S3 multipart");
  await azure.put(`${prefix}/azure-blocks.bin`, stream(multipart), { size: multipart.byteLength });
  expectBytes(await toBytes(await azure.get(`${prefix}/azure-blocks.bin`)), multipart, "Azure blocks");
  /** Force the same six 1 MiB blocks and four concurrent transfers as the project path. */
  const azureBlocks = azureContainer.getBlockBlobClient(`${prefix}/azure-sdk-blocks.bin`);
  const blockOptions = { blockSize: 1024 * 1024, maxSingleShotSize: 0, concurrency: 4 };
  await azureBlocks.uploadData(multipart, blockOptions);
  expectBytes(new Uint8Array(await azureBlocks.downloadToBuffer()), multipart, "Azure SDK blocks");

  bench("provider/s3 AWS SDK: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await aws.send(new PutObjectCommand({ Bucket: STORAGE_NAME, Key: awsKey, Body: payload })));
  });
  bench("provider/s3 direct client: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await s3.put(s3Key, payload));
  });
  bench("provider/s3 driver: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await s3Driver.put(s3DriverKey, payload));
  });
  bench("provider/s3 direct adapter: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await s3Adapter.writeFile("/bench.bin", payload, { mode: "replace" }));
  });
  bench("provider/s3 facade metrics none: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await s3Facade.writeFile("/bench.bin", payload));
  });
  bench("provider/s3 facade metrics basic: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await s3Measured.writeFile("/bench.bin", payload));
  });
  bench("provider/s3 facade admission delegated: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await s3Delegated.writeFile("/bench.bin", payload));
  });

  bench("provider/s3 AWS SDK: 256 KiB read", async () => {
    do_not_optimize(await readAws(awsKey));
  });
  bench("provider/s3 direct client: 256 KiB read", async () => {
    do_not_optimize(await toBytes(await s3.get(s3Key)));
  });
  bench("provider/s3 driver: 256 KiB read", async () => {
    do_not_optimize(await toBytes(await s3Driver.get(s3DriverKey)));
  });
  bench("provider/s3 direct adapter: 256 KiB read", async () => {
    do_not_optimize(await s3Adapter.readFile("/bench.bin"));
  });
  bench("provider/s3 facade metrics none: 256 KiB read", async () => {
    do_not_optimize(await s3Facade.readFile("/bench.bin"));
  });

  bench("provider/s3 AWS Upload: 6 MiB acknowledged multipart", async () => {
    do_not_optimize(
      await new Upload({
        client: aws,
        params: { Bucket: STORAGE_NAME, Key: `${prefix}/aws-multipart.bin`, Body: multipart },
        queueSize: 4,
        partSize: 5 * 1024 * 1024,
      }).done(),
    );
  });
  bench("provider/s3 direct client: 6 MiB acknowledged multipart", async () => {
    do_not_optimize(await s3.put(`${prefix}/s3-multipart.bin`, stream(multipart), { size: multipart.byteLength }));
  });

  bench("provider/azure official SDK: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await azureOfficial.uploadData(payload));
  });
  bench("provider/azure direct client: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await azure.put(azureKey, payload));
  });
  bench("provider/azure driver: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await azureDriver.put(azureDriverKey, payload));
  });
  bench("provider/azure direct adapter: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await azureAdapter.writeFile("/bench.bin", payload, { mode: "replace" }));
  });
  bench("provider/azure facade metrics none: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await azureFacade.writeFile("/bench.bin", payload));
  });
  bench("provider/azure facade metrics basic: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await azureMeasured.writeFile("/bench.bin", payload));
  });
  bench("provider/azure facade admission delegated: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await azureDelegated.writeFile("/bench.bin", payload));
  });

  bench("provider/azure official SDK: 256 KiB read", async () => {
    do_not_optimize(await azureOfficial.downloadToBuffer());
  });
  bench("provider/azure direct client: 256 KiB read", async () => {
    do_not_optimize(await toBytes(await azure.get(azureKey)));
  });
  bench("provider/azure driver: 256 KiB read", async () => {
    do_not_optimize(await toBytes(await azureDriver.get(azureDriverKey)));
  });
  bench("provider/azure direct adapter: 256 KiB read", async () => {
    do_not_optimize(await azureAdapter.readFile("/bench.bin"));
  });
  bench("provider/azure facade metrics none: 256 KiB read", async () => {
    do_not_optimize(await azureFacade.readFile("/bench.bin"));
  });

  bench("provider/azure official SDK: 6 MiB acknowledged blocks", async () => {
    do_not_optimize(await azureBlocks.uploadData(multipart, blockOptions));
  });

  bench("provider/azure direct client: 6 MiB acknowledged blocks", async () => {
    do_not_optimize(await azure.put(`${prefix}/azure-blocks.bin`, stream(multipart), { size: multipart.byteLength }));
  });

  if (env.OPFS_PROVIDER_VERIFY === "1") {
    console.log(
      "Untimed provider verification complete: Node AWS/Azure/project acknowledgement and byte preflights; no Mitata timings.",
    );
  } else {
    await report();
  }
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish([
    () => aws.destroy(),
    () => s3Facade.close(),
    () => s3Measured.close(),
    () => s3Delegated.close(),
    () => azureFacade.close(),
    () => azureMeasured.close(),
    () => azureDelegated.close(),
  ], failed ? [primary] : []);
}
