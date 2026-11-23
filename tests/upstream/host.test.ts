import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileSystem } from "../../mod.ts";
import type { FileSystemType } from "../../mod.ts";
import { createMemoryAdapter } from "../../src/adapter/memory.ts";
import { createNodeAdapter } from "../../src/adapter/node.ts";
import { createDenoAdapter } from "../../src/adapter/deno.ts";
import { createBunAdapter } from "../../src/adapter/bun.ts";
import { withReleases } from "../close.ts";
import { directoryCases, runDirectoryCase, syncCases } from "./wpt.ts";
import { runtimeCases } from "./runtime.ts";

/** Selects the actual host adapter; importing other adapter modules does not acquire their runtime. */
function adapter(root: string) {
  if (Reflect.get(globalThis, "Deno") !== undefined) return createDenoAdapter({ root });
  if (Reflect.get(globalThis, "Bun") !== undefined) return createBunAdapter({ root });
  return createNodeAdapter({ root });
}

/** Deno owns its temporary-directory API; Node/Bun use their native OS temporary root. */
async function temporary(): Promise<string> {
  const deno = Reflect.get(globalThis, "Deno") as
    | { makeTempDir(options: { prefix: string }): Promise<string> }
    | undefined;
  return deno === undefined
    ? await mkdtemp(join(tmpdir(), "opfs-upstream-"))
    : await deno.makeTempDir({ prefix: "opfs-upstream-" });
}

/** Each case receives a new backend; acquired descriptors join the same owned lifetime. */
async function withFileSystem(
  backend: "memory" | "host",
  action: (
    fileSystem: FileSystemType,
    releases: Array<() => void | Promise<unknown>>,
  ) => Promise<void>,
): Promise<void> {
  await withReleases(async (releases) => {
    let root: string | undefined;
    if (backend === "host") {
      const ownedRoot = await temporary();
      root = ownedRoot;
      releases.push(() => rm(ownedRoot, { recursive: true, force: true }));
    }
    const fileSystem = createFileSystem(root === undefined ? createMemoryAdapter() : adapter(root));
    releases.push(() => fileSystem.close());
    await action(fileSystem, releases);
  });
}

for (const backend of ["memory", "host"] as const) {
  describe(`Copied upstream behavior / ${backend}`, () => {
    for (const test of directoryCases) {
      it(`WPT: ${test.name}`, async () => {
        await withFileSystem(backend, async (fileSystem) => await runDirectoryCase(test, fileSystem.root));
      });
    }
    for (const test of runtimeCases) {
      if (test.sync && backend === "memory") continue; // Memory does not expose synchronous descriptors.
      it(`${test.project}: ${test.name}`, async () => {
        await withFileSystem(backend, async (fileSystem) => await test.run(fileSystem));
      });
    }
    if (backend === "host") {
      for (const test of syncCases) {
        it(`WPT sync: ${test.name}`, async () => {
          await withFileSystem(backend, async (fileSystem, releases) => {
            await fileSystem.writeFile("/sync.bin", new Uint8Array());
            const file = await fileSystem.openSyncFile("/sync.bin");
            releases.push(() => file.close());
            test.run({}, file);
          });
        });
      }
    }
  });
}
