import { bench, run } from "mitata";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSystem } from "../mod.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";

/** Temporary benchmark root that keeps raw, adapter, and facade data isolated. */
const root = await mkdtemp(join(tmpdir(), "okikio-opfs-bench-"));
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
const payload = new Uint8Array(64 * 1024);
/** Concrete host path used by the direct filesystem baseline. */
const rawPath = join(rawRoot, "bench.bin");
/** Direct runtime adapter measured without the filesystem facade. */
const adapter = createNodeAdapter({ root: adapterRoot });
/** Filesystem facade measured with coordination disabled. */
const none = createFileSystem(createNodeAdapter({ root: noneRoot }), { coordination: "none", metrics: "none" });
/** Filesystem facade measured with same-realm local coordination. */
const local = createFileSystem(createNodeAdapter({ root: localRoot }), { coordination: "local", metrics: "none" });

bench("node/raw fs: 64 KiB replace + read", async () => {
  await writeFile(rawPath, payload);
  await readFile(rawPath);
});

bench("node/adapter: 64 KiB replace + read", async () => {
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await adapter.readFile("/bench.bin");
});

bench("node/facade none: 64 KiB replace + read", async () => {
  await none.writeFile("/bench.bin", payload);
  await none.readFile("/bench.bin");
});

bench("node/facade local: 64 KiB replace + read", async () => {
  await local.writeFile("/bench.bin", payload);
  await local.readFile("/bench.bin");
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
  if (await none.exists("/copy.bin")) await none.remove("/copy.bin");
  await none.copy("/source.bin", "/copy.bin");
});

try {
  await run();
} finally {
  await none.close();
  await local.close();
  await rm(root, { recursive: true, force: true });
}
