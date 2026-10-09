import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem, FileSystemError, probeOpfs, toFileSystemError } from "../mod.ts";
import type { AdapterType, FileSystemOptionsType } from "../src/adapter/definition.ts";
import { defineAdapter } from "../src/adapter/definition.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { collectBytes, observeBytes, openBytes, retire, toByteStream, withAbortSignal } from "../src/stream.ts";
import { withReleases } from "./close.ts";
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

  it("retains the abort and independent reader cancellation fault after lock release", async () => {
    let cancellations = 0;
    const cleanup = deferred();
    const failure = new Error("reader cleanup failed");
    const source = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancellations++;
        throw failure;
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
      const rejected = reader.read().then(() => {
        throw new Error("Expected actual rejection.");
      }, (reason: unknown) => reason);
      const actual = await rejected;
      expect(actual).toBeInstanceOf(AggregateError);
      if (!(actual instanceof AggregateError)) throw new Error("Expected independent terminal faults.");
      expect(actual.errors).toHaveLength(2);
      expect(actual.errors[0]).toMatchObject({ code: "aborted", cause: "stop" });
      expect(actual.errors[1]).toBe(failure);
      expect(actual.cause).toBe(actual.errors[0]);
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

/** Captures a real rejection without conflating it with successful undefined. */
async function rejected(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected an actual rejected operation.");
}

describe("Owned byte stream retirement", () => {
  it("keeps a pending abort read behind physical cancellation and preserves its null cause", async () => {
    await withReleases(async (releases) => {
      const entered = deferred();
      const cancelling = deferred();
      const finish = deferred();
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        pull() {
          entered.resolve();
        },
        async cancel() {
          cancellations++;
          cancelling.resolve();
          await finish.promise;
        },
      }, { highWaterMark: 0 });
      const controller = new AbortController();
      const stream = withAbortSignal(source, controller.signal, "/held.bin");
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      let settled = false;
      const pending = rejected(reader.read()).finally(() => settled = true);
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => controller.abort(null));
      await within(entered.promise, "native pending read");
      controller.abort(null);
      await within(cancelling.promise, "native cancellation admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(source.locked).toBe(true);
      finish.resolve();
      expect(await within(pending, "native cancellation settlement")).toMatchObject({
        code: "aborted",
        path: "/held.bin",
        cause: null,
      });
      await retire(stream);
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  it("keeps equal-valued cancellation and release failures as two separate events", async () => {
    await withReleases(async (releases) => {
      const independent = new Error("Authored shared value from separate cleanup actions.");
      const source = new ReadableStream<Uint8Array>({
        cancel() {
          throw independent;
        },
      }, { highWaterMark: 0 });
      const acquire = source.getReader.bind(source);
      Object.defineProperty(source, "getReader", {
        value() {
          const reader = acquire();
          const unlock = reader.releaseLock.bind(reader);
          reader.releaseLock = () => {
            unlock();
            throw independent;
          };
          return reader;
        },
      });
      const controller = new AbortController();
      const stream = withAbortSignal(source, controller.signal, "/equal.bin");
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      controller.abort("authored stop");
      const failure = await rejected(reader.read());
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Expected separate owned failures.");
      expect(failure.errors).toHaveLength(3);
      expect(failure.errors[0]).toMatchObject({ code: "aborted", cause: "authored stop" });
      expect(failure.errors.slice(1)).toEqual([independent, independent]);
      expect(failure.cause).toBe(failure.errors[0]);
      await retire(stream);
      expect(source.locked).toBe(false);
    });
  });

  it("retains an unconsumed abort and its cleanup failure when an acquisition owner retires it", async () => {
    const cleanup = new Error("Authored unconsumed native cleanup failure.");
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const stream = withAbortSignal(source, controller.signal, "/never-read.bin");
    controller.abort("unconsumed stop");
    const first = retire(stream);
    const second = retire(stream);
    expect(second).toBe(first);
    const failure = await rejected(first);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected undelivered owned failures.");
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toMatchObject({ code: "aborted", cause: "unconsumed stop" });
    expect(failure.errors[1]).toBe(cleanup);
    expect(await rejected(second)).toBe(failure);
    expect(cancellations).toBe(1);
    expect(source.locked).toBe(false);
  });

  it("records actual delivery when an already-errored owner is read after physical retirement", async () => {
    await withReleases(async (releases) => {
      const released = deferred();
      const source = new ReadableStream<Uint8Array>({
        cancel() {
          released.resolve();
        },
      }, { highWaterMark: 0 });
      const controller = new AbortController();
      const stream = withAbortSignal(source, controller.signal, "/late-read.bin");
      controller.abort("late read stop");
      await within(released.promise, "unrequested physical cancellation");
      // A task checkpoint lets the owner finish without invoking a consumer pull.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      expect(await rejected(reader.read())).toMatchObject({ code: "aborted", cause: "late read stop" });
      await retire(stream);
      expect(source.locked).toBe(false);
    });
  });

  it("retains one source error when native error and abort occur in the same frame", async () => {
    await withReleases(async (releases) => {
      const fault = new Error("Authored same-frame producer error.");
      const entered = deferred();
      let native!: ReadableStreamDefaultController<Uint8Array>;
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          native = controller;
        },
        pull() {
          entered.resolve();
        },
      }, { highWaterMark: 0 });
      const acquire = source.getReader.bind(source);
      Object.defineProperty(source, "getReader", {
        value() {
          const reader = acquire();
          const cancel = reader.cancel.bind(reader);
          reader.cancel = (reason) => {
            cancellations++;
            return cancel(reason);
          };
          return reader;
        },
      });
      const controller = new AbortController();
      const stream = withAbortSignal(source, controller.signal, "/same-frame.bin");
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      const pending = rejected(reader.read());
      releases.push(() => pending);
      await within(entered.promise, "same-frame producer admission");
      native.error(fault);
      controller.abort("same-frame stop");
      const failure = await pending;
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("Expected separate abort and source events.");
      expect(failure.errors).toHaveLength(2);
      expect(failure.errors[0]).toMatchObject({ code: "aborted", cause: "same-frame stop" });
      expect(failure.errors[1]).toBe(fault);
      expect(cancellations).toBe(0);
      await retire(stream);
      expect(source.locked).toBe(false);
    });
  });

  it("retains an unread native closed failure beside abort without a second cancellation", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(undefined);
      },
    });
    let cancellations = 0;
    const acquire = source.getReader.bind(source);
    Object.defineProperty(source, "getReader", {
      value() {
        const reader = acquire();
        const cancel = reader.cancel.bind(reader);
        reader.cancel = (reason) => {
          cancellations++;
          return cancel(reason);
        };
        return reader;
      },
    });
    const controller = new AbortController();
    const stream = withAbortSignal(source, controller.signal, "/unread-error.bin");
    controller.abort(null);
    const failure = await rejected(retire(stream));
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected unread source and abort events.");
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toMatchObject({ code: "aborted", cause: null });
    expect(failure.errors[1]).toBeUndefined();
    expect(cancellations).toBe(0);
    expect(source.locked).toBe(false);
  });

  for (const reason of [undefined, null, new Error("Authored producer terminal failure.")]) {
    it(`does not recancel a natively errored source (${String(reason)})`, async () => {
      await withReleases(async (releases) => {
        let calls = 0;
        const source = new ReadableStream<Uint8Array>({
          pull() {
            throw reason;
          },
        }, { highWaterMark: 0 });
        const acquire = source.getReader.bind(source);
        Object.defineProperty(source, "getReader", {
          value() {
            const reader = acquire();
            const cancel = reader.cancel.bind(reader);
            reader.cancel = (value) => {
              calls++;
              return cancel(value);
            };
            return reader;
          },
        });
        const stream = withAbortSignal(source, undefined, "/producer.bin");
        const reader = openBytes(stream);
        releases.push(() => reader.releaseLock());
        expect(await rejected(reader.read())).toBe(reason);
        await retire(stream);
        expect(calls).toBe(0);
        expect(source.locked).toBe(false);
      });
    });
  }

  it("reports a reader release failure after actual EOF without recancelling the source", async () => {
    await withReleases(async (releases) => {
      const failure = new Error("Authored EOF release fault.");
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      const acquire = source.getReader.bind(source);
      Object.defineProperty(source, "getReader", {
        value() {
          const reader = acquire();
          const unlock = reader.releaseLock.bind(reader);
          const cancel = reader.cancel.bind(reader);
          reader.cancel = (reason) => {
            cancellations++;
            return cancel(reason);
          };
          reader.releaseLock = () => {
            unlock();
            throw failure;
          };
          return reader;
        },
      });
      const reader = openBytes(withAbortSignal(source, undefined, "/eof.bin"));
      releases.push(() => reader.releaseLock());
      expect(await rejected(reader.read())).toBe(failure);
      expect(cancellations).toBe(0);
      expect(source.locked).toBe(false);
    });
  });

  it("joins signal retirement while a consumer cancel remains pending", async () => {
    await withReleases(async (releases) => {
      const cancelling = deferred();
      const finish = deferred();
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        async cancel() {
          cancellations++;
          cancelling.resolve();
          await finish.promise;
        },
      }, { highWaterMark: 0 });
      const controller = new AbortController();
      const stream = withAbortSignal(source, controller.signal, "/joined.bin");
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      controller.abort("join stop");
      await within(cancelling.promise, "one physical cancellation");
      let settled = false;
      const cancelled = rejected(reader.cancel()).finally(() => settled = true);
      releases.push(() => cancelled);
      releases.push(() => finish.resolve());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      finish.resolve();
      expect(await cancelled).toMatchObject({ code: "aborted", cause: "join stop" });
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  it("retires an observed-byte callback failure before rejecting its read", async () => {
    await withReleases(async (releases) => {
      const failure = new Error("Authored byte observer fault.");
      const entered = deferred();
      const finish = deferred();
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        async cancel() {
          cancellations++;
          entered.resolve();
          await finish.promise;
        },
      }, { highWaterMark: 0 });
      const reader = openBytes(observeBytes(source, () => {
        throw failure;
      }, "/observe.bin"));
      releases.push(() => reader.releaseLock());
      let settled = false;
      const pending = rejected(reader.read()).finally(() => settled = true);
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      await within(entered.promise, "observer-fault cancellation");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      finish.resolve();
      expect(await pending).toBe(failure);
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  it("does not publish a chunk after its observer synchronously retires the owner", async () => {
    await withReleases(async (releases) => {
      let retirement: Promise<void> | undefined;
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([9]));
        },
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const stream: ReadableStream<Uint8Array> = observeBytes(source, () => {
        retirement = retire(stream);
      }, "/observer-stop.bin");
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      await retirement;
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  it("does not count a released pending reader as delivery of a later abort failure", async () => {
    await withReleases(async (releases) => {
      const entered = deferred();
      const cancelling = deferred();
      const finish = deferred();
      const source = new ReadableStream<Uint8Array>({
        pull() {
          entered.resolve();
        },
        async cancel() {
          cancelling.resolve();
          await finish.promise;
        },
      }, { highWaterMark: 0 });
      const controller = new AbortController();
      const stream = withAbortSignal(source, controller.signal, "/released.bin");
      const native = stream.getReader();
      const nativeRead = native.read.bind(native);
      let nativePending: Promise<unknown> | undefined;
      native.read = () => {
        const requested = nativeRead();
        // Observe this exact native request independently; openBytes must
        // forward its release rejection without translating or swallowing it.
        nativePending = rejected(requested);
        return requested;
      };
      Reflect.set(stream, "getReader", () => native);
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      const pending = rejected(reader.read());
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => controller.abort("released stop"));
      await within(entered.promise, "released-reader input admission");
      controller.abort("released stop");
      await within(cancelling.promise, "released-reader cancellation admission");
      reader.releaseLock();
      if (nativePending === undefined) throw new Error("The native read request was not observed.");
      const nativeFailure = await within(nativePending, "native pending-reader release");
      expect(await pending).toBe(nativeFailure);
      finish.resolve();
      const retirement = await rejected(retire(stream));
      expect(retirement).toBeInstanceOf(FileSystemError);
      expect(retirement).toMatchObject({
        code: "aborted",
        operation: "read",
        path: "/released.bin",
        cause: "released stop",
      });
      expect(source.locked).toBe(false);
    });
  });

  it("joins a cooperative iterator return and pending next before delivering abort", async () => {
    await withReleases(async (releases) => {
      const entered = deferred();
      const returning = deferred();
      const finish = deferred();
      let returns = 0;
      const input: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              entered.resolve();
              await finish.promise;
              return { done: true, value: undefined };
            },
            async return() {
              returns++;
              returning.resolve();
              await finish.promise;
              return { done: true, value: undefined };
            },
          };
        },
      };
      const controller = new AbortController();
      const source = toByteStream(input);
      const stream = withAbortSignal(source, controller.signal, "/iterator.bin");
      const reader = openBytes(stream);
      releases.push(() => reader.releaseLock());
      let settled = false;
      const pending = rejected(reader.read()).finally(() => settled = true);
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      releases.push(() => controller.abort("iterator stop"));
      await within(entered.promise, "iterator next admission");
      controller.abort("iterator stop");
      await within(returning.promise, "iterator return admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      finish.resolve();
      expect(await pending).toMatchObject({ code: "aborted", cause: "iterator stop" });
      expect(returns).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  it("retains separate iterator next and return faults even when their values are equal", async () => {
    const fault = new Error("Authored equal-valued iterator events.");
    let returns = 0;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(fault);
          },
          return() {
            returns++;
            return Promise.reject(fault);
          },
        };
      },
    };
    const source = toByteStream(input);
    const actual = await rejected(collectBytes(source, 1, undefined, "write", "/iterator-fault.bin"));
    expect(actual).toBeInstanceOf(AggregateError);
    if (!(actual instanceof AggregateError)) throw new Error("Expected both iterator events.");
    expect(actual.errors).toEqual([fault, fault]);
    expect(returns).toBe(1);
    expect(source.locked).toBe(false);
  });

  it("does not request iterator return after actual EOF", async () => {
    let returns = 0;
    const input: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.resolve({ done: true, value: undefined });
          },
          return() {
            returns++;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
    expect(await collectBytes(toByteStream(input), 0, undefined, "write", "/empty-iterator.bin"))
      .toEqual(new Uint8Array(0));
    expect(returns).toBe(0);
  });

  it("bounds materialization exactly and accepts offset byte views and zero-byte streams", async () => {
    for (
      const [values, limit, expected] of [
        [[], 0, []],
        [[new Uint8Array(0)], 0, []],
        [[new Uint8Array([0, 7, 8, 0]).subarray(1, 3), new Uint8Array([9])], 3, [7, 8, 9]],
      ] as const
    ) {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const value of values) controller.enqueue(value);
          controller.close();
        },
      });
      expect(Array.from(await collectBytes(source, limit, undefined, "write", "/bounded.bin"))).toEqual(expected);
      expect(source.locked).toBe(false);
    }
  });

  it("rejects invalid byte limits before acquiring the caller's reader", async () => {
    let acquisitions = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const acquire = source.getReader.bind(source);
    Object.defineProperty(source, "getReader", {
      value() {
        acquisitions++;
        return acquire();
      },
    });
    for (const limit of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await rejected(collectBytes(source, limit, undefined, "write", "/invalid-limit.bin")))
        .toBeInstanceOf(RangeError);
    }
    expect(acquisitions).toBe(0);
    expect(source.locked).toBe(false);
  });

  it("waits for limit-triggered producer retirement and retains its independent fault", async () => {
    await withReleases(async (releases) => {
      const entered = deferred();
      const finish = deferred();
      const failure = new Error("Authored limit cleanup fault.");
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
        },
        async cancel() {
          cancellations++;
          entered.resolve();
          await finish.promise;
          throw failure;
        },
      }, { highWaterMark: 0 });
      let settled = false;
      const pending = rejected(collectBytes(source, 1, undefined, "write", "/limit.bin"))
        .finally(() => settled = true);
      releases.push(() => pending);
      releases.push(() => finish.resolve());
      await within(entered.promise, "limit cleanup admission");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(source.locked).toBe(true);
      finish.resolve();
      const actual = await pending;
      expect(actual).toBeInstanceOf(AggregateError);
      if (!(actual instanceof AggregateError)) throw new Error("Expected limit and cleanup faults.");
      expect(actual.errors).toHaveLength(2);
      expect(actual.errors[0]).toMatchObject({ code: "too-large", path: "/limit.bin" });
      expect(actual.errors[1]).toBe(failure);
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
    });
  });

  it("rejects invalid JavaScript chunks without a signal and retires both stream and iterable producers", async () => {
    for (const value of ["not bytes", new Int8Array([1]), new DataView(new ArrayBuffer(1)), { byteLength: 1 }]) {
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          Reflect.apply(controller.enqueue, controller, [value]);
        },
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      expect(await rejected(collectBytes(source, 3, undefined, "write", "/invalid.bin"))).toBeInstanceOf(TypeError);
      expect(cancellations).toBe(1);
      expect(source.locked).toBe(false);
      let returned = 0;
      const iterable: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
          return {
            next() {
              return Promise.resolve({ done: false, value: Reflect.get({ value }, "value") });
            },
            return() {
              returned++;
              return Promise.resolve({ done: true, value: undefined });
            },
          };
        },
      };
      // JavaScript callers can supply chunks outside the public TypeScript contract.
      const bytes = iterable as AsyncIterable<Uint8Array>;
      expect(await rejected(collectBytes(toByteStream(bytes), 3, undefined, "write", "/invalid-iterable.bin")))
        .toBeInstanceOf(TypeError);
      expect(returned).toBe(1);
    }
  });

  it("refuses borrowed stream locks without cancelling or taking their reader", async () => {
    await withReleases(async (releases) => {
      let cancellations = 0;
      const source = new ReadableStream<Uint8Array>({
        cancel() {
          cancellations++;
        },
      }, { highWaterMark: 0 });
      const reader = source.getReader();
      releases.push(() => reader.releaseLock());
      expect(await rejected(retire(source))).toBeInstanceOf(TypeError);
      expect(() => withAbortSignal(source, undefined, "/borrowed.bin")).toThrow(TypeError);
      expect(source.locked).toBe(true);
      expect(cancellations).toBe(0);
      await reader.cancel();
    });
  });
});

describe("file admission after lock acquisition", () => {
  for (const physical of ["link", "foreign"] as const) {
    it(`reports read-dir when refusing traversal of a ${physical} entry`, async () => {
      const native = createMemoryAdapter();
      await native.createDir("/target");
      await native.writeFile("/target/file", new Uint8Array([1]), { mode: "replace" });
      let refused = true;
      let stats = 0;
      let listings = 0;
      const adapter: AdapterType = defineAdapter(
        new Proxy(native, {
          get(target, name) {
            if (name === "entry") return () => Promise.resolve(refused ? physical : "directory");
            if (name === "stat") {
              return (...args: Parameters<AdapterType["stat"]>) => {
                stats++;
                return target.stat(...args);
              };
            }
            if (name === "readDir") {
              return (...args: Parameters<AdapterType["readDir"]>) => {
                listings++;
                return target.readDir(...args);
              };
            }
            const value: unknown = Reflect.get(target, name, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      );
      const fileSystem = createFileSystem(adapter, { coordination: "local" });
      await withFileSystem(fileSystem, async () => {
        const listing = async () => {
          const entries = [];
          for await (const entry of fileSystem.readDir("/target")) entries.push(entry);
          return entries;
        };
        await expect(listing()).rejects.toMatchObject({
          code: "type-mismatch",
          operation: "read-dir",
          path: "/target",
        });
        expect(stats).toBe(0);
        expect(listings).toBe(0);
        refused = false;
        const entries = await listing();
        expect(entries.map(({ name, kind }) => ({ name, kind }))).toEqual([{ name: "file", kind: "file" }]);
        expect(stats).toBe(1);
        expect(listings).toBe(1);
      });
    });
  }
});

it("uses intrinsic materialized ranges and streamed limits despite borrowed metadata shadows", async () => {
  for (
    const value of [Uint8Array.of(99, 7, 8, 98).subarray(1, 3), new DataView(Uint8Array.of(99, 7, 8, 98).buffer, 1, 2)]
  ) {
    Object.defineProperty(value, "byteLength", { value: 0 });
    Object.defineProperty(value, "buffer", {
      get() {
        throw new Error("Borrowed buffer was consulted.");
      },
    });
    Object.defineProperty(value, "byteOffset", {
      get() {
        throw new Error("Borrowed offset was consulted.");
      },
    });
    const fs = createMemoryFileSystem();
    try {
      await fs.writeFile("/range", value);
      expect([...await fs.readFile("/range")]).toEqual([7, 8]);
    } finally {
      await fs.close();
    }
  }
  const bytes = Uint8Array.of(7, 8);
  Object.defineProperty(bytes, "byteLength", { value: 0 });
  let cancellations = 0;
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(bytes);
    },
    cancel() {
      cancellations++;
    },
  }, { highWaterMark: 0 });
  const failure = await rejected(collectBytes(source, 1, undefined, "write", "/bounded"));
  expect(failure).toBeInstanceOf(FileSystemError);
  if (!(failure instanceof FileSystemError)) throw new Error("Expected the byte limit failure.");
  expect(failure.code).toBe("too-large");
  expect(cancellations).toBe(1);
  expect(source.locked).toBe(false);
});
