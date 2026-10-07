/// <reference types="deno" />
import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as createPayload, report } from "./result.ts";

import { createFileSystem } from "../mod.ts";
import { createDenoKvAdapter } from "../src/adapter/deno-kv.ts";

/** Temporary on-disk Deno KV location used only for this benchmark run. */
const path = await Deno.makeTempFile({ prefix: "okikio-opfs-kv-bench-" });
/** A failed open may leave no file; only that specific missing-path condition is harmless. */
const cleanups: Array<() => void | Promise<void>> = [async () => {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}];
let failed = false;
let primary: unknown;
try {
  await Deno.remove(path);
  /** Real Deno KV database shared by raw, adapter, and facade measurements. */
  const database = await Deno.openKv(path);
  cleanups.push(() => database.close());
  /** Fixed 64 KiB payload used by every Deno KV path. */
  const payload = createPayload(64 * 1024);
  /** Deno KV key used by the direct backend baseline. */
  const rawKey = ["bench", "raw"] as const;
  /** Direct Deno KV adapter measured without facade overhead. */
  const adapter = createDenoKvAdapter(database, { prefix: "bench-adapter" });
  /** Filesystem facade backed by the same Deno KV database with coordination disabled. */
  const fileSystem = createFileSystem(createDenoKvAdapter(database, { prefix: "bench-facade" }), {
    coordination: "none",
    metrics: "none",
  });
  cleanups.push(() => fileSystem.close());

  /** Exact content is checked outside the timed callbacks. */
  await database.set(rawKey, payload);
  const stored = await database.get<Uint8Array>(rawKey);
  if (!(stored.value instanceof Uint8Array)) throw new Error("Deno KV benchmark lost its bytes.");
  expectBytes(stored.value, payload, "deno-kv/raw");
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  expectBytes(await adapter.readFile("/bench.bin"), payload, "deno-kv/adapter");
  await fileSystem.writeFile("/bench.bin", payload);
  expectBytes(await fileSystem.readFile("/bench.bin"), payload, "deno-kv/fileSystem");

  bench("deno-kv/raw: 64 KiB replace + get", async () => {
    await database.set(rawKey, payload);
    do_not_optimize(await database.get(rawKey));
  });

  bench("deno-kv/adapter: 64 KiB replace + read", async () => {
    await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
    do_not_optimize(await adapter.readFile("/bench.bin"));
  });

  bench("deno-kv/facade: 64 KiB replace + read", async () => {
    await fileSystem.writeFile("/bench.bin", payload);
    do_not_optimize(await fileSystem.readFile("/bench.bin"));
  });

  await report();
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(cleanups, failed ? [primary] : []);
}
