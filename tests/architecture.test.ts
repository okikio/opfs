import { createBunDriver } from "../src/driver/bun.ts";
import { HOST_PROFILES } from "../src/driver/host.ts";
import type { FileHandle as NodeFileHandle } from "node:fs/promises";
import {
  mkdtemp,
  readdir,
  readFile as nativeReadFile,
  rename as nativeRename,
  rm,
  stat,
  symlink,
  writeFile as nativeWriteFile,
} from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
/// <reference types="deno" />
import { describe, it } from "node:test";
import { withReleases } from "./close.ts";
import { within } from "./gate.ts";
import { expect } from "@std/expect";
import { createFileSystem, FileSystemError, toFileSystemError } from "../mod.ts";
import { createNodeDriver } from "../src/driver/node.ts";
import { createDenoDriver, DenoRangeSource } from "../src/driver/deno.ts";
import { setImmediate } from "node:timers/promises";
import { createFileAdapter } from "../src/adapter/file.ts";
import { createMemoryAdapter } from "../src/adapter/memory.ts";
import { createLocalStorageAdapter } from "../src/adapter/localstorage.ts";
import { createKeyValueBridge } from "../src/bridge/kv.ts";
import { QueuedWritableFile } from "../src/driver/writable.ts";
import type {
  FileDriverSyncFileType,
  FileDriverWritableFileType,
  FileDriverWriteOptionsType,
} from "../src/driver/file.ts";

/** Enumerates authored fault events across ownership scopes without deduplicating equal reasons. */
function faultsOf(reason: unknown): readonly unknown[] {
  return reason instanceof AggregateError ? reason.errors.flatMap((nested: unknown) => faultsOf(nested)) : [reason];
}

/** Checks exact filesystem context without deriving authority from an arbitrary cause. */
function assertAbort(error: unknown, operation: "read" | "write", reason: unknown): void {
  expect(error).toBeInstanceOf(FileSystemError);
  expect(error).toMatchObject({ code: "aborted", operation, path: "/file" });
  if (!(error instanceof FileSystemError)) throw new Error("Expected a filesystem abort observation.");
  expect(Object.hasOwn(error, "cause")).toBe(true);
  expect(error.cause).toBe(reason);
}

/** The public normalizer alone selects category; owned aggregates remain inspectable causes. */
function assertNormalizedAbort(failure: unknown, operation: "read" | "write", reason: unknown): void {
  const normalized = toFileSystemError(failure, operation, "/file");
  expect(normalized).toMatchObject({ code: "aborted", operation, path: "/file" });
  if (failure instanceof AggregateError) expect(normalized.cause).toBe(failure);
  else {
    expect(normalized).toBe(failure);
    assertAbort(failure, operation, reason);
  }
}

/** Controlled stream-backed writes observe both the guard and undelivered input abort. */
function assertWriteAbort(failure: unknown, reason: unknown, ownedInput: boolean): void {
  assertNormalizedAbort(failure, "write", reason);
  if (!ownedInput) {
    assertAbort(failure, "write", reason);
    return;
  }
  expect(failure).toBeInstanceOf(AggregateError);
  if (!(failure instanceof AggregateError)) throw new Error("Expected both owned write abort observations.");
  const observations: readonly unknown[] = failure.errors;
  expect(observations).toHaveLength(2);
  const [guard, retirement] = observations;
  expect(failure.cause).toBe(guard);
  assertAbort(guard, "write", reason);
  assertAbort(retirement, "write", reason);
  // The two owners observed separate events, even though both causes equal the caller reason.
  expect(retirement).not.toBe(guard);
}

/** Real Deno cancellation can interrupt an outstanding native read during retirement. */
function assertReadAbort(failure: unknown, runtime: "node" | "deno" | "bun", reason: unknown): void {
  assertNormalizedAbort(failure, "read", reason);
  if (!(failure instanceof AggregateError)) return;
  expect(runtime).toBe("deno");
  const observations: readonly unknown[] = failure.errors;
  expect(observations).toHaveLength(2);
  const [abort, native] = observations;
  expect(failure.cause).toBe(abort);
  assertAbort(abort, "read", reason);
  // Native I/O may complete before cancellation, giving a bare abort instead.
  // Only the acquired Deno read's concrete interruption is an allowed second event.
  expect(native).toBeInstanceOf(Deno.errors.Interrupted);
  expect(native).toMatchObject({ code: "EINTR" });
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Genuine storage can have misleading own metadata and methods without changing its native range. */
function shadowed<T extends ArrayBufferView>(view: T): T {
  const refuse = () => {
    throw new Error("Caller-owned byte method must not decide a native range.");
  };
  Object.defineProperties(view, {
    buffer: { configurable: true, value: new ArrayBuffer(0) },
    byteOffset: { configurable: true, value: 0 },
    byteLength: { configurable: true, value: 0 },
    length: { configurable: true, value: 0 },
    subarray: { configurable: true, value: refuse },
    slice: { configurable: true, value: refuse },
    [Symbol.iterator]: { configurable: true, value: refuse },
  });
  return view;
}

/** Produces one real offset range with sentinels outside the admitted bytes. */
function offsetBytes(): Uint8Array {
  return shadowed(new Uint8Array(new Uint8Array([99, 4, 5, 99]).buffer, 1, 2));
}

describe("intrinsic native byte ranges", () => {
  for (const [name, create] of [["node", createNodeDriver], ["deno", createDenoDriver]] as const) {
    it(`${name} direct byte and stream writes use native ranges in every write mode`, {
      skip: name === "deno" && typeof Deno === "undefined",
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-native-byte-range-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = create({ root });
        for (const mode of ["replace", "append", "update"] as const) {
          for (const source of ["bytes", "stream"] as const) {
            await driver.writeFile("/file", new Uint8Array([1, 1, 1, 1]), { mode: "replace" });
            const bytes = offsetBytes();
            const options = { mode, at: 1, truncate: true };
            if (source === "bytes") await driver.writeFile("/file", bytes, options);
            else {
              const input = new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              });
              await driver.writeStream!("/file", input, options);
              expect(input.locked).toBe(false);
            }
            expect([...await nativeReadFile(join(root, "file"))]).toEqual(
              mode === "replace" ? [4, 5] : mode === "append" ? [1, 1, 1, 1, 4, 5] : [1, 4, 5],
            );
          }
        }
        await driver.writeFile("/file", shadowed(new Uint8Array(0)), { mode: "replace" });
        expect([...await nativeReadFile(join(root, "file"))]).toEqual([]);
      }));

    it(`${name} direct positional and synchronous BufferSource ranges ignore own metadata`, {
      skip: name === "deno" && typeof Deno === "undefined",
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-native-buffer-source-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = create({ root });
        await driver.writeFile("/file", new Uint8Array([1, 1, 1, 1]), { mode: "replace" });
        const writer = await driver.openWritableFile!("/file", { maxPendingBytes: 2 });
        releases.push(() => writer.close());
        const backing = new Uint8Array([99, 4, 5, 99]);
        await writer.write(shadowed(new DataView(backing.buffer, 1, 2)), { at: 1 });
        await writer.close();
        expect([...await nativeReadFile(join(root, "file"))]).toEqual([1, 4, 5, 1]);
        const sync = await driver.openSyncFile!("/file");
        releases.push(() => sync.close());
        const destination = new Uint8Array([99, 0, 0, 99]);
        expect(sync.read(shadowed(new DataView(destination.buffer, 1, 2)), { at: 1 })).toBe(2);
        expect([...destination]).toEqual([99, 4, 5, 99]);
        expect(sync.write(offsetBytes(), { at: 0 })).toBe(2);
        sync.close();
        expect([...await nativeReadFile(join(root, "file"))]).toEqual([4, 5, 5, 1]);
      }));

    it(`${name} refuses invalid native materialized and stream byte input`, {
      skip: name === "deno" && typeof Deno === "undefined",
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-native-invalid-bytes-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = create({ root });
        const detached = new Uint8Array([4, 5]);
        structuredClone(detached.buffer, { transfer: [detached.buffer] });
        for (const bytes of [new Proxy(new Uint8Array([4, 5]), {}), detached, new Uint16Array([4, 5])]) {
          await driver.writeFile("/file", new Uint8Array([1, 2, 3]), { mode: "replace" });
          // Actual JavaScript callers can violate a TypeScript byte declaration.
          expect(await failureOf(driver.writeFile("/file", bytes as Uint8Array, { mode: "replace" })))
            .toBeInstanceOf(TypeError);
          expect([...await nativeReadFile(join(root, "file"))]).toEqual([1, 2, 3]);
          const input = new ReadableStream<Uint8Array>({
            start(controller) {
              Reflect.apply(controller.enqueue, controller, [bytes]);
              controller.close();
            },
          });
          const failure = await failureOf(driver.writeStream!("/file", input, { mode: "update", at: 0 }));
          expect(failure).toBeInstanceOf(TypeError);
          expect(input.locked).toBe(false);
          expect([...await nativeReadFile(join(root, "file"))]).toEqual([1, 2, 3]);
        }
      }));
  }
});

describe("mutable append descriptor ownership", () => {
  for (const source of ["bytes", "stream"] as const) {
    it(`Node ${source} append and truncate pins partial writes to one mutable file`, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-append-pin-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = createNodeDriver({ root });
        const path = join(root, "file"), pinned = join(root, "pinned");
        await nativeWriteFile(path, new Uint8Array([1, 2]));
        const api = process.getBuiltinModule("node:fs/promises");
        if (api === undefined) throw new Error("Native filesystem API is unavailable.");
        const open = api.open;
        let opens = 0, closes = 0, stats = 0, swapped = false;
        const positions: number[] = [], truncations: number[] = [];
        replaceNative(releases, api, "open", async (...args) => {
          const file: NodeFileHandle = await Reflect.apply(open, api, args);
          opens++;
          let retired = false;
          releases.push(async () => {
            if (!retired) await file.close();
          });
          return new Proxy(file, {
            get(target, key) {
              if (key === "stat") {
                return async () => {
                  stats++;
                  return await target.stat();
                };
              }
              if (key === "write") {
                return async (bytes: Uint8Array, offset: number, length: number, at: number) => {
                  positions.push(at);
                  const result = await target.write(bytes, offset, Math.min(length, 1), at);
                  if (!swapped) {
                    swapped = true;
                    await nativeRename(path, pinned);
                    await nativeWriteFile(path, new Uint8Array([8, 8, 8, 8]));
                  }
                  return result;
                };
              }
              if (key === "truncate") {
                return async (size: number) => {
                  truncations.push(size);
                  await target.truncate(size);
                };
              }
              if (key === "close") {
                return async () => {
                  closes++;
                  await target.close();
                  retired = true;
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });
        if (source === "bytes") {
          await driver.writeFile("/file", new Uint8Array([3, 4, 5]), { mode: "append", at: 99, truncate: true });
        } else {
          const input = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([3, 4]));
              controller.enqueue(new Uint8Array([5]));
              controller.close();
            },
          });
          await driver.writeStream!("/file", input, { mode: "append", at: 99, truncate: true });
          expect(input.locked).toBe(false);
        }
        expect({ opens, closes, stats }).toEqual({ opens: 1, closes: 1, stats: 1 });
        expect(positions).toEqual([2, 3, 4]);
        expect(truncations).toEqual([5]);
        expect([...await nativeReadFile(pinned)]).toEqual([1, 2, 3, 4, 5]);
        expect([...await nativeReadFile(path)]).toEqual([8, 8, 8, 8]);
      }));
  }

  for (const mode of ["append", "update"] as const) {
    it(`Node ${mode} retains a file that appears during mutable acquisition`, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-mutable-create-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = createNodeDriver({ root });
        const path = join(root, "file");
        const api = process.getBuiltinModule("node:fs/promises");
        if (api === undefined) throw new Error("Native filesystem API is unavailable.");
        const open = api.open;
        let appeared = false;
        replaceNative(releases, api, "open", async (...args) => {
          try {
            return await Reflect.apply(open, api, args);
          } catch (reason) {
            if (!appeared && toFileSystemError(reason, "write", "/file").code === "not-found") {
              await nativeWriteFile(path, new Uint8Array([1, 2, 3, 4]));
              appeared = true;
            }
            throw reason;
          }
        });
        await driver.writeFile("/file", new Uint8Array([9]), { mode, at: 1, truncate: mode === "append" });
        expect(appeared).toBe(true);
        expect([...await nativeReadFile(path)]).toEqual(mode === "append" ? [1, 2, 3, 4, 9] : [1, 9, 3, 4]);
      }));
  }

  for (const stage of ["stat", "write", "truncate"] as const) {
    it(`Node append and truncate retains its ${stage} failure beside descriptor close`, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-append-retirement-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = createNodeDriver({ root });
        const path = join(root, "file");
        await nativeWriteFile(path, new Uint8Array([1, 2]));
        const api = process.getBuiltinModule("node:fs/promises");
        if (api === undefined) throw new Error("Native filesystem API is unavailable.");
        const open = api.open;
        const primary = new Error("Authored mutable append failure.");
        const retirement = new Error("Authored mutable descriptor close failure.");
        let closes = 0, cancellations = 0;
        replaceNative(releases, api, "open", async (...args) => {
          const file: NodeFileHandle = await Reflect.apply(open, api, args);
          let retired = false;
          releases.push(async () => {
            if (!retired) await file.close();
          });
          return new Proxy(file, {
            get(target, key) {
              if (key === stage) {
                return () => {
                  throw primary;
                };
              }
              if (key === "close") {
                return async () => {
                  closes++;
                  await target.close();
                  retired = true;
                  throw retirement;
                };
              }
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });
        let sent = false;
        const input = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent) controller.close();
            else {
              sent = true;
              controller.enqueue(new Uint8Array([3, 4]));
            }
          },
          cancel() {
            cancellations++;
          },
        }, { highWaterMark: 0 });
        const failure = await failureOf(driver.writeStream!("/file", input, { mode: "append", truncate: true }));
        expect(failure).toBeInstanceOf(AggregateError);
        if (!(failure instanceof AggregateError)) throw new Error("Expected both acquired-owner failures.");
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toBe(primary);
        expect(failure.errors[1]).toBe(retirement);
        expect(failure.cause).toBe(primary);
        expect(closes).toBe(1);
        expect(cancellations).toBe(stage === "truncate" ? 0 : 1);
        expect(input.locked).toBe(false);
        expect([...await nativeReadFile(path)]).toEqual(stage === "truncate" ? [1, 2, 3, 4] : [1, 2]);
      }));
  }
});

it("queued write admission counts the intrinsic range and fixes it before deferred execution", async () =>
  await withReleases(async (releases) => {
    const entered = gate(), released = gate();
    const observations: Array<{ readonly bytes: number[]; readonly buffer: ArrayBufferLike }> = [];
    const backend: FileDriverWritableFileType = {
      async write(buffer) {
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        observations.push({ bytes: [...view], buffer: view.buffer });
      },
      async truncate() {
        entered.resolve();
        await released.promise;
      },
      async flush() {},
      async close() {},
      async abort() {},
    };
    const limited = new QueuedWritableFile(backend, { maxPendingBytes: 1 });
    releases.push(() => limited.close());
    await expect(limited.write(offsetBytes(), { at: 0 })).rejects.toMatchObject({ code: "too-large" });
    expect(observations).toEqual([]);
    expect(limited.inspect().pendingBytes).toBe(0);

    const queued = new QueuedWritableFile(backend, { maxPendingBytes: 2 });
    releases.push(async () => {
      released.resolve();
      await queued.close();
    });
    const predecessor = queued.truncate(0);
    await entered.promise;
    const backing = new Uint8Array([99, 4, 5, 99]);
    const bytes = shadowed(new Uint8Array(backing.buffer, 1, 2));
    const writing = queued.write(bytes, { at: 0 });
    expect(queued.inspect().pendingBytes).toBe(2);
    Object.defineProperty(bytes, "byteLength", { configurable: true, value: 500 });
    Object.defineProperty(bytes, "byteOffset", { configurable: true, value: 99 });
    released.resolve();
    await Promise.all([predecessor, writing]);
    expect(observations).toEqual([{ bytes: [4, 5], buffer: backing.buffer }]);
    expect(observations[0]?.buffer).toBe(backing.buffer);
    expect(queued.inspect().pendingBytes).toBe(0);
    await expect(queued.write(offsetBytes(), { at: Number.MAX_SAFE_INTEGER - 1 })).rejects.toBeInstanceOf(RangeError);
    const detached = new Uint8Array([4, 5]);
    structuredClone(detached.buffer, { transfer: [detached.buffer] });
    let rejection!: Promise<void>;
    expect(() => rejection = queued.write(detached, { at: 0 })).not.toThrow();
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    if (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get) {
      const storage = new ArrayBuffer(4, { maxByteLength: 8 });
      const outside = new Uint8Array(storage, 2, 2);
      storage.resize(1);
      expect(() => rejection = queued.write(outside, { at: 0 })).not.toThrow();
      await expect(rejection).rejects.toBeInstanceOf(TypeError);
    }
    expect(observations).toHaveLength(1);
  }));

describe("architecture failure classes", () => {
  for (const [name, create] of [["node", createNodeDriver], ["deno", createDenoDriver]] as const) {
    it(`${name} retains replacement bytes on missing source, no-clobber, and invalid tree replacement`, {
      skip: name === "deno" && typeof Deno === "undefined",
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-architecture-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = create({ root });
        const fs = createFileSystem(createFileAdapter(driver));
        releases.push(() => fs.close());
        await fs.writeFile("/old", "valuable");
        await fs.writeFile("/new", "source");
        await expect(fs.move("/missing", "/old", { overwrite: true })).rejects.toMatchObject({ code: "not-found" });
        await expect(driver.copy!("/new", "/old", { overwrite: false })).rejects.toBeInstanceOf(Error);
        await expect(driver.move!("/new", "/old", { overwrite: false })).rejects.toMatchObject({
          code: "already-exists",
        });
        expect(await fs.readText("/old")).toBe("valuable");
        expect(await fs.readText("/new")).toBe("source");
        await fs.ensureDir("/tree");
        await fs.writeFile("/tree/member", "tree");
        await expect(fs.copy("/tree", "/old", { overwrite: true })).rejects.toMatchObject({ code: "not-supported" });
        expect(await fs.readText("/old")).toBe("valuable");
        await fs.copy("/new", "/old", { overwrite: true });
        expect(await fs.readText("/old")).toBe("source");
        await expect(driver.move!("/new", "/absent", { overwrite: false, exclusive: true })).rejects.toMatchObject({
          code: "not-supported",
        });
        await driver.copy!("/old", "/exclusive", { overwrite: false, exclusive: true });
        expect(await fs.readText("/exclusive")).toBe("source");
      }));
    it(`${name} stages emulated copies before a failed producer can damage a destination`, {
      skip: name === "deno" && typeof Deno === "undefined",
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-architecture-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const adapter = createFileAdapter(create({ root }));
        const fs = createFileSystem(adapter, { optimizations: { nativeCopy: false } });
        releases.push(() => fs.close());
        await fs.writeFile("/source", "complete");
        await fs.writeFile("/destination", "valuable");
        const failure = new Error("partial stage failed");
        adapter.writeStream = async (path, source, options) => {
          await source.cancel();
          await adapter.writeFile(path, new Uint8Array([1]), options);
          throw failure;
        };
        await expect(fs.copy("/source", "/destination", { overwrite: true })).rejects.toMatchObject({ cause: failure });
        expect(await fs.readText("/destination")).toBe("valuable");
        await expect(fs.copy("/source", "/absent")).rejects.toMatchObject({ cause: failure });
        expect(await fs.exists("/absent")).toBe(false);
        expect((await Array.fromAsync(fs.readDir("/"))).map((entry) => entry.name).sort()).toEqual([
          "destination",
          "source",
        ]);
      }));

    it(`${name} unlinks directory aliases while retaining their target children`, {
      skip: platform() === "win32" || (name === "deno" && typeof Deno === "undefined"),
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-architecture-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const fs = createFileSystem(createFileAdapter(create({ root })));
        releases.push(() => fs.close());
        await fs.writeFile("/target/valuable", "keep", { parents: true });
        await symlink(`${root}/target`, `${root}/alias`, "dir");
        await expect(fs.emptyDir("/alias")).rejects.toMatchObject({ code: "type-mismatch" });
        await expect(fs.remove("/alias/valuable", { recursive: true })).rejects.toMatchObject({
          code: "not-supported",
        });
        await fs.remove("/alias", { recursive: true });
        expect(await fs.readText("/target/valuable")).toBe("keep");
        await symlink(`${root}/target`, `${root}/alias`, "dir");
        await fs.emptyDir("/");
        expect(await stat(`${root}/alias`).catch(() => null)).toBe(null);
      }));
    it(`${name} orders accepted positional writes and clamps EOF cursors`, {
      skip: name === "deno" && typeof Deno === "undefined",
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-architecture-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = create({ root });
        const fs = createFileSystem(createFileAdapter(driver));
        releases.push(() => fs.close());
        await fs.writeFile("/file", "abcd");
        const file = await driver.openWritableFile!("/file");
        releases.push(() => file.close());
        const writes = Array.from({ length: 32 }, (_, at) => file.write(new Uint8Array([at]), { at }));
        const close = file.close();
        await Promise.all(writes);
        await close;
        expect(await fs.readFile("/file")).toEqual(Uint8Array.from({ length: 32 }, (_, at) => at));
        const sync = await driver.openSyncFile!("/file");
        releases.push(() => sync.close());
        try {
          expect(sync.read(new Uint8Array(1), { at: 99 })).toBe(0);
          sync.write(new Uint8Array([255]));
          expect(sync.getSize()).toBe(33);
        } finally {
          sync.close();
        }
        await expect(fs.openWritableFile("/file", { maxPendingBytes: 0 })).rejects.toBeInstanceOf(Error);
      }));
  }

  it("bounds admitted bytes and reserves one winning terminal slot behind accepted operations", async () =>
    await withReleases(async (releases) => {
      const pause = gate();
      const events: string[] = [];
      const file = new QueuedWritableFile({
        async write() {
          events.push("write");
          await pause.promise;
        },
        async truncate() {
          events.push("truncate");
        },
        async flush() {
          events.push("flush");
        },
        async close() {
          events.push("close");
        },
        async abort() {
          events.push("abort");
        },
      }, { maxPendingBytes: 2, maxPendingOperations: 2 });
      const pending: Promise<unknown>[] = [];
      releases.push(() => within(file.abort(), "queued writable fixture terminal release"));
      releases.push(async () => {
        pause.resolve();
        await within(Promise.allSettled(pending), "queued writable fixture drain");
      });
      const accepted = file.write(new Uint8Array(2), { at: 0 });
      pending.push(accepted);
      void accepted.catch(() => {});
      const truncate = file.truncate(1);
      pending.push(truncate);
      void truncate.catch(() => {});
      await expect(file.write(new Uint8Array(1), { at: 2 })).rejects.toMatchObject({ code: "too-large" });
      expect(file.inspect().pendingBytes).toBe(2);
      const close = file.close();
      pending.push(close);
      void close.catch(() => {});
      const abort = file.abort();
      pending.push(abort);
      void abort.catch(() => {});
      pause.resolve();
      await within(Promise.all([accepted, truncate, close, abort]), "accepted writable operations and terminal winner");
      expect(events).toEqual(["write", "truncate", "close"]);
      expect(file.inspect().pendingBytes).toBe(0);
      await expect(file.flush()).rejects.toBeInstanceOf(TypeError);
    }));

  it("captures admitted command positions while borrowing their buffers until settlement", async () =>
    await withReleases(async (releases) => {
      const pause = gate();
      const positions: number[] = [];
      const file = new QueuedWritableFile({
        async write(_buffer, options) {
          positions.push(options.at);
          await pause.promise;
        },
        async truncate() {},
        async flush() {},
        async close() {},
        async abort() {},
      });
      const pending: Promise<unknown>[] = [];
      releases.push(() => within(file.abort(), "queued writable fixture terminal release"));
      releases.push(async () => {
        pause.resolve();
        await within(Promise.allSettled(pending), "queued writable fixture drain");
      });
      const first = file.write(new Uint8Array(1), { at: 0 });
      pending.push(first);
      void first.catch(() => {});
      const position = { at: 1 };
      const second = file.write(new Uint8Array(1), position);
      pending.push(second);
      void second.catch(() => {});
      position.at = 99;
      pause.resolve();
      await within(Promise.all([first, second]), "accepted positional writes");
      await within(file.close(), "position fixture close");
      expect(positions).toEqual([0, 1]);
    }));

  it("keeps exact JS string keys in a dedicated owned namespace and preserves foreign files", async () => {
    const fs = createFileSystem(createMemoryAdapter());
    try {
      await fs.writeFile("/app/data", "valuable", { parents: true });
      expect(() => createKeyValueBridge(fs, { root: "/" })).toThrow(TypeError);
      const kv = createKeyValueBridge(fs);
      const keys = ["", ":", "a:b", "a::b", ":a", "a:", "%", "~", "~uD800", "\ud800", "\udc00", "😀", "a/b"];
      for (const [at, key] of keys.entries()) await kv.set(key, String(at));
      expect(new Set(await kv.keys())).toEqual(new Set(keys));
      for (const [at, key] of keys.entries()) expect(await kv.get(key)).toBe(String(at));
      await fs.writeFile("/.opfs-kv/key-~41/value", "foreign", { parents: true });
      await fs.writeFile("/.opfs-kv/neighbor", "foreign");
      await kv.clear();
      expect(await kv.keys()).toEqual([]);
      expect(await fs.readText("/app/data")).toBe("valuable");
      expect(await fs.readText("/.opfs-kv/neighbor")).toBe("foreign");
      expect(await fs.readText("/.opfs-kv/key-~41/value")).toBe("foreign");
      await fs.writeFile("/legacy/key-a/value", "old", { parents: true });
      const legacy = createKeyValueBridge(fs, { root: "/legacy" });
      await legacy.clear();
      expect(await fs.readText("/legacy/key-a/value")).toBe("old");
      await expect(legacy.set("a", "replace")).rejects.toBeInstanceOf(TypeError);
    } finally {
      await fs.close();
    }
  });

  it("empties Web Storage from a stable key snapshot and preserves unrelated application keys", async () => {
    const values = new Map<string, string>([["application", "keep"]]);
    const storage = {
      get length() {
        return values.size;
      },
      key(at: number) {
        return [...values.keys()][at] ?? null;
      },
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
      removeItem(key: string) {
        values.delete(key);
      },
    };
    const fs = createFileSystem(createLocalStorageAdapter(storage));
    try {
      for (let at = 0; at < 24; at++) await fs.writeFile(`/file-${at}`, String(at));
      await fs.emptyDir();
      expect(values).toEqual(new Map([["application", "keep"]]));
    } finally {
      await fs.close();
    }
  });

  it("routes convenience seek and truncate through the writable stream terminal state", async () => {
    const fs = createFileSystem(createMemoryAdapter());
    try {
      await fs.writeFile("/file", "keep");
      const handle = await fs.getFileHandle("/file");
      const writable = await handle.createWritable();
      await writable.abort(new Error("cancelled"));
      await expect(writable.seek(0)).rejects.toBeInstanceOf(Error);
      await expect(writable.truncate(0)).rejects.toBeInstanceOf(Error);
      expect(await fs.readText("/file")).toBe("keep");
    } finally {
      await fs.close();
    }
  });
});

describe("host profile native runtime parity", () => {
  const runtimes = [
    ["node", createNodeDriver, true],
    ["deno", createDenoDriver, typeof Deno !== "undefined"],
    ["bun", createBunDriver, typeof globalThis !== "undefined" && "Bun" in globalThis],
  ] as const;
  for (const [name, create, available] of runtimes) {
    it(
      `${name} keeps a direct read stream bound to its signal after opening`,
      { skip: !available },
      async () =>
        await withReleases(async (releases) => {
          const root = await mkdtemp(join(tmpdir(), "opfs-read-signal-"));
          releases.push(() => rm(root, { recursive: true, force: true }));
          const driver = create({ root });
          await driver.writeFile("/file", new Uint8Array(256 * 1024).fill(7), { mode: "replace" });
          for (const range of [{}, { at: 1, length: 128 * 1024 }]) {
            const controller = new AbortController();
            const source = await driver.openReadStream!("/file", { ...range, signal: controller.signal });
            const reader = source.getReader();
            releases.push(() => reader.releaseLock());
            releases.push(() => within(reader.cancel().catch(() => undefined), "native read signal teardown"));
            expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
            controller.abort("stop native source");
            assertReadAbort(await failureOf(reader.read()), name, "stop native source");
          }
        }),
    );

    it(`${name} releases native roots and direct resources after setup, body, and cleanup faults`, {
      skip: !available,
    }, async () => {
      for (const phase of ["setup", "body", "cleanup"] as const) {
        let root = "";
        let writable: FileDriverWritableFileType | undefined;
        let sync: FileDriverSyncFileType | undefined;
        const primary = new Error(`owned ${phase} failure`);
        const cleanup = new Error("independent release failure");
        const events: string[] = [];
        let failure: unknown;
        try {
          await withReleases(async (releases) => {
            root = await mkdtemp(join(tmpdir(), "opfs-lifetime-"));
            releases.push(async () => {
              await rm(root, { recursive: true, force: true });
              events.push("root");
            });
            if (phase === "setup") throw primary;
            const driver = create({ root });
            const fs = createFileSystem(createFileAdapter(driver));
            releases.push(async () => {
              await fs.close();
              events.push("facade");
            });
            await fs.writeFile("/file", "owned");
            const ownedWritable = await driver.openWritableFile!("/file");
            writable = ownedWritable;
            releases.push(async () => {
              await ownedWritable.close();
              events.push("writable");
            });
            const ownedSync = await driver.openSyncFile!("/file");
            sync = ownedSync;
            releases.push(() => {
              ownedSync.close();
              events.push("sync");
            });
            if (phase === "cleanup") {
              releases.push(() => {
                events.push("failed-release");
                throw cleanup;
              });
            }
            throw primary;
          });
        } catch (reason) {
          failure = reason;
        }
        if (phase === "cleanup") {
          expect(failure).toBeInstanceOf(AggregateError);
          expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
        } else {
          expect(failure).toBe(primary);
        }
        await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
        expect(events).toEqual(
          phase === "setup"
            ? ["root"]
            : [...(phase === "cleanup" ? ["failed-release"] : []), "sync", "writable", "facade", "root"],
        );
        if (writable !== undefined) {
          await expect(writable.write(new Uint8Array([1]), { at: 0 })).rejects.toBeInstanceOf(TypeError);
        }
        const closedSync = sync;
        if (closedSync !== undefined) expect(() => closedSync.read(new Uint8Array(1))).toThrow();
      }
    });

    it(`${name} propagates profile through direct driver/adapter and rejects before nonexistent-root probes`, {
      skip: !available,
    }, async () => {
      const root = join(tmpdir(), `opfs-no-root-${crypto.randomUUID()}`);
      const driver = create({ root, createRoot: false, profile: "mountpoint-s3" });
      await expect(driver.copy!("/parents/missing", "/parents/result", { overwrite: false })).rejects.toMatchObject({
        code: "not-supported",
      });
      await expect(driver.move!("/parents/missing", "/parents/result", { overwrite: true })).rejects.toMatchObject({
        code: "not-supported",
      });
      await expect(driver.openWritableFile!("/missing")).rejects.toMatchObject({ code: "not-supported" });
      await expect(driver.openSyncFile!("/missing")).rejects.toMatchObject({ code: "not-supported" });
      const readOnly = create({ root, profile: { ...HOST_PROFILES.native, readOnly: true } });
      await expect(readOnly.writeFile("/file", new Uint8Array([1]), { mode: "replace" })).rejects.toMatchObject({
        code: "not-supported",
      });
      expect(() => create({ root, createRoot: true, profile: { ...HOST_PROFILES.native, readOnly: true } })).toThrow(
        TypeError,
      );
      expect(await readdir(root).catch(() => null)).toBe(null);
    });

    it(
      `${name} explicit best-effort copy selects a direct writer, while default rejects and ordinary native preserves`,
      { skip: !available },
      async () =>
        await withReleases(async (releases) => {
          const root = await mkdtemp(join(tmpdir(), "opfs-profile-"));
          releases.push(() => rm(root, { recursive: true, force: true }));
          const adapter = createFileAdapter(create({ root, profile: "blobfuse-block" }));
          const fs = createFileSystem(adapter);
          releases.push(() => fs.close());
          let nativeCopies = 0;
          adapter.copy = async () => {
            nativeCopies++;
            throw new Error("Strong staged native copy must not be selected");
          };
          await fs.writeFile("/source", "exact source");
          await fs.writeFile("/old", "valuable");
          expect(
            fs.plan({ operation: "copy", path: "/source", destination: "/old", overwrite: true, preserve: false })
              .supported,
          ).toBe(true);
          await expect(fs.copy("/source", "/old", { overwrite: true })).rejects.toMatchObject({
            code: "not-supported",
          });
          expect(await fs.readText("/old")).toBe("valuable");
          await fs.copy("/source", "/old", { overwrite: true, preserve: false });
          expect(await fs.readText("/old")).toBe("exact source");
          expect(nativeCopies).toBe(0);
          expect((await readdir(root)).sort()).toEqual(["old", "source"]);
          const native = createFileSystem(createFileAdapter(create({ root })));
          releases.push(() => native.close());
          try {
            await native.copy("/source", "/new", { exclusive: true });
            expect(await native.readText("/new")).toBe("exact source");
            await native.copy("/source", "/weaker", { preserve: false });
            expect(await native.readText("/weaker")).toBe("exact source");
            expect(native.getMetrics().operations.copy).toMatchObject({ native: 1, emulated: 1, failures: 0 });
            await native.move("/weaker", "/moved");
            expect(native.getMetrics().operations.move).toMatchObject({ native: 1, emulated: 0, failures: 0 });
            const fallback = createFileSystem(createFileAdapter(create({ root })), {
              optimizations: { nativeMove: false },
            });
            releases.push(() => fallback.close());
            try {
              await fallback.move("/moved", "/fallback");
              expect(await fallback.readText("/fallback")).toBe("exact source");
              expect(fallback.getMetrics().operations.move).toMatchObject({ native: 0, emulated: 1, failures: 0 });
            } finally {
              await fallback.close();
            }
          } finally {
            await native.close();
          }
        }),
    );
  }
});

// These controls pause at real native await boundaries, rather than proving only
// a pre-aborted facade call. The proxy owns the same file and records its close.
describe("direct host cancellation admission", () => {
  for (const [name, create] of [["node", createNodeDriver], ["deno", createDenoDriver]] as const) {
    for (const source of ["bytes", "stream"] as const) {
      for (const stage of ["open", "stat", "seek", "write"] as const) {
        it(`${name} ${source} stops after ${stage} before a later write or truncate`, {
          skip: (name === "deno" && typeof Deno === "undefined") || (name === "node" && stage === "seek"),
        }, async () =>
          await withReleases(async (releases) => {
            const root = await mkdtemp(join(tmpdir(), "opfs-write-signal-"));
            releases.push(() => rm(root, { recursive: true, force: true }));
            const driver = create({ root });
            const original = new TextEncoder().encode("valuable");
            await driver.writeFile("/file", original, { mode: "replace" });
            const controller = new AbortController();
            const api = name === "deno" ? Deno : process.getBuiltinModule("node:fs/promises");
            if (api === undefined) throw new Error("Native filesystem API is unavailable.");
            const open = Reflect.get(api, "open") as (...args: unknown[]) => Promise<object>;
            const counts = { write: 0, truncate: 0, close: 0 };
            releases.push(() => {
              Reflect.set(api, "open", open);
            });
            Reflect.set(api, "open", async (...args: unknown[]) => {
              const file = await Reflect.apply(open, api, args);
              if (stage === "open") controller.abort(stage);
              return new Proxy(file, {
                get(target, key) {
                  const method = Reflect.get(target, key);
                  if (typeof method !== "function") return method;
                  if (key === "close") {
                    return (...values: unknown[]) => {
                      counts.close++;
                      return Reflect.apply(method, target, values);
                    };
                  }
                  return async (...values: unknown[]) => {
                    if (key === "write") {
                      counts.write++;
                      // Force a real partial write so a missing loop check would
                      // dispatch a second mutation after the abort.
                      if (name === "deno") values[0] = (values[0] as Uint8Array).subarray(0, 1);
                      else values[2] = 1;
                    }
                    if (key === "truncate") counts.truncate++;
                    const result = await Reflect.apply(method, target, values);
                    if (key === stage) controller.abort(stage);
                    return result;
                  };
                },
              });
            });
            const mode = stage === "stat" ? "append" : "update";
            const bytes = new TextEncoder().encode("NEW");
            const options: FileDriverWriteOptionsType = { mode, at: 0, truncate: true, signal: controller.signal };
            const write = source === "bytes"
              ? driver.writeFile("/file", bytes, options)
              : driver.writeStream!("/file", new Blob([bytes]).stream(), options);
            assertWriteAbort(
              await failureOf(write),
              stage,
              source === "stream" || (name === "node" && stage === "stat"),
            );
            expect(counts.write).toBe(stage === "write" ? 1 : 0);
            expect(counts.truncate).toBe(0);
            expect(counts.close).toBe(1);
            Reflect.set(api, "open", open);
            expect(new TextDecoder().decode(await driver.readFile("/file"))).toBe(
              stage === "write" ? "Naluable" : "valuable",
            );
          }));
      }
    }
  }
});

it("Deno tail stream abort cancels the native reader and closes its actual file", {
  skip: typeof Deno === "undefined",
}, async () =>
  await withReleases(async (releases) => {
    const root = await mkdtemp(join(tmpdir(), "opfs-tail-close-"));
    releases.push(() => rm(root, { recursive: true, force: true }));
    const driver = createDenoDriver({ root });
    await driver.writeFile("/file", new Uint8Array(256 * 1024), { mode: "replace" });
    const originalOpen = Deno.open;
    const released = gate();
    let native: Deno.FsFile | undefined;
    releases.push(() => {
      Deno.open = originalOpen;
    });
    Deno.open = async (...args: Parameters<typeof Deno.open>) => {
      const file = await originalOpen(...args);
      native = file;
      return new Proxy(file, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (key === "readable") {
            const source = value as ReadableStream<Uint8Array>;
            const reader = source.getReader();
            const release = reader.releaseLock.bind(reader);
            reader.releaseLock = () => {
              release();
              released.resolve();
            };
            Reflect.set(source, "getReader", () => reader);
            return source;
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    const controller = new AbortController();
    const source = await driver.openReadStream!("/file", { signal: controller.signal });
    const reader = source.getReader();
    releases.push(() => reader.releaseLock());
    releases.push(() => within(reader.cancel().catch(() => undefined), "Deno native read teardown"));
    controller.abort("close actual native file");
    assertReadAbort(await failureOf(reader.read()), "deno", "close actual native file");
    await within(released.promise, "Deno native reader release");
    const closedFile = native;
    expect(closedFile).toBeDefined();
    await expect(closedFile!.stat()).rejects.toBeInstanceOf(Deno.errors.BadResource);
  }));

it("Node tail stream abort closes the actual native stream descriptor", async () =>
  await withReleases(async (releases) => {
    const root = await mkdtemp(join(tmpdir(), "opfs-node-tail-close-"));
    releases.push(() => rm(root, { recursive: true, force: true }));
    const driver = createNodeDriver({ root });
    await driver.writeFile("/file", new Uint8Array(256 * 1024), { mode: "replace" });
    const api = process.getBuiltinModule("node:fs") as typeof import("node:fs");
    const original = api.createReadStream;
    const closed = gate();
    let native: import("node:fs").ReadStream | undefined;
    releases.push(() => {
      api.createReadStream = original;
    });
    api.createReadStream = (...args: Parameters<typeof original>) => {
      const stream = original(...args);
      native = stream;
      stream.once("close", closed.resolve);
      return stream;
    };
    const controller = new AbortController();
    const source = await driver.openReadStream!("/file", { signal: controller.signal });
    const reader = source.getReader();
    releases.push(() => reader.releaseLock());
    releases.push(() => within(reader.cancel().catch(() => undefined), "Node native read teardown"));
    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0);
    controller.abort("close native descriptor");
    assertReadAbort(await failureOf(reader.read()), "node", "close native descriptor");
    await within(closed.promise, "Node native descriptor close");
    expect(native?.destroyed).toBe(true);
    expect(native?.closed).toBe(true);
  }));

/** Captures rejection separately from a successful undefined value. */
async function failureOf(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected an actual rejected operation.");
}

/** Patches only an owned test's native API method and restores it before retiring the root. */
function replaceNative(
  releases: Array<() => void | Promise<unknown>>,
  api: object,
  method: string,
  replacement: (...args: unknown[]) => unknown,
): void {
  const original: unknown = Reflect.get(api, method);
  releases.push(() => {
    Reflect.set(api, method, original);
  });
  Reflect.set(api, method, replacement);
}

describe("native retirement observations", () => {
  for (const [name, create] of [["node", createNodeDriver], ["deno", createDenoDriver]] as const) {
    const options = { skip: name === "deno" && typeof Deno === "undefined" };
    it(
      `${name} leaves a newly recreated old stage name after acknowledged rename`,
      options,
      async () =>
        await withReleases(async (releases) => {
          const root = await mkdtemp(join(tmpdir(), "opfs-stage-owner-"));
          releases.push(() => rm(root, { recursive: true, force: true }));
          const driver = create({ root });
          await driver.writeFile("/source", new Uint8Array([1, 2, 3]), { mode: "replace" });
          const api = name === "deno" ? Deno : process.getBuiltinModule("node:fs/promises");
          if (api === undefined) throw new Error("Native filesystem API is unavailable.");
          const rename = Reflect.get(api, "rename") as (...args: unknown[]) => Promise<void>;
          let oldStage: string | undefined;
          replaceNative(releases, api, "rename", async (...args) => {
            await Reflect.apply(rename, api, args);
            oldStage = String(args[0]);
            await nativeWriteFile(oldStage, new Uint8Array([9, 8, 7]));
          });
          await driver.copy!("/source", "/destination", { overwrite: true });
          expect(await driver.readFile("/destination")).toEqual(new Uint8Array([1, 2, 3]));
          expect(oldStage).toBeDefined();
          expect([...await nativeReadFile(oldStage!)]).toEqual([9, 8, 7]);
        }),
    );

    for (const failsBeforePublication of [false, true]) {
      it(
        `${name} retains ${failsBeforePublication ? "copy and cleanup" : "link-publication cleanup"} failures`,
        options,
        async () =>
          await withReleases(async (releases) => {
            const root = await mkdtemp(join(tmpdir(), "opfs-stage-fault-"));
            releases.push(() => rm(root, { recursive: true, force: true }));
            const driver = create({ root });
            await driver.writeFile("/source", new Uint8Array([4, 5]), { mode: "replace" });
            const api = name === "deno" ? Deno : process.getBuiltinModule("node:fs/promises");
            if (api === undefined) throw new Error("Native filesystem API is unavailable.");
            const reason = new Error("Authored independent copy/retirement events.");
            const retirement = name === "deno" ? "remove" : "unlink";
            let removals = 0;
            replaceNative(releases, api, retirement, () => {
              removals++;
              throw reason;
            });
            if (failsBeforePublication) {
              replaceNative(releases, api, "copyFile", () => {
                throw reason;
              });
            }
            const failure = await failureOf(driver.copy!("/source", "/destination", { overwrite: false }));
            if (failsBeforePublication) {
              expect(failure).toBeInstanceOf(AggregateError);
              expect((failure as AggregateError).errors).toEqual([reason, reason]);
              expect((failure as AggregateError).cause).toBe(reason);
              await expect(nativeReadFile(join(root, "destination"))).rejects.toMatchObject({ code: "ENOENT" });
            } else {
              expect(failure).toBe(reason);
              expect([...await nativeReadFile(join(root, "destination"))]).toEqual([4, 5]);
            }
            expect(removals).toBe(1);
            expect((await readdir(root)).length).toBe(failsBeforePublication ? 2 : 3);
          }),
      );
    }

    it(
      `${name} removes its acquired stage after reservation close fails`,
      options,
      async () =>
        await withReleases(async (releases) => {
          const root = await mkdtemp(join(tmpdir(), "opfs-reservation-close-"));
          releases.push(() => rm(root, { recursive: true, force: true }));
          const driver = create({ root });
          await driver.writeFile("/source", new Uint8Array([1]), { mode: "replace" });
          const api = name === "deno" ? Deno : process.getBuiltinModule("node:fs/promises");
          if (api === undefined) throw new Error("Native filesystem API is unavailable.");
          const open = Reflect.get(api, "open") as (...args: unknown[]) => Promise<object>;
          const reason = new Error("Authored reservation close fault.");
          let closes = 0;
          replaceNative(releases, api, "open", async (...args) => {
            const file = await Reflect.apply(open, api, args);
            const nativeClose = Reflect.get(file, "close");
            let retired = false;
            releases.push(async () => {
              if (!retired) {
                await Reflect.apply(nativeClose, file, []);
                retired = true;
              }
            });
            return new Proxy(file, {
              get(target, key) {
                const value = Reflect.get(target, key);
                if (key === "close") {
                  return name === "deno"
                    ? () => {
                      closes++;
                      Reflect.apply(value, target, []);
                      retired = true;
                      throw reason;
                    }
                    : async () => {
                      closes++;
                      await Reflect.apply(value, target, []);
                      retired = true;
                      throw reason;
                    };
                }
                return typeof value === "function" ? value.bind(target) : value;
              },
            });
          });
          expect(await failureOf(driver.copy!("/source", "/destination", { overwrite: true }))).toBe(reason);
          expect(closes).toBe(1);
          expect(await readdir(root)).toEqual(["source"]);
        }),
    );

    for (const reason of [undefined, null, new Error("Authored native write fault.")]) {
      it(
        `${name} retains write/cancel/release/file-close events (${String(reason)})`,
        options,
        async () =>
          await withReleases(async (releases) => {
            const root = await mkdtemp(join(tmpdir(), "opfs-native-fault-"));
            releases.push(() => rm(root, { recursive: true, force: true }));
            const driver = create({ root });
            const api = name === "deno" ? Deno : process.getBuiltinModule("node:fs/promises");
            if (api === undefined) throw new Error("Native filesystem API is unavailable.");
            const open = Reflect.get(api, "open") as (...args: unknown[]) => Promise<object>;
            const cancelFault = new Error("Authored producer cancel fault.");
            const releaseFault = new Error("Authored reader release fault.");
            const closeFault = new Error("Authored native close fault.");
            let closes = 0, cancels = 0, unlocked = 0;
            replaceNative(releases, api, "open", async (...args) => {
              const file = await Reflect.apply(open, api, args);
              const nativeClose = Reflect.get(file, "close");
              let retired = false;
              releases.push(async () => {
                if (!retired) {
                  await Reflect.apply(nativeClose, file, []);
                  retired = true;
                }
              });
              return new Proxy(file, {
                get(target, key) {
                  const value = Reflect.get(target, key);
                  if (key === "write") {
                    return () => {
                      throw reason;
                    };
                  }
                  if (key === "close") {
                    return name === "deno"
                      ? () => {
                        closes++;
                        Reflect.apply(value, target, []);
                        retired = true;
                        throw closeFault;
                      }
                      : async () => {
                        closes++;
                        await Reflect.apply(value, target, []);
                        retired = true;
                        throw closeFault;
                      };
                  }
                  return typeof value === "function" ? value.bind(target) : value;
                },
              });
            });
            const source = new ReadableStream<Uint8Array>({
              pull(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              cancel() {
                cancels++;
                throw cancelFault;
              },
            }, { highWaterMark: 0 });
            const reader = source.getReader();
            const release = reader.releaseLock.bind(reader);
            releases.push(() => {
              if (source.locked) release();
            });
            reader.releaseLock = () => {
              release();
              unlocked++;
              throw releaseFault;
            };
            Reflect.set(source, "getReader", () => reader);
            const failure = await failureOf(driver.writeStream!("/file", source, { mode: "replace" }));
            expect(failure).toBeInstanceOf(AggregateError);
            const outer = failure as AggregateError;
            expect(outer.errors[1]).toBe(closeFault);
            expect(outer.errors[0]).toBeInstanceOf(AggregateError);
            const input = outer.errors[0] as AggregateError;
            expect(faultsOf(input)).toEqual([reason, cancelFault, releaseFault]);
            expect(input.cause).toBe(reason);
            expect(cancels).toBe(1);
            expect(unlocked).toBe(1);
            expect(closes).toBe(1);
            expect(source.locked).toBe(false);
          }),
      );
    }
  }
});

for (const [name, create] of [["node", createNodeDriver], ["deno", createDenoDriver]] as const) {
  for (const operation of ["range-read", "update-write", "stream-eof"] as const) {
    it(`${name} composes ${operation} settlement with native close`, {
      skip: name === "deno" && typeof Deno === "undefined",
    }, async () =>
      await withReleases(async (releases) => {
        const root = await mkdtemp(join(tmpdir(), "opfs-native-close-"));
        releases.push(() => rm(root, { recursive: true, force: true }));
        const driver = create({ root });
        await driver.writeFile("/file", new Uint8Array([1, 2]), { mode: "replace" });
        const api = name === "deno" ? Deno : process.getBuiltinModule("node:fs/promises");
        if (api === undefined) throw new Error("Native filesystem API is unavailable.");
        const open = Reflect.get(api, "open") as (...args: unknown[]) => Promise<object>;
        const primary = new Error("Authored native I/O fault.");
        const retirement = new Error("Authored descriptor retirement fault.");
        let closes = 0;
        replaceNative(releases, api, "open", async (...args) => {
          const file = await Reflect.apply(open, api, args);
          const nativeClose = Reflect.get(file, "close");
          let retired = false;
          releases.push(async () => {
            if (!retired) {
              await Reflect.apply(nativeClose, file, []);
              retired = true;
            }
          });
          return new Proxy(file, {
            get(target, key) {
              const value = Reflect.get(target, key);
              if (key === (operation === "range-read" ? "read" : "write") && operation !== "stream-eof") {
                return () => {
                  throw primary;
                };
              }
              if (key === "close") {
                return name === "deno"
                  ? () => {
                    closes++;
                    Reflect.apply(value, target, []);
                    retired = true;
                    throw retirement;
                  }
                  : async () => {
                    closes++;
                    await Reflect.apply(value, target, []);
                    retired = true;
                    throw retirement;
                  };
              }
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
        });
        const action = operation === "range-read"
          ? driver.readFile("/file", { at: 0, length: 1 })
          : operation === "update-write"
          ? driver.writeFile("/file", new Uint8Array([7]), { mode: "update" })
          : driver.writeStream!("/file", new Blob([new Uint8Array([8, 9])]).stream(), { mode: "replace" });
        const failure = await failureOf(action);
        if (operation === "stream-eof") expect(failure).toBe(retirement);
        else {
          expect(failure).toBeInstanceOf(AggregateError);
          expect((failure as AggregateError).errors).toEqual([primary, retirement]);
          expect((failure as AggregateError).cause).toBe(primary);
        }
        expect(closes).toBe(1);
      }));
  }
}

for (const [name, create] of [["node", createNodeDriver], ["deno", createDenoDriver]] as const) {
  it(`${name} refuses a collided reservation without removing the unowned entry`, {
    skip: name === "deno" && typeof Deno === "undefined",
  }, async () =>
    await withReleases(async (releases) => {
      const root = await mkdtemp(join(tmpdir(), "opfs-unowned-stage-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      const driver = create({ root });
      await driver.writeFile("/source", new Uint8Array([1]), { mode: "replace" });
      const api = name === "deno" ? Deno : process.getBuiltinModule("node:fs/promises");
      if (api === undefined) throw new Error("Native filesystem API is unavailable.");
      const open = Reflect.get(api, "open") as (...args: unknown[]) => Promise<object>;
      const remove = Reflect.get(api, name === "deno" ? "remove" : "unlink") as (...args: unknown[]) => Promise<void>;
      let collided: string | undefined, removals = 0;
      replaceNative(releases, api, name === "deno" ? "remove" : "unlink", (...args) => {
        removals++;
        return Reflect.apply(remove, api, args);
      });
      replaceNative(releases, api, "open", async (...args) => {
        collided = String(args[0]);
        await nativeWriteFile(collided, new Uint8Array([6, 7]));
        return await Reflect.apply(open, api, args);
      });
      await failureOf(driver.copy!("/source", "/destination", { overwrite: true }));
      expect(removals).toBe(0);
      expect(collided).toBeDefined();
      expect([...await nativeReadFile(collided!)]).toEqual([6, 7]);
      expect(await readdir(root)).toContain("source");
      await expect(nativeReadFile(join(root, "destination"))).rejects.toMatchObject({ code: "ENOENT" });
    }));
}

for (const [name, create] of [["node", createNodeDriver], ["deno", createDenoDriver]] as const) {
  it(`${name} refuses an invalid byte chunk and retires its acquired file`, {
    skip: name === "deno" && typeof Deno === "undefined",
  }, async () =>
    await withReleases(async (releases) => {
      const root = await mkdtemp(join(tmpdir(), "opfs-native-byte-admission-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      const driver = create({ root });
      let cancels = 0;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          Reflect.apply(controller.enqueue, controller, ["wrong JavaScript bytes"]);
        },
        cancel() {
          cancels++;
        },
      }, { highWaterMark: 0 });
      expect(await failureOf(driver.writeStream!("/file", source, { mode: "replace" }))).toBeInstanceOf(TypeError);
      expect(cancels).toBe(1);
      expect(source.locked).toBe(false);
      // Native replacement acquired/truncated the file; input was never silently published as valid bytes.
      expect([...await nativeReadFile(join(root, "file"))]).toEqual([]);
    }));
}

for (const mode of ["success", "read-fault", "close-fault", "read-and-close-fault", "reentrant-cancel"] as const) {
  it(`Deno range cancellation joins a held native read: ${mode}`, {
    skip: typeof Deno === "undefined",
  }, async () =>
    await withReleases(async (releases) => {
      const root = await mkdtemp(join(tmpdir(), "opfs-range-retirement-"));
      releases.push(() => rm(root, { recursive: true, force: true }));
      const path = join(root, "file");
      await nativeWriteFile(path, new Uint8Array([1, 2, 3]));
      const file = await Deno.open(path, { read: true });
      let physicallyClosed = false;
      releases.push(() => {
        if (!physicallyClosed) file.close();
      });
      const admitted = gate(), releaseRead = gate();
      const readFault = new Error("Authored range read retirement fault.");
      // Equal-valued faults still represent two independently settled native actions.
      const closeFault = mode === "read-and-close-fault" ? readFault : new Error("Authored range close fault.");
      let closes = 0;
      let reentrant: Promise<void> | undefined;
      let reentrantBytes: readonly number[] | undefined;
      const owned = new Proxy(file, {
        get(target, key) {
          if (key === "read") {
            return async (buffer: Uint8Array) => {
              // The reentrant case uses real synchronous file bytes before requesting
              // cancellation from inside this admitted asynchronous method.
              const count = mode === "reentrant-cancel" ? target.readSync(buffer) : await target.read(buffer);
              if (mode === "reentrant-cancel") {
                reentrantBytes = [...buffer.subarray(0, count ?? 0)];
                reentrant = source.cancel();
                // The child effect owns both reactions before the parent assertions.
                void reentrant.catch(() => {});
              }
              admitted.resolve();
              await releaseRead.promise;
              if (mode === "read-fault" || mode === "read-and-close-fault") throw readFault;
              return count;
            };
          }
          if (key === "close") {
            return () => {
              closes++;
              target.close();
              physicallyClosed = true;
              if (mode === "close-fault" || mode === "read-and-close-fault") throw closeFault;
            };
          }
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const source = new DenoRangeSource(owned, 3);
      let enqueues = 0, errors = 0, cancellationConsumed = false;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enqueue = controller.enqueue.bind(controller), error = controller.error.bind(controller);
          controller.enqueue = (chunk) => {
            enqueues++;
            enqueue(chunk);
          };
          controller.error = (reason) => {
            errors++;
            error(reason);
          };
        },
        pull: (controller) => source.pull(controller),
        cancel: () => source.cancel(),
      }, { highWaterMark: 0 });
      releases.push(async () => {
        releaseRead.resolve();
        if (!cancellationConsumed) await source.cancel();
      });
      const reader = stream.getReader();
      releases.push(() => reader.releaseLock());
      const reading = reader.read().then(
        (value) => ({ ok: true as const, value }),
        (reason: unknown) => ({ ok: false as const, reason }),
      );
      releases.push(async () => {
        releaseRead.resolve();
        const outcome = await reading;
        if (!outcome.ok) throw outcome.reason;
      });
      await within(admitted.promise, "native range read admission");
      let settled = false;
      const stopping = reader.cancel().then(
        () => {
          settled = true;
          return { ok: true as const };
        },
        (reason: unknown) => {
          settled = true;
          return { ok: false as const, reason };
        },
      );
      releases.push(async () => {
        releaseRead.resolve();
        await stopping;
      });
      await setImmediate();
      expect(closes).toBe(1);
      expect(physicallyClosed).toBe(true);
      // Independent read gate remains held after a complete native task checkpoint.
      expect(settled).toBe(false);
      const terminal = source.cancel();
      expect(source.cancel()).toBe(terminal);
      if (mode === "reentrant-cancel") {
        expect(reentrant).toBe(terminal);
        expect(reentrantBytes).toEqual([1, 2, 3]);
      }
      releaseRead.resolve();
      const outcome = await within(stopping, "range cancellation joins native read");
      cancellationConsumed = true;
      if (mode === "success" || mode === "reentrant-cancel") expect(outcome.ok).toBe(true);
      else {
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error("Range cancellation unexpectedly succeeded.");
        if (mode === "read-and-close-fault") {
          expect(outcome.reason).toBeInstanceOf(AggregateError);
          expect((outcome.reason as AggregateError).errors).toEqual([closeFault, readFault]);
        } else expect(outcome.reason).toBe(mode === "read-fault" ? readFault : closeFault);
      }
      expect(await reading).toEqual({ ok: true, value: { done: true, value: undefined } });
      expect(enqueues).toBe(0);
      expect(errors).toBe(0);
      expect(closes).toBe(1);
      reader.releaseLock();
      expect(stream.locked).toBe(false);
    }));
}
