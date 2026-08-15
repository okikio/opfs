import { encodeBase64 } from "@std/encoding/base64";
import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createMemoryAdapter, createMemoryRecordStore } from "../src/adapter/memory.ts";
import type { RecordType } from "../src/schema.ts";

/** Fixed 64 KiB payload shared by all in-memory benchmark paths. */
const payload = new Uint8Array(64 * 1024);
/** Base64 representation used by the raw record-store baseline. */
const encoded = encodeBase64(payload);

/** Raw Map baseline with no adapter or record translation. */
const raw = new Map<string, Uint8Array>();
/** Direct RecordStore baseline used to isolate record serialization cost. */
const store = createMemoryRecordStore();
/** Canonical file record written directly to the RecordStore baseline. */
const record: RecordType = {
  version: 1,
  path: "/bench.bin",
  parent: "/",
  name: "bench.bin",
  kind: "file",
  data: encoded,
  size: payload.byteLength,
  lastModified: 0,
  mediaType: "application/octet-stream",
};

/** Direct memory adapter measured without facade coordination. */
const adapter = createMemoryAdapter();
/** Memory-backed filesystem facade measured with coordination disabled. */
const none = createFileSystem(createMemoryAdapter(), { coordination: "none", metrics: "none" });
/** Memory-backed filesystem facade measured with local coordination enabled. */
const local = createFileSystem(createMemoryAdapter(), { coordination: "local", metrics: "none" });

bench("memory/raw Map: 64 KiB replace + read", () => {
  raw.set("/bench.bin", payload.slice());
  raw.get("/bench.bin")!.slice();
});

bench("memory/RecordStore: 64 KiB set + get", async () => {
  await store.set(record);
  await store.get(record.path);
});

bench("memory/adapter: 64 KiB replace + read", async () => {
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await adapter.readFile("/bench.bin");
});

bench("memory/facade none: 64 KiB replace + read", async () => {
  await none.writeFile("/bench.bin", payload);
  await none.readFile("/bench.bin");
});

bench("memory/facade local: 64 KiB replace + read", async () => {
  await local.writeFile("/bench.bin", payload);
  await local.readFile("/bench.bin");
});

await run();
await none.close();
await local.close();
