/// <reference types="deno" />
import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createDenoKvAdapter } from "../src/adapter/deno-kv.ts";

/** Temporary on-disk Deno KV location used only for this benchmark run. */
const path = await Deno.makeTempFile({ prefix: "okikio-opfs-kv-bench-" });
await Deno.remove(path);
/** Real Deno KV database shared by raw, adapter, and facade measurements. */
const database = await Deno.openKv(path);
/** Fixed 64 KiB payload used by every Deno KV path. */
const payload = new Uint8Array(64 * 1024);
/** Deno KV key used by the direct backend baseline. */
const rawKey = ["bench", "raw"] as const;
/** Direct Deno KV adapter measured without facade overhead. */
const adapter = createDenoKvAdapter(database, { prefix: "bench-adapter" });
/** Filesystem facade backed by the same Deno KV database with coordination disabled. */
const fileSystem = createFileSystem(createDenoKvAdapter(database, { prefix: "bench-facade" }), {
  coordination: "none",
  metrics: "none",
});

bench("deno-kv/raw: 64 KiB replace + get", async () => {
  await database.set(rawKey, payload);
  await database.get(rawKey);
});

bench("deno-kv/adapter: 64 KiB replace + read", async () => {
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await adapter.readFile("/bench.bin");
});

bench("deno-kv/facade: 64 KiB replace + read", async () => {
  await fileSystem.writeFile("/bench.bin", payload);
  await fileSystem.readFile("/bench.bin");
});

try {
  await run();
} finally {
  await fileSystem.close();
  database.close();
  await Deno.remove(path).catch(() => undefined);
}
