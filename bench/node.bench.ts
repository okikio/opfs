import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as createPayload, report } from "./result.ts";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSystem } from "../mod.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";

/** Temporary benchmark root that keeps raw, adapter, and facade data isolated. */
const root = await mkdtemp(join(tmpdir(), "okikio-opfs-bench-"));
/** Register acquired resources before any fallible setup or oracle. */
const cleanups: Array<() => void | Promise<void>> = [() => rm(root, { recursive: true, force: true })];
let failed = false;
let primary: unknown;
try {
  /** Host directory used by the direct runtime filesystem baseline. */
  const rawRoot = join(root, "raw");
  /** Host directory used by direct adapter operations. */
  const adapterRoot = join(root, "adapter");
  /** Host directory used by the facade with coordination disabled. */
  const noneRoot = join(root, "none");
  /** Host directory used by the facade with local coordination enabled. */
  const localRoot = join(root, "local");
  await Promise.all([rawRoot, adapterRoot, noneRoot, localRoot].map((path) => mkdir(path, { recursive: true })));

  /** Fixed-size payload shared by every benchmark path so byte volume stays comparable. */
  const payload = createPayload(64 * 1024);
  /** Concrete host path used by the direct filesystem baseline. */
  const rawPath = join(rawRoot, "bench.bin");
  /** Direct runtime adapter measured without the filesystem facade. */
  const adapter = createNodeAdapter({ root: adapterRoot });
  /** Filesystem facade measured with coordination disabled. */
  const none = createFileSystem(createNodeAdapter({ root: noneRoot }), { coordination: "none", metrics: "none" });
  cleanups.push(() => none.close());
  /** Filesystem facade measured with same-realm local coordination. */
  const local = createFileSystem(createNodeAdapter({ root: localRoot }), { coordination: "local", metrics: "none" });
  cleanups.push(() => local.close());

  /** Exact content is checked outside the timed callbacks. */
  await writeFile(rawPath, payload);
  expectBytes(new Uint8Array(await readFile(rawPath)), payload, "node/raw");
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  expectBytes(await adapter.readFile("/bench.bin"), payload, "node/adapter");
  await none.writeFile("/bench.bin", payload);
  expectBytes(await none.readFile("/bench.bin"), payload, "node/none");
  await local.writeFile("/bench.bin", payload);
  expectBytes(await local.readFile("/bench.bin"), payload, "node/local");

  bench("node/raw fs: 64 KiB replace + read", async () => {
    await writeFile(rawPath, payload);
    do_not_optimize(await readFile(rawPath));
  });

  bench("node/adapter: 64 KiB replace + read", async () => {
    await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
    do_not_optimize(await adapter.readFile("/bench.bin"));
  });

  bench("node/facade none: 64 KiB replace + read", async () => {
    await none.writeFile("/bench.bin", payload);
    do_not_optimize(await none.readFile("/bench.bin"));
  });

  bench("node/facade local: 64 KiB replace + read", async () => {
    await local.writeFile("/bench.bin", payload);
    do_not_optimize(await local.readFile("/bench.bin"));
  });

  await writeFile(join(rawRoot, "source.bin"), payload);
  await adapter.writeFile("/source.bin", payload, { mode: "replace" });
  await none.writeFile("/source.bin", payload);

  bench("node/raw fs: 64 KiB native copy", async () => {
    await copyFile(join(rawRoot, "source.bin"), join(rawRoot, "copy.bin"));
  });

  bench("node/adapter: 64 KiB native copy", async () => {
    await adapter.copy!("/source.bin", "/copy.bin", { overwrite: true });
  });

  bench("node/facade: 64 KiB native copy", async () => {
    await none.copy("/source.bin", "/copy.bin", { overwrite: true });
  });

  await adapter.copy!("/source.bin", "/copy.bin", { overwrite: true });
  expectBytes(await adapter.readFile("/copy.bin"), payload, "native adapter copy");
  await none.copy("/source.bin", "/copy.bin", { overwrite: true });
  expectBytes(await none.readFile("/copy.bin"), payload, "native facade copy");
  await copyFile(join(rawRoot, "source.bin"), join(rawRoot, "copy.bin"));
  expectBytes(new Uint8Array(await readFile(join(rawRoot, "copy.bin"))), payload, "native Node copy");

  await report();
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(cleanups, failed ? [primary] : []);
}
