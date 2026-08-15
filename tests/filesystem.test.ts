import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem, FileSystemError, probeOpfs } from "../mod.ts";
import { defineAdapter } from "../src/adapter/definition.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { basename, dirname, isAncestorPath, joinPath, normalizePath, splitPath } from "../src/path.ts";

/** Creates an isolated memory-backed facade so lock state cannot leak between filesystem tests. */
function createMemoryFileSystem(name: string = crypto.randomUUID(), options: Record<string, unknown> = {}) {
  return createFileSystem(createMemoryAdapter(), {
    coordination: "local",
    lockPrefix: `test:${name}`,
    ...options,
  });
}

/** Creates a controllable promise used to prove ordering and lock admission. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Waits for an observable test condition without depending on an arbitrary fixed delay. */
async function waitFor(predicate: () => boolean, timeout = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** State shared between a blocked stream fixture and the test that releases it. */
interface BlockedStreamType {
  /** Becomes true immediately before the fixture yields its first chunk. */
  started: boolean;
  /** Promise gate that keeps the stream active until the test allows completion. */
  readonly release: ReturnType<typeof deferred>;
}

/** Yields one text chunk, then keeps the write active until the test releases its gate. */
async function* blockedData(state: BlockedStreamType, value: string): AsyncGenerator<Uint8Array> {
  state.started = true;
  yield new TextEncoder().encode(value);
  await state.release.promise;
}

/** Asserts one operation rejects with the stable filesystem error code expected by callers. */
async function expectFileSystemError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(FileSystemError);
    if (error instanceof FileSystemError) expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected FileSystemError '${code}'.`);
}

describe("filesystem facade", () => {
  it("rejects invalid adapter and facade contracts", async () => {
    const valid = createMemoryAdapter();
    expect(() => defineAdapter({ ...valid, name: "" })).toThrow(TypeError);
    expect(() => defineAdapter({
      ...valid,
      capabilities: { ...valid.capabilities, streamRead: "yes" },
    } as never)).toThrow(TypeError);
    expect(() => defineAdapter({
      ...valid,
      capabilities: { ...valid.capabilities, nativeCopy: true },
    })).toThrow(TypeError);
    expect(() => defineAdapter({
      ...valid,
      capabilities: { ...valid.capabilities, streamWriteModes: ["replace"] },
    })).toThrow(TypeError);
    expect(() => createFileSystem(valid, { coordination: "invalid" as never })).toThrow(TypeError);
    let invalidWriteRejected = false;
    try {
      await createMemoryFileSystem().writeFile("/invalid.txt", "data", { mode: "invalid" as never });
    } catch {
      invalidWriteRejected = true;
    }
    expect(invalidWriteRejected).toBe(true);
  });

  it("requests shared tree and exclusive file Web Locks", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const requests: Array<{ name: string; mode: string }> = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          async request(name: string, options: { mode: string }, callback: () => Promise<void>) {
            requests.push({ name, mode: options.mode });
            await callback();
          },
        },
      },
    });
    try {
      const fileSystem = createFileSystem(createMemoryAdapter(), {
        coordination: "web-locks",
        lockPrefix: "test:web-locks",
      });
      await fileSystem.writeFile("/locked.txt", "data", { parents: true });
      expect(requests).toEqual([
        { name: "test:web-locks:tree", mode: "shared" },
        { name: "test:web-locks:file:/locked.txt", mode: "exclusive" },
      ]);
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", original);
    }
  });

  it("keeps canonical path behavior stable", () => {
    expect(normalizePath("a/./b/../c")).toBe("/a/c");
    expect(joinPath("/a", "b", "../c")).toBe("/a/c");
    expect(splitPath("/a/c")).toEqual(["a", "c"]);
    expect(dirname("/a/c")).toBe("/a");
    expect(basename("/a/c")).toBe("c");
    expect(isAncestorPath("/a", "/a/c")).toBe(true);
    expect(() => normalizePath("../../escape")).toThrow(FileSystemError);
    expect(() => normalizePath("a\\b")).toThrow(FileSystemError);
  });

  it("preserves replace, append, update, range, and stat semantics", async () => {
    const fileSystem = createMemoryFileSystem();
    await fileSystem.writeFile("/data.txt", "hello", { parents: true });
    await fileSystem.writeFile("/data.txt", " world", { mode: "append" });
    await fileSystem.writeFile("/data.txt", "OPFS", { mode: "update", at: 6 });
    expect(await fileSystem.readText("/data.txt")).toBe("hello OPFSd");
    expect([...await fileSystem.readFile("/data.txt", { at: 6, length: 4 })]).toEqual([
      ...new TextEncoder().encode("OPFS"),
    ]);
    const stat = await fileSystem.stat("/data.txt");
    expect(stat.kind).toBe("file");
    if (stat.kind === "file") expect(stat.size).toBe(11);
  });

  it("commits staged writable data only on close", async () => {
    const fileSystem = createMemoryFileSystem();
    const file = await fileSystem.root.getFileHandle("staged.txt", { create: true });
    const writable = await file.createWritable();
    await writable.write("discard");
    await writable.abort();
    expect(await fileSystem.readText("/staged.txt")).toBe("");
  });

  it("caps record-backed streamed writes and cancels producers", async () => {
    const fileSystem = createMemoryFileSystem("buffer-limit", { maxBufferedWriteBytes: 4 });
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expectFileSystemError(fileSystem.writeFile("/too-large.bin", stream, { parents: true }), "too-large");
    expect(cancelled).toBe(true);
  });

  it("replaces stale destination trees and removes a source after fallback move", async () => {
    const fileSystem = createMemoryFileSystem();
    await fileSystem.writeFile("/source/nested/a.txt", "A", { parents: true });
    await fileSystem.writeFile("/source/b.txt", "B", { parents: true });
    await fileSystem.writeFile("/destination/stale.txt", "stale", { parents: true });
    await fileSystem.copy("/source", "/destination", { overwrite: true, concurrency: 2 });
    expect(await fileSystem.readText("/destination/nested/a.txt")).toBe("A");
    expect(await fileSystem.exists("/destination/stale.txt")).toBe(false);
    await fileSystem.move("/destination", "/moved", { concurrency: 2 });
    expect(await fileSystem.exists("/destination")).toBe(false);
    expect(await fileSystem.readText("/moved/b.txt")).toBe("B");
  });

  it("rejects destructive source and destination overlap before mutation", async () => {
    const fileSystem = createMemoryFileSystem();
    await fileSystem.writeFile("/a/b/file.txt", "safe", { parents: true });
    await expectFileSystemError(fileSystem.copy("/a", "/a/c", { overwrite: true }), "invalid-operation");
    await expectFileSystemError(fileSystem.copy("/a/b/file.txt", "/a", { overwrite: true }), "invalid-operation");
    expect(await fileSystem.readText("/a/b/file.txt")).toBe("safe");
  });

  it("recovers after an aborted queued same-file write", async () => {
    const fileSystem = createMemoryFileSystem();
    const state: BlockedStreamType = { started: false, release: deferred() };
    const first = fileSystem.writeFile("/queue.txt", blockedData(state, "first"), { parents: true });
    await waitFor(() => state.started);
    const controller = new AbortController();
    const second = fileSystem.writeFile("/queue.txt", "second", { signal: controller.signal });
    controller.abort("cancel queued write");
    await expectFileSystemError(second, "aborted");
    const third = fileSystem.writeFile("/queue.txt", "third");
    state.release.resolve();
    await first;
    await third;
    expect(await fileSystem.readText("/queue.txt")).toBe("third");
  });

  it("lets independent files progress while one write is active", async () => {
    const fileSystem = createMemoryFileSystem();
    const state: BlockedStreamType = { started: false, release: deferred() };
    const first = fileSystem.writeFile("/parallel/a.txt", blockedData(state, "first"), { parents: true });
    await waitFor(() => state.started);
    await fileSystem.writeFile("/parallel/b.txt", "second", { parents: true });
    expect(await fileSystem.readText("/parallel/b.txt")).toBe("second");
    state.release.resolve();
    await first;
  });

  it("keeps structural mutation behind active file mutation", async () => {
    const fileSystem = createMemoryFileSystem();
    const state: BlockedStreamType = { started: false, release: deferred() };
    const write = fileSystem.writeFile("/tree/file.txt", blockedData(state, "data"), { parents: true });
    await waitFor(() => state.started);
    let emptied = false;
    const empty = fileSystem.emptyDir("/tree").then(() => {
      emptied = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(emptied).toBe(false);
    state.release.resolve();
    await write;
    await empty;
    expect(await fileSystem.exists("/tree/file.txt")).toBe(false);
  });

  it("propagates cancellation after a read stream opens", async () => {
    const fileSystem = createMemoryFileSystem();
    await fileSystem.writeFile("/abort.bin", new Uint8Array(1024), { parents: true });
    const controller = new AbortController();
    const stream = await fileSystem.openReadStream("/abort.bin", { signal: controller.signal });
    controller.abort("stop");
    await expectFileSystemError(new Response(stream).arrayBuffer(), "aborted");
  });

  it("disposes an adapter only when ownership is explicit", async () => {
    let disposed = 0;
    const adapter = createMemoryAdapter();
    adapter.dispose = async () => {
      disposed += 1;
    };
    const borrowed = createFileSystem(adapter, { coordination: "local" });
    await borrowed.close();
    expect(disposed).toBe(0);
    const owned = createFileSystem(adapter, { coordination: "local", disposeAdapter: true });
    await owned.close();
    await owned.close();
    expect(disposed).toBe(1);
  });

  it("probes OPFS without throwing when the current context has no browser OPFS", async () => {
    const capabilities = await probeOpfs();
    expect(typeof capabilities.rootAvailable).toBe("boolean");
    if (!capabilities.rootAvailable) expect(typeof capabilities.rootError?.name).toBe("string");
  });
});
