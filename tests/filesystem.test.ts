import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem, FileSystemError, probeOpfs, toFileSystemError } from "../mod.ts";
import type { FileSystemOptionsType } from "../src/adapter/definition.ts";
import { defineAdapter } from "../src/adapter/definition.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { withAbortSignal } from "../src/stream.ts";
import { verifyBytes, verifyPendingAbort, withFileSystem, within } from "./reliability.ts";

/** Creates an isolated memory-backed facade so lock state cannot leak between filesystem tests. */
function createMemoryFileSystem(name: string = crypto.randomUUID(), options: FileSystemOptionsType = {}) {
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

/** State shared between a blocked stream fixture and the test that releases it. */
interface BlockedStreamType {
  /** Resolves immediately before the fixture yields its first chunk. */
  readonly entered: ReturnType<typeof deferred>;
  /** Promise gate that keeps the stream active until the test allows completion. */
  readonly release: ReturnType<typeof deferred>;
}

/** Yields one text chunk, then keeps the write active until the test releases its gate. */
async function* blockedData(state: BlockedStreamType, value: string): AsyncGenerator<Uint8Array> {
  state.entered.resolve();
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
  for (const metrics of ["none", "basic", "timing"] as const) {
    for (const enabled of [true, false]) {
      it(`preserves the independent byte oracle with metrics ${metrics} and optimizations ${enabled}`, async () => {
        const fileSystem = createMemoryFileSystem(undefined, {
          metrics,
          optimizations: {
            streamRead: enabled,
            streamWrite: enabled,
            rangeRead: enabled,
            nativeCopy: enabled,
            nativeMove: enabled,
          },
        });
        await withFileSystem(fileSystem, async () => {
          await verifyBytes(fileSystem);
          await verifyPendingAbort(fileSystem);
        });
      });
    }
  }

  it("rejects invalid adapter and facade contracts", async () => {
    const valid = createMemoryAdapter();
    expect(() => defineAdapter({ ...valid, name: "" })).toThrow(TypeError);
    expect(() =>
      defineAdapter({
        ...valid,
        capabilities: { ...valid.capabilities, streamRead: "yes" },
      } as never)
    ).toThrow(TypeError);
    expect(() =>
      defineAdapter({
        ...valid,
        capabilities: { ...valid.capabilities, nativeCopy: true },
      })
    ).toThrow(TypeError);
    expect(() =>
      defineAdapter({
        ...valid,
        capabilities: { ...valid.capabilities, streamWriteModes: ["replace"] },
      })
    ).toThrow(TypeError);
    expect(() => createFileSystem(valid, { coordination: "invalid" as never })).toThrow(TypeError);
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      await expect(fileSystem.writeFile("/invalid.txt", "data", { mode: "invalid" as never })).rejects.toMatchObject({
        name: "ZodError",
      });
    });
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
      await withFileSystem(fileSystem, async () => {
        await fileSystem.writeFile("/locked.txt", "data", { parents: true });
        expect(requests).toEqual([
          { name: "test:web-locks:tree", mode: "shared" },
          { name: "test:web-locks:file:/locked.txt", mode: "exclusive" },
        ]);
      });
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", original);
    }
  });

  it("normalizes queued Web Locks cancellation to the package aborted failure", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const requested: string[] = [];
    const entered = deferred();
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request(name: string, options: { mode: string; signal?: AbortSignal }, callback: () => Promise<void>) {
            requested.push(name);
            if (name.endsWith(":file:/queued.txt")) {
              entered.resolve();
              return new Promise<void>((_resolve, reject) => {
                options.signal?.addEventListener(
                  "abort",
                  () => reject(new DOMException("Queued lock request was aborted.", "AbortError")),
                  { once: true },
                );
              });
            }
            return callback();
          },
        },
      },
    });
    try {
      const fileSystem = createFileSystem(createMemoryAdapter(), {
        coordination: "web-locks",
        lockPrefix: "test:web-lock-abort",
      });
      await withFileSystem(fileSystem, async () => {
        const controller = new AbortController();
        const write = fileSystem.writeFile("/queued.txt", "data", { signal: controller.signal });
        void write.catch(() => {});
        try {
          await within(entered.promise, "queued Web Lock request");
          expect(requested).toContain("test:web-lock-abort:file:/queued.txt");
          controller.abort("cancel queued write");
          await expectFileSystemError(write, "aborted");
        } finally {
          controller.abort("Web Lock fixture cleanup");
          await within(Promise.allSettled([write]), "Web Lock fixture drain");
        }
      });
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", original);
    }
  });

  it("preserves stable package error fields when normalizing an error from another realm", () => {
    const foreign = {
      name: "FileSystemError",
      message: "foreign read was aborted",
      code: "aborted",
      operation: "read",
      path: "/foreign.bin",
    };

    const normalized = toFileSystemError(foreign, "fallback", "/ignored.bin");

    expect(normalized).toBeInstanceOf(FileSystemError);
    expect(normalized.code).toBe("aborted");
    expect(normalized.operation).toBe("read");
    expect(normalized.path).toBe("/foreign.bin");
    expect(normalized.message).toBe("foreign read was aborted");
  });

  it("preserves replace, append, update, range, and stat semantics", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
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
  });

  it("commits staged writable data only on close", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      const file = await fileSystem.root.getFileHandle("staged.txt", { create: true });
      const writable = await file.createWritable();
      try {
        await writable.write("committed");
        expect(await fileSystem.readText("/staged.txt")).toBe("");
        await writable.close();
        expect(await fileSystem.readText("/staged.txt")).toBe("committed");
      } finally {
        await writable.abort();
      }
      const discarded = await file.createWritable({ keepExistingData: true });
      try {
        await discarded.write("discard");
        expect(await fileSystem.readText("/staged.txt")).toBe("committed");
      } finally {
        await discarded.abort();
      }
      expect(await fileSystem.readText("/staged.txt")).toBe("committed");
    });
  });

  it("caps record-backed streamed writes and cancels producers", async () => {
    const fileSystem = createMemoryFileSystem("buffer-limit", { maxBufferedWriteBytes: 4 });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/too-large.bin", new Uint8Array([9, 8]));
      let cancelled = 0;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.enqueue(new Uint8Array([4, 5, 6]));
        },
        cancel() {
          cancelled += 1;
        },
      });
      await expectFileSystemError(fileSystem.writeFile("/too-large.bin", stream, { parents: true }), "too-large");
      expect(cancelled).toBe(1);
      expect(stream.locked).toBe(false);
      expect(await fileSystem.readFile("/too-large.bin")).toEqual(new Uint8Array([9, 8]));
      await fileSystem.writeFile("/too-large.bin", new Uint8Array([1, 2, 3, 4]));
      expect(await fileSystem.readFile("/too-large.bin")).toEqual(new Uint8Array([1, 2, 3, 4]));
    });
  });

  it("replaces stale destination trees and removes a source after fallback move", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/source/nested/a.txt", "A", { parents: true });
      await fileSystem.writeFile("/source/b.txt", "B", { parents: true });
      await fileSystem.writeFile("/destination/stale.txt", "stale", { parents: true });
      await fileSystem.copy("/source", "/destination", { overwrite: true, preserve: false, concurrency: 2 });
      expect(await fileSystem.readText("/destination/nested/a.txt")).toBe("A");
      expect(await fileSystem.exists("/destination/stale.txt")).toBe(false);
      await fileSystem.move("/destination", "/moved", { concurrency: 2 });
      expect(await fileSystem.exists("/destination")).toBe(false);
      expect(await fileSystem.readText("/moved/b.txt")).toBe("B");
    });
  });

  it("rejects destructive source and destination overlap before mutation", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/a/b/file.txt", "safe", { parents: true });
      await expectFileSystemError(fileSystem.copy("/a", "/a/c", { overwrite: true }), "invalid-operation");
      await expectFileSystemError(fileSystem.copy("/a/b/file.txt", "/a", { overwrite: true }), "invalid-operation");
      expect(await fileSystem.readText("/a/b/file.txt")).toBe("safe");
    });
  });

  it("recovers after an aborted queued same-file write", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      const state: BlockedStreamType = { entered: deferred(), release: deferred() };
      const first = fileSystem.writeFile("/queue.txt", blockedData(state, "first"), { parents: true });
      try {
        await within(state.entered.promise, "blocked producer begins");
        const controller = new AbortController();
        const second = fileSystem.writeFile("/queue.txt", "second", { signal: controller.signal });
        controller.abort("cancel queued write");
        await expectFileSystemError(second, "aborted");
        const third = fileSystem.writeFile("/queue.txt", "third");
        state.release.resolve();
        await first;
        await third;
        expect(await fileSystem.readText("/queue.txt")).toBe("third");
      } finally {
        state.release.resolve();
        await within(Promise.allSettled([first]), "blocked producer cleanup");
      }
    });
  });

  it("lets independent files progress while one write is active", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      const state: BlockedStreamType = { entered: deferred(), release: deferred() };
      const first = fileSystem.writeFile("/parallel/a.txt", blockedData(state, "first"), { parents: true });
      try {
        await within(state.entered.promise, "blocked producer begins");
        await fileSystem.writeFile("/parallel/b.txt", "second", { parents: true });
        expect(await fileSystem.readText("/parallel/b.txt")).toBe("second");
        state.release.resolve();
        await first;
      } finally {
        state.release.resolve();
        await within(Promise.allSettled([first]), "blocked producer cleanup");
      }
    });
  });

  it("keeps structural mutation behind active file mutation", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      const state: BlockedStreamType = { entered: deferred(), release: deferred() };
      const write = fileSystem.writeFile("/tree/file.txt", blockedData(state, "data"), { parents: true });
      let empty: Promise<void> | undefined;
      try {
        await within(state.entered.promise, "blocked producer begins");
        empty = fileSystem.emptyDir("/tree");
        state.release.resolve();
        await write;
        await empty;
        expect(await fileSystem.exists("/tree/file.txt")).toBe(false);
      } finally {
        state.release.resolve();
        await within(Promise.allSettled(empty === undefined ? [write] : [write, empty]), "blocked producer cleanup");
      }
    });
  });

  it("propagates cancellation after a read stream opens", async () => {
    const fileSystem = createMemoryFileSystem();
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/abort.bin", new Uint8Array(1024), { parents: true });
      const controller = new AbortController();
      const stream = await fileSystem.openReadStream("/abort.bin", { signal: controller.signal });
      const reader = stream.getReader();
      try {
        controller.abort("stop");
        await expectFileSystemError(reader.read(), "aborted");
      } finally {
        reader.releaseLock();
      }
    });
  });

  it("keeps abort authoritative when invoked reader cancellation cleanup rejects and releases its lock", async () => {
    let cancellations = 0;
    const cleanup = deferred();
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancellations++;
        throw new Error("reader cleanup failed");
      },
    });
    const native = source.getReader();
    const release = native.releaseLock.bind(native);
    native.releaseLock = () => {
      release();
      cleanup.resolve();
    };
    Reflect.set(source, "getReader", () => native);
    const controller = new AbortController();
    const stream = withAbortSignal(source, controller.signal, "/abort-cleanup.bin");
    const reader = stream.getReader();
    try {
      controller.abort("stop");
      await expectFileSystemError(reader.read(), "aborted");
      await within(cleanup.promise, "native reader lock release after cancellation rejection");
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    } finally {
      reader.releaseLock();
    }
  });

  it("retains the producer Error identity and releases the errored source without invoking its cancel callback", async () => {
    const failure = new Error("producer failed");
    let cancellations = 0;
    const cleanup = deferred();
    const source = new ReadableStream<Uint8Array>({
      pull() {
        throw failure;
      },
      cancel() {
        cancellations++;
      },
    });
    const native = source.getReader();
    const release = native.releaseLock.bind(native);
    native.releaseLock = () => {
      release();
      cleanup.resolve();
    };
    Reflect.set(source, "getReader", () => native);
    const stream = withAbortSignal(source, new AbortController().signal, "/producer.bin");
    const reader = stream.getReader();
    try {
      await expect(reader.read()).rejects.toBe(failure);
      await within(cleanup.promise, "native reader lock release after producer error");
      expect(cancellations).toBe(0);
      expect(source.locked).toBe(false);
    } finally {
      reader.releaseLock();
    }
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
