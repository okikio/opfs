import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "node:process";

import { bench, do_not_optimize } from "mitata";
import { expectBytes, finish, payload as makePayload, report } from "./result.ts";

import { createFileSystem } from "../mod.ts";
import { createFileAdapter } from "../src/adapter/file.ts";
import { createNodeDriver } from "../src/driver/node.ts";

/** Payload small enough to keep abstraction overhead visible while still exercising real I/O. */
const payload = makePayload(256 * 1024);
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

  try {
    await writeFile(rawRead, payload);
    await driver.writeFile(driverRead, payload, { mode: "replace" });
    await adapter.writeFile(adapterRead, payload, { mode: "replace" });
    await fileSystem.writeFile(facadeRead, payload);

    expectBytes(new Uint8Array(await readFile(rawRead)), payload, `${name}/mount`);
    expectBytes(await driver.readFile(driverRead), payload, `${name}/driver`);
    expectBytes(await adapter.readFile(adapterRead), payload, `${name}/adapter`);
    expectBytes(await fileSystem.readFile(facadeRead), payload, `${name}/facade`);

    // Unique creates are independently checked before the read/write callbacks are registered.
    const preflight = [
      ["raw", async (path: string) => {
        await writeFile(join(root, path.slice(1)), payload, { flag: "wx" });
        return await readFile(join(root, path.slice(1)));
      }],
      ["driver", async (path: `/${string}`) => {
        await driver.writeFile(path, payload, { mode: "replace" });
        return await driver.readFile(path);
      }],
      ["adapter", async (path: `/${string}`) => {
        await adapter.writeFile(path, payload, { mode: "replace" });
        return await adapter.readFile(path);
      }],
      ["facade", async (path: `/${string}`) => {
        await fileSystem.writeFile(path, payload);
        return await fileSystem.readFile(path);
      }],
    ] as const;
    for (const [lane, create] of preflight) {
      const path = `/preflight-${lane}.bin` as const;
      expectBytes(new Uint8Array(await create(path)), payload, `${name}/${lane} unique create`);
      if ((await stat(join(root, path.slice(1)))).size !== payload.length) {
        throw new Error(`${name}/${lane}: create size differs.`);
      }
    }
    return { name, root, driver, adapter, fileSystem, rawRead, driverRead, adapterRead, facadeRead, writes: 0 };
  } catch (error) {
    await finish([() => removeNamespace(name, root), () => fileSystem.close()], [error]);
    throw error;
  }
}

let failed = false;
let primary: unknown;
try {
  for (const [name, mountedRoot] of roots) {
    if (mountedRoot === undefined || mountedRoot.length === 0) continue;
    const stack = await createStack(name, mountedRoot);
    fileSystems.push(stack);

    bench(`filesystem/${name} raw client mount: 256 KiB create + stat`, async () => {
      const path = join(stack.root, `raw-write-${nextWrite(stack)}.bin`);
      await writeFile(path, payload, { flag: "wx" });
      await stat(path);
    });
    bench(`filesystem/${name} driver: 256 KiB create + stat`, async () => {
      const path = `/driver-write-${nextWrite(stack)}.bin` as const;
      await stack.driver.writeFile(path, payload, { mode: "replace" });
      await stack.driver.stat(path);
    });
    bench(`filesystem/${name} adapter: 256 KiB create + stat`, async () => {
      const path = `/adapter-write-${nextWrite(stack)}.bin` as const;
      await stack.adapter.writeFile(path, payload, { mode: "replace" });
      await stack.adapter.stat(path);
    });
    bench(`filesystem/${name} facade: 256 KiB create + stat`, async () => {
      const path = `/facade-write-${nextWrite(stack)}.bin` as const;
      await stack.fileSystem.writeFile(path, payload);
      await stack.fileSystem.stat(path);
    });

    bench(`filesystem/${name} raw client mount: 256 KiB read`, async () => {
      do_not_optimize(await readFile(stack.rawRead));
    });
    bench(`filesystem/${name} driver: 256 KiB read`, async () => {
      do_not_optimize(await stack.driver.readFile(stack.driverRead));
    });
    bench(`filesystem/${name} adapter: 256 KiB read`, async () => {
      do_not_optimize(await stack.adapter.readFile(stack.adapterRead));
    });
    bench(`filesystem/${name} facade: 256 KiB read`, async () => {
      do_not_optimize(await stack.fileSystem.readFile(stack.facadeRead));
    });
  }

  if (fileSystems.length === 0) {
    throw new Error(
      "Set OPFS_MOUNTPOINT_S3_ROOT and/or OPFS_BLOBFUSE_ROOT to an already-mounted AWS Mountpoint or Azure BlobFuse filesystem.",
    );
  }

  await report();
} catch (error) {
  failed = true;
  primary = error;
  throw error;
} finally {
  await finish(
    fileSystems.flatMap((stack) => [() => removeNamespace(stack.name, stack.root), () => stack.fileSystem.close()]),
    failed ? [primary] : [],
  );
}

/** Fail rather than accumulate unbounded objects or silently shorten Mitata's requested samples. */
function nextWrite(stack: { writes: number }): number {
  if (stack.writes >= 4096) {
    throw new Error("FUSE create workload exceeded its 1 GiB namespace limit; no valid complete measurement.");
  }
  return stack.writes++;
}

/** Mountpoint cannot remove synthetic directory entries; every other cleanup error remains a failure. */
async function removeNamespace(name: string, root: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    if (
      name === "mountpoint" && typeof error === "object" && error !== null && "code" in error &&
      error.code === "EPERM" && "syscall" in error && error.syscall === "rmdir" && "path" in error &&
      error.path === root
    ) {
      console.warn(`Mountpoint rejected synthetic directory removal after namespace cleanup: ${root}`);
      return;
    }
    throw error;
  }
}
