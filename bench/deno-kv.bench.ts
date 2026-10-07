/// <reference types="deno" />
import { bench, do_not_optimize, group } from "mitata";
import { expectBytes, finish, payload as createPayload, report } from "./result.ts";

import { createFileSystem } from "../mod.ts";
import { createDenoKvAdapter } from "../src/adapter/deno-kv.ts";
import { createDenoKvDriver } from "../src/driver/deno-kv.ts";

/** One owned directory contains the database and any SQLite journal sidecars. */
const root = await Deno.makeTempDir({ prefix: "okikio-opfs-kv-bench-" });
const path = `${root}/bench.sqlite`;
const cleanups: Array<() => void | Promise<void>> = [() => Deno.remove(root, { recursive: true })];
let failed = false;
let primary: unknown;
try {
  /** Real Deno KV database shared by raw, adapter, and facade measurements. */
  const database = await Deno.openKv(path);
  cleanups.push(() => database.close());
  // Inline records and partitioned records have different physical layouts.
  // Partition cases include immediate reclamation so retired generations do not
  // accumulate and change later samples. There are no concurrent old readers.
  for (const size of [24 * 1024, 64 * 1024]) {
    const payload = createPayload(size);
    const rawKey = ["bench", size, "raw"] as const;
    const driver = createDenoKvDriver(database, { prefix: `bench-driver-${size}` });
    const adapter = createDenoKvAdapter(database, { prefix: `bench-adapter-${size}` });
    const maintenance = createDenoKvDriver(database, { prefix: `bench-adapter-${size}` });
    const facades = (["none", "basic"] as const).map((metrics) => {
      const prefix = `bench-facade-${metrics}-${size}`;
      const fileSystem = createFileSystem(createDenoKvAdapter(database, { prefix }), {
        coordination: "none",
        metrics,
      });
      cleanups.push(() => fileSystem.close());
      return { metrics, fileSystem, maintenance: createDenoKvDriver(database, { prefix }) };
    });
    await database.set(rawKey, payload);
    const stored = await database.get<Uint8Array>(rawKey);
    if (!(stored.value instanceof Uint8Array)) throw new Error("Deno KV benchmark lost its bytes.");
    expectBytes(stored.value, payload, "deno-kv/raw");
    await driver.writeFile!("/bench.bin", payload, { mode: "replace" });
    expectBytes(await driver.readFile!("/bench.bin"), payload, "deno-kv/driver");
    await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
    expectBytes(await adapter.readFile("/bench.bin"), payload, "deno-kv/adapter");
    for (const { fileSystem } of facades) {
      await fileSystem.writeFile("/bench.bin", payload);
      expectBytes(await fileSystem.readFile("/bench.bin"), payload, "deno-kv/facade");
    }
    const reclaim = size > 32 * 1024;
    const scenario = `${size / 1024} KiB ${reclaim ? "partition replace + read + reclaim" : "inline replace + read"}`;
    group(scenario, () => {
      bench("deno-kv/raw single value: replace + get", async () => {
        await database.set(rawKey, payload);
        do_not_optimize(await database.get(rawKey));
      });
      bench("deno-kv/driver", async () => {
        await driver.writeFile!("/bench.bin", payload, { mode: "replace" });
        do_not_optimize(await driver.readFile!("/bench.bin"));
        if (reclaim) await driver.collect({ minAgeMs: 0 });
      });
      bench("deno-kv/adapter", async () => {
        await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
        do_not_optimize(await adapter.readFile("/bench.bin"));
        if (reclaim) await maintenance.collect({ minAgeMs: 0 });
      });
      for (const { metrics, fileSystem, maintenance } of facades) {
        bench(`deno-kv/facade metrics:${metrics}`, async () => {
          await fileSystem.writeFile("/bench.bin", payload);
          do_not_optimize(await fileSystem.readFile("/bench.bin"));
          if (reclaim) await maintenance.collect({ minAgeMs: 0 });
        });
      }
    });
  }

  await report();
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(cleanups, failed ? [primary] : []);
}
