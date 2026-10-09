import { expect } from "@std/expect";
import { platform } from "node:os";

import { createFileSystem } from "../mod.ts";
import type { AdapterType } from "../src/adapter/definition.ts";
import { defineAdapter } from "../src/adapter/definition.ts";
import type { FileSystemType } from "../src/filesystem.ts";
import { withReleases } from "./close.ts";
import { verifyBytes, verifyPendingAbort, within } from "./reliability.ts";

/** Collects one host-driver stream without routing the assertion through `Response`. */
async function bytes(source: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = source.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parts.push(next.value);
      size += next.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/**
 * Verifies host-file semantics that differ materially from the portable memory backend.
 *
 * The portable memory suite cannot prove these operations because a record store
 * deletes files and directories through the same primitive. Native host APIs do
 * not. This shared scenario therefore runs against Deno, Node, and Bun so an
 * empty-directory primitive, recursive facade removal, and overwrite cleanup all
 * exercise the runtime's actual filesystem implementation.
 */
export async function verifyHost(fileSystem: FileSystemType): Promise<void> {
  // Windows rejects '?' in native names; other backends retain the default
  // URL-sensitive fixture rather than inheriting this host-only constraint.
  await verifyBytes(fileSystem, "/bytes", platform() === "win32" ? "世界 %#.bin" : "世界 %?#.bin");
  await verifyPendingAbort(fileSystem);
  // Append with a final truncate needs mutable-file rights, including empty
  // input. These actual host cases exercise native and signal-aware routes.
  for (const existing of [false, true]) {
    for (const source of ["bytes", "stream"] as const) {
      for (const empty of [false, true]) {
        for (const signalled of [false, true]) {
          const path = `/append-${existing}-${source}-${empty}-${signalled}.bin`;
          if (existing) await fileSystem.writeFile(path, new Uint8Array([1, 2]));
          const data = empty ? new Uint8Array(0) : new Uint8Array([3, 4, 5]);
          const input = source === "bytes" ? data : new ReadableStream<Uint8Array>({
            start(controller) {
              if (!empty) {
                controller.enqueue(data.subarray(0, 2));
                controller.enqueue(data.subarray(2));
              }
              controller.close();
            },
          });
          await fileSystem.writeFile(path, input, {
            mode: "append",
            at: 99,
            truncate: true,
            ...(signalled ? { signal: new AbortController().signal } : {}),
          });
          expect([...await fileSystem.readFile(path)]).toEqual([...(existing ? [1, 2] : []), ...data]);
          if (input instanceof ReadableStream) expect(input.locked).toBe(false);
        }
      }
    }
  }
  const rangeSource = Uint8Array.from({ length: 160 * 1024 }, (_, index) => index % 251);
  await fileSystem.writeFile("/range.bin", rangeSource);
  const range = await bytes(await fileSystem.openReadStream("/range.bin", { at: 7, length: 128 * 1024 + 13 }));
  expect(range).toEqual(rangeSource.slice(7, 7 + 128 * 1024 + 13));
  const emptyReader = (await fileSystem.openReadStream("/range.bin", { at: 7, length: 0 })).getReader();
  try {
    expect(await emptyReader.read()).toEqual({ value: undefined, done: true });
  } finally {
    emptyReader.releaseLock();
  }

  await fileSystem.mkdir("/range-dir");
  await expect(fileSystem.readFile("/range-dir", { length: 0 })).rejects.toMatchObject({ code: "type-mismatch" });
  await expect(fileSystem.openReadStream("/range-dir", { length: 0 })).rejects.toMatchObject({ code: "type-mismatch" });
  await expect(fileSystem.readFile("/range-missing", { length: 0 })).rejects.toMatchObject({ code: "not-found" });
  await expect(fileSystem.openReadStream("/range-missing", { length: 0 })).rejects.toMatchObject({ code: "not-found" });

  await fileSystem.mkdir("/empty");
  await fileSystem.remove("/empty");
  expect(await fileSystem.exists("/empty")).toBe(false);

  await fileSystem.writeFile("/remove/a/b.txt", "remove", { parents: true });
  await fileSystem.remove("/remove", { recursive: true });
  expect(await fileSystem.exists("/remove")).toBe(false);

  await fileSystem.writeFile("/clear/a/b.txt", "clear", { parents: true });
  await fileSystem.emptyDir("/clear");
  expect(await fileSystem.exists("/clear", { kind: "directory" })).toBe(true);
  const children = [];
  for await (const entry of fileSystem.readDir("/clear")) children.push(entry.name);
  expect(children).toEqual([]);

  await fileSystem.writeFile("/copy-source/new.txt", "copy", { parents: true });
  await fileSystem.writeFile("/copy-target/old.txt", "old", { parents: true });
  await fileSystem.copy("/copy-source", "/copy-target", { overwrite: true, preserve: false });
  expect(await fileSystem.readText("/copy-target/new.txt")).toBe("copy");
  expect(await fileSystem.exists("/copy-target/old.txt")).toBe(false);

  await fileSystem.writeFile("/move-source/new.txt", "move", { parents: true });
  await fileSystem.writeFile("/move-target/old.txt", "old", { parents: true });
  await fileSystem.move("/move-source", "/move-target", { overwrite: true, preserve: false });
  expect(await fileSystem.exists("/move-source")).toBe(false);
  expect(await fileSystem.readText("/move-target/new.txt")).toBe("move");
  expect(await fileSystem.exists("/move-target/old.txt")).toBe(false);
}

/** Exercises the actual Windows rejection without converting an invalid name to an alias. */
export async function verifyWindowsNames(fileSystem: FileSystemType): Promise<void> {
  const path = "/native-invalid?.bin";
  let failure: unknown;
  try {
    await fileSystem.writeFile(path, new Uint8Array([1, 2, 3]));
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ name: "FileSystemError", operation: "write", path });
  expect((failure as Error).cause).toBeDefined();
  const names = [];
  for await (const entry of fileSystem.readDir("/")) names.push(entry.name);
  expect(names).not.toContain("native-invalid?.bin");
  expect(names).not.toContain("native-invalid.bin");
  await fileSystem.writeFile("/valid-after-invalid.bin", new Uint8Array([4, 5, 6]));
  expect(await fileSystem.readFile("/valid-after-invalid.bin")).toEqual(new Uint8Array([4, 5, 6]));
}

/**
 * Holds the initial absence observation while a native writer creates the path.
 *
 * The permissioned Deno, Node, and Bun lanes supply a fresh real host adapter.
 * The second observation must refuse a directory or retain an existing file's
 * bytes, then release its creation lock. This helper owns and closes the adapter.
 */
export async function verifyFileAdmission(
  native: AdapterType,
  lockPrefix: string,
  appeared: "directory" | "file",
): Promise<void> {
  await withReleases(async (releases) => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let targetStats = 0;
    let writes = 0;
    const adapter: AdapterType = defineAdapter(
      new Proxy(native, {
        get(target, name) {
          if (name === "stat") {
            return async (...args: Parameters<AdapterType["stat"]>) => {
              const result = await target.stat(...args);
              if (args[0] === "/target" && ++targetStats === 1) {
                expect(result).toBeNull();
                entered.resolve();
                await finish.promise;
              }
              return result;
            };
          }
          if (name === "writeFile") {
            return async (...args: Parameters<AdapterType["writeFile"]>) => {
              writes++;
              await target.writeFile(...args);
            };
          }
          const value: unknown = Reflect.get(target, name, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    const fileSystem = createFileSystem(adapter, { coordination: "local", lockPrefix, disposeAdapter: true });
    releases.push(() => fileSystem.close());
    expect(fileSystem.inspect().adapter.native).toEqual(native.capabilities);
    const pending = fileSystem.getFileHandle("/target", { create: true }).then(
      (handle) => ({ handle }),
      (error: unknown) => ({ error }),
    );
    releases.push(() => pending);
    releases.push(() => finish.resolve());
    await within(entered.promise, "initial absent native file stat");
    const bytes = new Uint8Array([7, 8, 9]);
    if (appeared === "directory") await native.createDir("/target");
    else await native.writeFile("/target", bytes, { mode: "replace" });
    finish.resolve();
    const outcome = await within(pending, "locked file-kind recheck");
    expect(targetStats).toBe(2);
    expect(writes).toBe(0);
    if (appeared === "directory") {
      expect("error" in outcome).toBe(true);
      if (!("error" in outcome)) throw new Error("Expected directory admission refusal.");
      expect(outcome.error).toMatchObject({ code: "type-mismatch", operation: "get-file", path: "/target" });
      expect(await native.stat("/target")).toMatchObject({ kind: "directory" });
      await native.remove("/target");
      const retry = await within(fileSystem.getFileHandle("/target", { create: true }), "released creation lock");
      expect(retry.kind).toBe("file");
      expect(writes).toBe(1);
      expect(await native.readFile("/target")).toEqual(new Uint8Array());
    } else {
      expect("handle" in outcome).toBe(true);
      if (!("handle" in outcome)) throw outcome.error;
      expect(outcome.handle.kind).toBe("file");
      expect(await native.readFile("/target")).toEqual(bytes);
      await within(fileSystem.writeFile("/target", new Uint8Array([4])), "released existing-file lock");
      expect(writes).toBe(1);
      expect(await native.readFile("/target")).toEqual(new Uint8Array([4]));
    }
  });
}
