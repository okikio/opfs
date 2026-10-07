import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as createPayload, report } from "./result.ts";

import { createFileSystem } from "../mod.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { createMemoryDriver } from "../src/driver/memory.ts";
import type { RecordType } from "../src/schema.ts";

/** Fixed 64 KiB payload shared by all in-memory benchmark paths. */
const payload = createPayload(64 * 1024);
/** Base64 representation used by the raw record-store baseline. */
const encoded = encodeBase64(payload);

/** Raw Map baseline with no adapter or record translation. */
const raw = new Map<string, Uint8Array>();
/** Direct RecordStore baseline used to isolate record serialization cost. */
const store = createMemoryDriver();
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

let failed = false;
let primary: unknown;
try {
  /** Exact bytes are a prerequisite for each performance lane. */
  raw.set("/bench.bin", payload.slice());
  expectBytes(raw.get("/bench.bin")!.slice(), payload, "memory/raw");
  await store.set(record);
  const stored = await store.get(record.path);
  if (stored?.kind !== "file") throw new Error("Memory driver benchmark lost its file.");
  expectBytes(decodeBase64(stored.data), payload, "memory/driver");
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  expectBytes(await adapter.readFile("/bench.bin"), payload, "memory/adapter");
  await none.writeFile("/bench.bin", payload);
  expectBytes(await none.readFile("/bench.bin"), payload, "memory/none");
  await local.writeFile("/bench.bin", payload);
  expectBytes(await local.readFile("/bench.bin"), payload, "memory/local");

  bench("memory/raw Map: 64 KiB replace + read", () => {
    raw.set("/bench.bin", payload.slice());
    do_not_optimize(raw.get("/bench.bin")!.slice());
  });

  bench("memory/driver: 64 KiB encode + set + get + decode", async () => {
    await store.set({ ...record, data: encodeBase64(payload) });
    const value = await store.get(record.path);
    if (value?.kind !== "file") throw new Error("Memory benchmark lost its file.");
    do_not_optimize(decodeBase64(value.data));
  });

  bench("memory/adapter: 64 KiB replace + read", async () => {
    await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
    do_not_optimize(await adapter.readFile("/bench.bin"));
  });

  bench("memory/facade none: 64 KiB replace + read", async () => {
    await none.writeFile("/bench.bin", payload);
    do_not_optimize(await none.readFile("/bench.bin"));
  });

  bench("memory/facade local: 64 KiB replace + read", async () => {
    await local.writeFile("/bench.bin", payload);
    do_not_optimize(await local.readFile("/bench.bin"));
  });

  await report();
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish([() => none.close(), () => local.close()], failed ? [primary] : []);
}
