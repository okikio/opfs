import { bench, run } from "mitata";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileSystem } from "../mod.ts";
import { createBunAdapter } from "../src/adapter/bun.ts";

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
const adapter = createBunAdapter({ root: adapterRoot });
/** Filesystem facade measured with coordination disabled. */
const none = createFileSystem(createBunAdapter({ root: noneRoot }), { coordination: "none", metrics: "none" });
/** Filesystem facade measured with same-realm local coordination. */
const local = createFileSystem(createBunAdapter({ root: localRoot }), { coordination: "local", metrics: "none" });

bench("bun/raw file: 64 KiB replace + read", async () => {
  await Bun.write(rawPath, payload);
  await Bun.file(rawPath).bytes();
});

bench("bun/adapter: 64 KiB replace + read", async () => {
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await adapter.readFile("/bench.bin");
});

bench("bun/facade none: 64 KiB replace + read", async () => {
  await none.writeFile("/bench.bin", payload);
  await none.readFile("/bench.bin");
});

bench("bun/facade local: 64 KiB replace + read", async () => {
  await local.writeFile("/bench.bin", payload);
  await local.readFile("/bench.bin");
});

await Bun.write(join(rawRoot, "source.bin"), payload);
await adapter.writeFile("/source.bin", payload, { mode: "replace" });
await none.writeFile("/source.bin", payload);

bench("bun/raw node fs: 64 KiB copyFile", async () => {
  await copyFile(join(rawRoot, "source.bin"), join(rawRoot, "copy-node.bin"));
});

bench("bun/raw Bun.write: 64 KiB BunFile copy", async () => {
  await Bun.write(join(rawRoot, "copy-bun.bin"), Bun.file(join(rawRoot, "source.bin")));
});

bench("bun/adapter: 64 KiB native copy", async () => {
  await adapter.copy!("/source.bin", "/copy.bin", { overwrite: true });
});

bench("bun/facade: 64 KiB native copy", async () => {
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
