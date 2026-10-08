import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as createPayload, report } from "./result.ts";

import { createFileSystem } from "../mod.ts";
import { createDenoAdapter } from "../src/adapter/deno.ts";

/** Temporary benchmark root that keeps raw, adapter, and facade data isolated. */
const root = await Deno.makeTempDir({ prefix: "okikio-opfs-bench-" });
/** Register acquired resources before any fallible setup or oracle. */
const cleanups: Array<() => void | Promise<void>> = [() => Deno.remove(root, { recursive: true })];
let failed = false;
let primary: unknown;
try {
  /** Host directory used by the direct runtime filesystem baseline. */
  const rawRoot = `${root}/raw`;
  /** Host directory used by direct adapter operations. */
  const adapterRoot = `${root}/adapter`;
  /** Host directory used by the facade with coordination disabled. */
  const noneRoot = `${root}/none`;
  /** Host directory used by the facade with local coordination enabled. */
  const localRoot = `${root}/local`;
  for (const path of [rawRoot, adapterRoot, noneRoot, localRoot]) await Deno.mkdir(path, { recursive: true });

  /** Fixed-size payload shared by every benchmark path so byte volume stays comparable. */
  const payload = createPayload(64 * 1024);
  /** Concrete host path used by the direct filesystem baseline. */
  const rawPath = `${rawRoot}/bench.bin`;
  /** Direct runtime adapter measured without the filesystem facade. */
  const adapter = createDenoAdapter({ root: adapterRoot });
  /** Filesystem facade measured with coordination disabled. */
  const none = createFileSystem(createDenoAdapter({ root: noneRoot }), { coordination: "none", metrics: "none" });
  cleanups.push(() => none.close());
  /** Filesystem facade measured with same-realm local coordination. */
  const local = createFileSystem(createDenoAdapter({ root: localRoot }), { coordination: "local", metrics: "none" });
  cleanups.push(() => local.close());

  /** Exact content is checked outside the timed callbacks. */
  await Deno.writeFile(rawPath, payload);
  expectBytes(await Deno.readFile(rawPath), payload, "deno/raw");
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  expectBytes(await adapter.readFile("/bench.bin"), payload, "deno/adapter");
  await none.writeFile("/bench.bin", payload);
  expectBytes(await none.readFile("/bench.bin"), payload, "deno/none");
  await local.writeFile("/bench.bin", payload);
  expectBytes(await local.readFile("/bench.bin"), payload, "deno/local");

  bench("deno/raw fs: 64 KiB replace + read", async () => {
    await Deno.writeFile(rawPath, payload);
    do_not_optimize(await Deno.readFile(rawPath));
  });

  bench("deno/adapter: 64 KiB replace + read", async () => {
    await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
    do_not_optimize(await adapter.readFile("/bench.bin"));
  });

  bench("deno/facade none: 64 KiB replace + read", async () => {
    await none.writeFile("/bench.bin", payload);
    do_not_optimize(await none.readFile("/bench.bin"));
  });

  bench("deno/facade local: 64 KiB replace + read", async () => {
    await local.writeFile("/bench.bin", payload);
    do_not_optimize(await local.readFile("/bench.bin"));
  });

  await Deno.writeFile(`${rawRoot}/source.bin`, payload);
  await adapter.writeFile("/source.bin", payload, { mode: "replace" });
  await none.writeFile("/source.bin", payload);

  bench("deno/raw fs: 64 KiB native copy", async () => {
    await Deno.copyFile(`${rawRoot}/source.bin`, `${rawRoot}/copy.bin`);
  });

  bench("deno/adapter: 64 KiB native copy", async () => {
    await adapter.copy!("/source.bin", "/copy.bin", { overwrite: true });
  });

  bench("deno/facade: 64 KiB native copy", async () => {
    await none.copy("/source.bin", "/copy.bin", { overwrite: true });
  });

  await adapter.copy!("/source.bin", "/copy.bin", { overwrite: true });
  expectBytes(await adapter.readFile("/copy.bin"), payload, "native adapter copy");
  await none.copy("/source.bin", "/copy.bin", { overwrite: true });
  expectBytes(await none.readFile("/copy.bin"), payload, "native facade copy");
  await Deno.copyFile(`${rawRoot}/source.bin`, `${rawRoot}/copy.bin`);
  expectBytes(await Deno.readFile(`${rawRoot}/copy.bin`), payload, "native Deno copy");

  await report();
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(cleanups, failed ? [primary] : []);
}
