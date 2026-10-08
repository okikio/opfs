/// <reference types="bun-types" />
import { equal } from "node:assert/strict";
import { expectReceipt, observeProvider } from "./provider-contract.ts";
import { toBytes } from "@std/streams/to-bytes";
import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as makePayload, report } from "./result.ts";

import { createFileSystem } from "../mod.ts";
import { createObjectAdapter } from "../src/adapter/object.ts";
import { createS3DriverFromClient } from "../src/driver/s3.ts";
import { createS3Client } from "../src/s3.ts";

import { S3_ACCESS_KEY, S3_LIST_ENCODING, S3_SECRET_KEY, STORAGE_NAME } from "../tests/provider/fixture.ts";

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
/** Small payload exposes request costs on the owned loopback provider. */
const payload = makePayload(256 * 1024);
/** Multipart payload exercises each streaming scheduler above the five-MiB S3 minimum. */
const multipart = makePayload(6 * 1024 * 1024);

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
  listEncoding: S3_LIST_ENCODING,
  endpoint: S3_ENDPOINT,
  bucket: BUCKET,
  region: "us-east-1",
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  request: { retries: 0 },
  metrics: "none",
  partSize: 5 * 1024 * 1024,
  concurrency: 4,
});
/** Driver layer exposes the same publication route with backend metadata and planning available. */
const driver = createS3DriverFromClient(s3);
/** Object-adapter layer adds file/directory conflict admission before publication. */
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
/** Explicit adapter admission provides the opt-in replacement comparison. */
const delegated = createFileSystem(createObjectAdapter(driver, { prefix: `${PREFIX}/delegated` }), {
  coordination: "none",
  metrics: "none",
  optimizations: { writeAdmission: true },
});

/** Stable object key reused by Bun S3 replacement/read samples. */
const bunKey = `${PREFIX}/bun.bin`;
/** Stable object key reused by direct project client samples. */
const directKey = `${PREFIX}/direct.bin`;
/** Stable object key reused by project driver samples. */
const driverKey = `${PREFIX}/driver.bin`;
/** Native Bun calls are observed over a separate untimed loopback transport. */
async function verifyPublicationContracts(): Promise<void> {
  const cleanups: (() => void | Promise<void>)[] = [];
  let failed = false;
  let primary: unknown;
  try {
    const endpoint = S3_ENDPOINT;
    if (endpoint === undefined) throw new Error("The provider fixture endpoint is missing.");
    const observer = await observeProvider(endpoint);
    cleanups.push(() => observer.close());
    const native = new bunRuntime.S3Client({
      endpoint: observer.endpoint,
      bucket: BUCKET,
      region: "us-east-1",
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
      virtualHostedStyle: false,
      retry: 0,
      partSize: 5 * 1024 * 1024,
      queueSize: 4,
    });
    const project = createS3Client({
      listEncoding: S3_LIST_ENCODING,
      endpoint: observer.endpoint,
      bucket: BUCKET,
      region: "us-east-1",
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
      request: { retries: 0 },
      metrics: "none",
      partSize: 5 * 1024 * 1024,
      concurrency: 4,
    });
    const backend = createS3DriverFromClient(project);
    const key = `${PREFIX}/oracle.bin`;
    const one = { "PUT object": 1 };
    const multiple = { "POST initiate": 1, "PUT part": 2, "POST commit": 1 };
    equal(
      await observer.check("Bun acknowledged replace", () => native.write(key, payload), one),
      payload.byteLength,
      "Bun acknowledgement reports accepted input bytes",
    );
    expectBytes(await native.file(key).bytes(), payload, "Bun acknowledged replace");
    await observer.check("Bun acknowledged multipart", async () => {
      const writer = native.file(key).writer({ partSize: 5 * 1024 * 1024, queueSize: 4, retry: 0 });
      await writer.write(multipart);
      await writer.end();
    }, multiple);
    expectBytes(await native.file(key).bytes(), multipart, "Bun acknowledged multipart");
    expectReceipt(
      await observer.check("Bun project client acknowledged replace", () => project.put(key, payload), one),
      payload,
      "Bun project client",
    );
    expectBytes(await toBytes(await project.get(key)), payload, "Bun project client");
    expectReceipt(
      await observer.check("Bun project driver acknowledged replace", () => backend.put(key, payload), one),
      payload,
      "Bun project driver",
    );
    expectBytes(await toBytes(await backend.get(key)), payload, "Bun project driver");
    expectReceipt(
      await observer.check("Bun project acknowledged multipart", () =>
        project.put(
          key,
          new ReadableStream({
            start(controller) {
              controller.enqueue(multipart);
              controller.close();
            },
          }),
          { size: multipart.byteLength },
        ), multiple),
      multipart,
      "Bun project multipart",
    );
    expectBytes(await toBytes(await project.get(key)), multipart, "Bun project multipart");
    const projected = createObjectAdapter(backend, { prefix: `${PREFIX}/oracle/adapter` });
    const fs = createFileSystem(createObjectAdapter(backend, { prefix: `${PREFIX}/oracle/facade` }), {
      coordination: "none",
      metrics: "none",
    });
    const counters = createFileSystem(createObjectAdapter(backend, { prefix: `${PREFIX}/oracle/metrics` }), {
      coordination: "none",
      metrics: "basic",
    });
    const delegated = createFileSystem(createObjectAdapter(backend, { prefix: `${PREFIX}/oracle/delegated` }), {
      coordination: "none",
      metrics: "none",
      optimizations: { writeAdmission: true },
    });
    cleanups.push(() => fs.close(), () => counters.close(), () => delegated.close());
    await projected.writeFile("/bench.bin", payload, { mode: "replace" });
    await fs.writeFile("/bench.bin", payload);
    await counters.writeFile("/bench.bin", payload);
    await delegated.writeFile("/bench.bin", payload);
    await observer.check("Bun adapter projected replace", () =>
      projected.writeFile("/bench.bin", payload, {
        mode: "replace",
      }), { "HEAD stat": 2, "GET list": 1, "PUT object": 1 });
    expectBytes(await projected.readFile("/bench.bin"), payload, "Bun adapter projected replace");
    for (
      const [label, fileSystem] of [["none", fs], ["basic", counters], ["admission-delegated", delegated]] as const
    ) {
      await observer.check(
        `Bun facade metrics ${label} projected replace`,
        () => fileSystem.writeFile("/bench.bin", payload),
        {
          "HEAD stat": label === "admission-delegated" ? 2 : 4,
          "GET list": label === "admission-delegated" ? 1 : 2,
          "PUT object": 1,
        },
      );
      expectBytes(await fileSystem.readFile("/bench.bin"), payload, `Bun facade metrics ${label} projected replace`);
    }
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
  await bun.write(bunKey, payload);
  await s3.put(directKey, payload);
  await driver.put(driverKey, payload);
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await facade.writeFile("/bench.bin", payload);
  await measured.writeFile("/bench.bin", payload);
  await delegated.writeFile("/bench.bin", payload);

  /** Real network results are checked before timed callbacks are admitted. */
  expectBytes(await bun.file(bunKey).bytes(), payload, "Bun S3");
  expectBytes(await toBytes(await s3.get(directKey)), payload, "S3 client");
  expectBytes(await toBytes(await driver.get(driverKey)), payload, "S3 driver");
  expectBytes(await adapter.readFile("/bench.bin"), payload, "adapter");
  expectBytes(await facade.readFile("/bench.bin"), payload, "facade");
  expectBytes(await measured.readFile("/bench.bin"), payload, "measured");
  expectBytes(await delegated.readFile("/bench.bin"), payload, "delegated");
  const writer = bun.file(`${PREFIX}/bun-multipart.bin`).writer({ partSize: 5 * 1024 * 1024, queueSize: 4, retry: 0 });
  await writer.write(multipart);
  await writer.end();
  expectBytes(await bun.file(`${PREFIX}/bun-multipart.bin`).bytes(), multipart, "Bun multipart");
  await s3.put(
    `${PREFIX}/direct-multipart.bin`,
    new ReadableStream({
      start(controller) {
        controller.enqueue(multipart);
        controller.close();
      },
    }),
    { size: multipart.byteLength },
  );
  expectBytes(await toBytes(await s3.get(`${PREFIX}/direct-multipart.bin`)), multipart, "S3 multipart");

  bench("provider/s3 Bun S3Client: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await bun.write(bunKey, payload));
  });
  bench("provider/s3 project direct client: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await s3.put(directKey, payload));
  });
  bench("provider/s3 project driver: 256 KiB acknowledged replace", async () => {
    do_not_optimize(await driver.put(driverKey, payload));
  });
  bench("provider/s3 project direct adapter: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await adapter.writeFile("/bench.bin", payload, { mode: "replace" }));
  });
  bench("provider/s3 project facade metrics none: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await facade.writeFile("/bench.bin", payload));
  });
  bench("provider/s3 project facade metrics basic: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await measured.writeFile("/bench.bin", payload));
  });
  bench("provider/s3 project facade admission delegated: 256 KiB projected replace acknowledged", async () => {
    do_not_optimize(await delegated.writeFile("/bench.bin", payload));
  });

  bench("provider/s3 Bun S3File: 256 KiB read", async () => {
    do_not_optimize(await bun.file(bunKey).bytes());
  });
  bench("provider/s3 project direct client: 256 KiB read", async () => {
    do_not_optimize(await toBytes(await s3.get(directKey)));
  });
  bench("provider/s3 project driver: 256 KiB read", async () => {
    do_not_optimize(await toBytes(await driver.get(driverKey)));
  });
  bench("provider/s3 project direct adapter: 256 KiB read", async () => {
    do_not_optimize(await adapter.readFile("/bench.bin"));
  });
  bench("provider/s3 project facade metrics none: 256 KiB read", async () => {
    do_not_optimize(await facade.readFile("/bench.bin"));
  });

  bench("provider/s3 Bun NetworkSink: 6 MiB acknowledged multipart", async () => {
    const key = `${PREFIX}/bun-multipart.bin`;
    const writer = bun.file(key).writer({ partSize: 5 * 1024 * 1024, queueSize: 4, retry: 0 });
    do_not_optimize(await writer.write(multipart));
    do_not_optimize(await writer.end());
  });
  bench("provider/s3 project direct client: 6 MiB acknowledged multipart", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(multipart);
        controller.close();
      },
    });
    do_not_optimize(await s3.put(`${PREFIX}/direct-multipart.bin`, source, { size: multipart.byteLength }));
  });

  if (getEnv("OPFS_PROVIDER_VERIFY") === "1") {
    console.log(
      "Untimed provider verification complete: Bun native/project acknowledgement and byte preflights; no Mitata timings.",
    );
  } else {
    await report();
  }
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish([() => facade.close(), () => measured.close(), () => delegated.close()], failed ? [primary] : []);
}
