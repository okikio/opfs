import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createDenoAdapter } from "../src/adapter/deno.ts";

/** Temporary benchmark root that keeps raw, adapter, and facade data isolated. */
const root = await Deno.makeTempDir({ prefix: "okikio-opfs-bench-" });
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
const payload = new Uint8Array(64 * 1024);
/** Concrete host path used by the direct filesystem baseline. */
const rawPath = `${rawRoot}/bench.bin`;
/** Direct runtime adapter measured without the filesystem facade. */
const adapter = createDenoAdapter({ root: adapterRoot });
/** Filesystem facade measured with coordination disabled. */
const none = createFileSystem(createDenoAdapter({ root: noneRoot }), { coordination: "none", metrics: "none" });
/** Filesystem facade measured with same-realm local coordination. */
const local = createFileSystem(createDenoAdapter({ root: localRoot }), { coordination: "local", metrics: "none" });

bench("deno/raw fs: 64 KiB replace + read", async () => {
  await Deno.writeFile(rawPath, payload);
  await Deno.readFile(rawPath);
});

bench("deno/adapter: 64 KiB replace + read", async () => {
  await adapter.writeFile("/bench.bin", payload, { mode: "replace" });
  await adapter.readFile("/bench.bin");
});

bench("deno/facade none: 64 KiB replace + read", async () => {
  await none.writeFile("/bench.bin", payload);
  await none.readFile("/bench.bin");
});

bench("deno/facade local: 64 KiB replace + read", async () => {
  await local.writeFile("/bench.bin", payload);
  await local.readFile("/bench.bin");
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
  if (await none.exists("/copy.bin")) await none.remove("/copy.bin");
  await none.copy("/source.bin", "/copy.bin");
});

try {
  await run();
} finally {
  await none.close();
  await local.close();
  await Deno.remove(root, { recursive: true });
}
