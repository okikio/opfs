/** Exact byte workflows against real, container-owned FUSE mounts. */
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFileSystem } from "../../mod.ts";
import { createFileAdapter } from "../../src/adapter/file.ts";
import { createNodeDriver } from "../../src/driver/node.ts";

const results = [];
function bytes(actual, expected) {
  if (actual.byteLength !== expected.byteLength) {
    throw new Error(`Length ${actual.byteLength} != ${expected.byteLength}`);
  }
  for (let index = 0; index < expected.byteLength; index++) {
    if (actual[index] !== expected[index]) throw new Error(`Byte mismatch at ${index}`);
  }
}
async function check(client, name, action) {
  try {
    await action();
    results.push({ client, name, status: "pass" });
  } catch (error) {
    results.push({ client, name, status: "fail", code: error.code, reason: error.message });
  }
}
for (
  const [name, mounted] of [["mountpoint", process.env.OPFS_MOUNTPOINT_S3_ROOT], [
    "blobfuse",
    process.env.OPFS_BLOBFUSE_ROOT,
  ]]
) {
  if (!mounted) continue;
  const root = join(mounted, `reliability-${crypto.randomUUID()}`);
  await mkdir(root, { recursive: true });
  const driver = createNodeDriver({ root }),
    adapter = createFileAdapter(driver),
    filesystem = createFileSystem(adapter, { coordination: "local", metrics: "none" });
  const payload = Uint8Array.from({ length: 256 * 1024 }, (_, index) => (index * 29 + 17) % 251);
  try {
    await check(name, "raw create + read + stat", async () => {
      await writeFile(join(root, "raw.bin"), payload, { flag: "wx" });
      bytes(await readFile(join(root, "raw.bin")), payload);
      if ((await stat(join(root, "raw.bin"))).size !== payload.length) throw new Error("Incorrect file size");
    });
    await check(name, "native Node driver create/read", async () => {
      await driver.writeFile("/driver.bin", payload, { mode: "replace" });
      bytes(await driver.readFile("/driver.bin"), payload);
    });
    await check(name, "file adapter create/read", async () => {
      await adapter.writeFile("/adapter.bin", payload, { mode: "replace" });
      bytes(await adapter.readFile("/adapter.bin"), payload);
    });
    await check(name, "facade create/read/range", async () => {
      await filesystem.writeFile("/facade.bin", payload);
      bytes(await filesystem.readFile("/facade.bin"), payload);
      bytes(await filesystem.readFile("/facade.bin", { at: 4093, length: 32777 }), payload.slice(4093, 4093 + 32777));
    });
    await check(name, "facade zero bytes and Unicode filename", async () => {
      await filesystem.writeFile("/日本語-🦖.bin", new Uint8Array());
      bytes(await filesystem.readFile("/日本語-🦖.bin"), new Uint8Array());
    });
    await check(name, "facade copy reads exact destination", async () => {
      await filesystem.copy("/facade.bin", "/copy.bin");
      bytes(await filesystem.readFile("/copy.bin"), payload);
    });
    await check(name, "facade streamed create", async () => {
      const source = new ReadableStream({
        start(controller) {
          controller.enqueue(payload.subarray(0, 8191));
          controller.enqueue(payload.subarray(8191));
          controller.close();
        },
      });
      await filesystem.writeFile("/stream.bin", source);
      bytes(await filesystem.readFile("/stream.bin"), payload);
    });
    await check(name, "facade missing file has stable error", async () => {
      try {
        await filesystem.readFile("/missing.bin");
        throw new Error("Missing file unexpectedly exists");
      } catch (error) {
        if (error.code !== "not-found") throw error;
      }
    });
    await check(name, "five concurrent creates retain exact bytes", async () => {
      await Promise.all(Array.from({ length: 5 }, async (_, index) => {
        const data = payload.slice();
        data[0] = index;
        const path = `/concurrent-${index}.bin`;
        await filesystem.writeFile(path, data);
        bytes(await filesystem.readFile(path), data);
      }));
    });
    await check(name, "stalled producer abort releases source and path lock", async () => {
      let canceled = 0;
      const started = Promise.withResolvers();
      const controller = new AbortController(),
        source = new ReadableStream({
          pull() {
            started.resolve();
            return new Promise(() => {});
          },
          cancel() {
            canceled++;
          },
        }, { highWaterMark: 0 });
      const promise = filesystem.writeFile("/aborted.bin", source, { signal: controller.signal });
      let admissionDeadline;
      try {
        await Promise.race([
          started.promise,
          promise,
          new Promise((_, reject) => {
            admissionDeadline = setTimeout(() => reject(new Error("Producer admission exceeded 5000ms")), 5000);
          }),
        ]);
      } catch (error) {
        controller.abort(error);
        throw error;
      } finally {
        clearTimeout(admissionDeadline);
      }
      controller.abort(new Error("Caller canceled"));
      let deadline;
      try {
        await Promise.race([
          promise,
          new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error("Abort exceeded 1500ms")), 1500);
          }),
        ]);
        throw new Error("Aborted write resolved");
      } catch (error) {
        if (error.code !== "aborted") throw error;
      } finally {
        clearTimeout(deadline);
      }
      if (source.locked || canceled !== 1) {
        throw new Error(`Source ownership: locked=${source.locked}, cancel=${canceled}`);
      }
      await filesystem.writeFile("/aborted.bin", new Uint8Array([1, 2, 3]));
      bytes(await filesystem.readFile("/aborted.bin"), new Uint8Array([1, 2, 3]));
    });
    // Mountpoint deliberately exposes sequential object creation, not POSIX append.
    await check(name, "documented append semantics", async () => {
      if (name === "mountpoint") {
        try {
          await appendFile(join(root, "raw.bin"), new Uint8Array([99]));
          throw new Error("Mountpoint unexpectedly supported append; update capability evidence");
        } catch (error) {
          if (!error.code || !["EPERM", "EINVAL", "ENOSYS", "EOPNOTSUPP"].includes(error.code)) throw error;
          results.push({ client: name, name: "append rejection", status: "observed", code: error.code });
        }
      } else {
        await filesystem.writeFile("/append.bin", new Uint8Array([1, 2]));
        await filesystem.writeFile("/append.bin", new Uint8Array([3]), { mode: "append" });
        bytes(await filesystem.readFile("/append.bin"), new Uint8Array([1, 2, 3]));
      }
    });
  } finally {
    await filesystem.close();
    await rm(root, { recursive: true, force: true }).catch((error) =>
      results.push({
        client: name,
        name: "cleanup",
        status: name === "mountpoint" && error.code === "EPERM" && error.syscall === "rmdir" && error.path === root
          ? "observed"
          : "fail",
        code: error.code,
        reason: error.message,
      })
    );
  }
}
if (results.length === 0) throw new Error("No provider filesystem mounted; nothing was tested.");
console.log(JSON.stringify({ results, failures: results.filter((value) => value.status === "fail").length }));
process.exitCode = results.some((value) => value.status === "fail") ? 1 : 0;
