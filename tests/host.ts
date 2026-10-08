import { expect } from "@std/expect";
import { platform } from "node:os";

import type { FileSystemType } from "../src/filesystem.ts";
import { verifyBytes, verifyPendingAbort } from "./reliability.ts";

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
