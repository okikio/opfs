// Node's valid bench-ftruncateSync workload, MIT licensed. See tests/upstream/provenance.json.
import { closeSync, fstatSync, ftruncateSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "node:process";
import { deepStrictEqual } from "node:assert/strict";
import { bench, do_not_optimize, group } from "mitata";
import { createFileSystem } from "../mod.ts";
import { createNodeDriver } from "../src/driver/node.ts";
import { createNodeAdapter } from "../src/adapter/node.ts";
import { finish, report } from "./result.ts";
import { inspect } from "../tests/upstream/provenance.ts";

/** Equivalent preopened positional resource required by all four layers. */
interface FileType {
  truncate(size: number): void;
  getSize(): number;
  read(buffer: Uint8Array<ArrayBuffer>, options: { at: number }): number;
  close(): void;
}

/** Node's original valid branch performs ten thousand repeated truncates to four bytes. */
const count = 10_000;
const provenance = await inspect();
const root = mkdtempSync(join(tmpdir(), "opfs-upstream-bench-"));
const releases: Array<() => void | Promise<void>> = [
  async () => {
    deepStrictEqual(await inspect(), provenance, "Upstream source/license bytes changed during collection.");
  },
  () => rmSync(root, { recursive: true, force: true }),
];
let failed = false;
let primary: unknown;
try {
  const lanes: Array<{ name: string; file: FileType }> = [];
  for (const name of ["native", "driver", "adapter", "facade"] as const) {
    const path = `/${name}.txt`;
    const host = join(root, `${name}.txt`);
    writeFileSync(host, "Some content.");
    let file: FileType;
    if (name === "native") {
      const fd = openSync(host, "r+");
      file = {
        truncate: (size) => ftruncateSync(fd, size),
        getSize: () => fstatSync(fd).size,
        read: (bytes, options) => readSync(fd, bytes, 0, bytes.byteLength, options.at),
        close: () => closeSync(fd),
      };
    } else if (name === "driver") {
      const driver = createNodeDriver({ root });
      releases.push(() => driver.dispose?.());
      if (driver.openSyncFile === undefined) throw new Error("Node driver sync route is unavailable.");
      file = await driver.openSyncFile(path);
    } else if (name === "adapter") {
      const adapter = createNodeAdapter({ root });
      releases.push(() => adapter.dispose?.());
      if (adapter.openSyncFile === undefined) throw new Error("Node adapter sync route is unavailable.");
      file = await adapter.openSyncFile(path);
    } else {
      const fileSystem = createFileSystem(createNodeAdapter({ root }), { metrics: "none", coordination: "none" });
      releases.push(() => fileSystem.close());
      file = await fileSystem.openSyncFile(path);
    }
    releases.push(() => file.close());
    // Independent original-byte oracle runs before the steady-state benchmark.
    file.truncate(4);
    deepStrictEqual(file.getSize(), 4, `${name}: truncate length`);
    const bytes = new Uint8Array(4);
    deepStrictEqual(file.read(bytes, { at: 0 }), 4, `${name}: consumed byte count`);
    deepStrictEqual(bytes, new TextEncoder().encode("Some"), `${name}: retained original prefix`);
    lanes.push({ name, file });
  }
  if (env.OPFS_UPSTREAM_VERIFY === "1") {
    console.log(
      JSON.stringify({ upstream: "Node bench-ftruncateSync / valid", count, verified: lanes.map(({ name }) => name) }),
    );
  } else {
    group("Node upstream ftruncateSync / valid / 10000 calls / already four bytes", () => {
      for (const { name, file } of lanes) {
        bench(`node/${name}/sync truncate`, () => {
          for (let index = 0; index < count; index++) file.truncate(4);
          do_not_optimize(file.getSize());
        });
      }
    });
    await report();
  }
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(releases, failed ? [primary] : []);
}
