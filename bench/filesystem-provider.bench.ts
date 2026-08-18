import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "node:process";

import { bench, run } from "mitata";

import { createFileSystem } from "../mod.ts";
import { createFileAdapter } from "../src/adapter/file.ts";
import { createNodeDriver } from "../src/driver/node.ts";

/** Payload small enough to keep abstraction overhead visible while still exercising real I/O. */
const payload = new Uint8Array(256 * 1024).fill(23);
/** One benchmark namespace that does not collide with application objects already mounted. */
const runId = `.okikio-opfs-bench-${crypto.randomUUID()}`;

/** Configured provider filesystem clients available to this benchmark process. */
const roots = [
  ["mountpoint", env.OPFS_MOUNTPOINT_S3_ROOT],
  ["blobfuse", env.OPFS_BLOBFUSE_ROOT],
] as const;

/** Filesystem stacks that must remain open until Mitata finishes all registered cases. */
const fileSystems: Array<Awaited<ReturnType<typeof createStack>>> = [];

/** Creates raw, driver, adapter, and facade views over one already-mounted provider filesystem. */
async function createStack(name: string, mountedRoot: string) {
  const root = join(mountedRoot, runId, name);
  await mkdir(root, { recursive: true });
  const driver = createNodeDriver({ root, createRoot: true });
  const adapter = createFileAdapter(driver);
  const fileSystem = createFileSystem(adapter, { coordination: "none", metrics: "none" });
  const rawRead = join(root, "raw-read.bin");
  const driverRead = "/driver-read.bin" as const;
  const adapterRead = "/adapter-read.bin" as const;
  const facadeRead = "/facade-read.bin" as const;

  await writeFile(rawRead, payload);
  await driver.writeFile(driverRead, payload, { mode: "replace" });
  await adapter.writeFile(adapterRead, payload, { mode: "replace" });
  await fileSystem.writeFile(facadeRead, payload);

  return { name, root, driver, adapter, fileSystem, rawRead, driverRead, adapterRead, facadeRead, writes: 0 };
}

for (const [name, mountedRoot] of roots) {
  if (mountedRoot === undefined || mountedRoot.length === 0) continue;
  const stack = await createStack(name, mountedRoot);
  fileSystems.push(stack);

  bench(`filesystem/${name} raw client mount: 256 KiB create + stat`, async () => {
    const path = join(stack.root, `raw-write-${stack.writes++}.bin`);
    await writeFile(path, payload, { flag: "wx" });
    await stat(path);
  });
  bench(`filesystem/${name} driver: 256 KiB create + stat`, async () => {
    const path = `/driver-write-${stack.writes++}.bin` as const;
    await stack.driver.writeFile(path, payload, { mode: "replace" });
    await stack.driver.stat(path);
  });
  bench(`filesystem/${name} adapter: 256 KiB create + stat`, async () => {
    const path = `/adapter-write-${stack.writes++}.bin` as const;
    await stack.adapter.writeFile(path, payload, { mode: "replace" });
    await stack.adapter.stat(path);
  });
  bench(`filesystem/${name} facade: 256 KiB create + stat`, async () => {
    const path = `/facade-write-${stack.writes++}.bin` as const;
    await stack.fileSystem.writeFile(path, payload);
    await stack.fileSystem.stat(path);
  });

  bench(`filesystem/${name} raw client mount: 256 KiB read`, async () => {
    await readFile(stack.rawRead);
  });
  bench(`filesystem/${name} driver: 256 KiB read`, async () => {
    await stack.driver.readFile(stack.driverRead);
  });
  bench(`filesystem/${name} adapter: 256 KiB read`, async () => {
    await stack.adapter.readFile(stack.adapterRead);
  });
  bench(`filesystem/${name} facade: 256 KiB read`, async () => {
    await stack.fileSystem.readFile(stack.facadeRead);
  });
}

if (fileSystems.length === 0) {
  throw new Error(
    "Set OPFS_MOUNTPOINT_S3_ROOT and/or OPFS_BLOBFUSE_ROOT to an already-mounted AWS Mountpoint or Azure BlobFuse filesystem.",
  );
}

try {
  await run();
} finally {
  for (const stack of fileSystems) {
    await stack.fileSystem.close();
    await rm(stack.root, { recursive: true, force: true }).catch((error) => {
      console.warn(`Could not remove benchmark namespace '${stack.root}':`, error);
    });
  }
}
