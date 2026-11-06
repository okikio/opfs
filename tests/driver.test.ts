import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { setImmediate } from "node:timers/promises";
import { close as closeFixture, withReleases } from "./close.ts";
import { within } from "./gate.ts";

import { createFileSystem } from "../mod.ts";
import { createRecordAdapter } from "../src/adapter/record.ts";
import { createKeyValueBridge } from "../src/bridge/kv.ts";
import { createCacheDriver } from "../src/driver/cache.ts";
import { createUnstorageDriver, type UnstorageStorageType } from "../src/driver/unstorage.ts";
import { defineDriver } from "../src/driver/definition.ts";
import {
  createOpfsDriver,
  type OpfsDirectoryHandleType,
  type OpfsFileHandleType,
  type OpfsWritableFileStreamType,
} from "../src/driver/opfs.ts";
import { defineRecordDriver, type RecordBackendType } from "../src/driver/record.ts";
import type { PathType } from "../src/schema.ts";
import type { RecordType } from "../src/schema.ts";

/** Minimal deterministic record backend used to prove the public driver extension seam. */
class TestRecordBackend implements RecordBackendType {
  /** In-memory records keyed by canonical virtual path. */
  readonly #records = new Map<PathType, RecordType>();
  disposed = false;

  /** Returns one exact record. */
  async get(path: PathType): Promise<RecordType | null> {
    return this.#records.get(path) ?? null;
  }

  /** Replaces one exact record. */
  async set(record: RecordType): Promise<void> {
    this.#records.set(record.path, record);
  }

  /** Removes one exact record. */
  async delete(path: PathType): Promise<void> {
    this.#records.delete(path);
  }

  /** Iterates only records whose stored parent matches the requested directory. */
  async *list(parent: PathType): AsyncIterableIterator<RecordType> {
    for (const record of this.#records.values()) {
      if (record.parent === parent) yield record;
    }
  }

  /** Marks disposal so ownership tests can distinguish borrowed and owned backends. */
  dispose(): void {
    this.disposed = true;
  }
}

describe("driver contract", () => {
  it("keeps constructor policy and inspection snapshots detached from caller mutation", async () => {
    const options = { name: "snapshot", readOnly: true };
    const backend = new TestRecordBackend();
    const driver = defineRecordDriver(backend, options);
    options.readOnly = false;
    expect(driver.plan({ operation: "write", path: "/value" }).supported).toBe(false);
    expect(() => driver.delete("/value")).toThrow("read-only");
    const metadata = defineDriver({
      name: "facts",
      kind: "record",
      limits: [{ code: "file-bytes", kind: "policy", source: "user", unit: "bytes", value: 8 }],
    });
    expect(Reflect.set(metadata.limits[0]!, "value", 99)).toBe(false);
    const first = metadata.inspect();
    Reflect.set(first.limits[0]!, "value", 99);
    expect(metadata.inspect().limits[0]!.value).toBe(8);
    const limits = { maxFileBytes: 8 };
    const adapter = createRecordAdapter(driver, { limits });
    limits.maxFileBytes = 99;
    const fs = createFileSystem(adapter);
    try {
      const report = fs.inspect();
      Reflect.set(report.adapter.native, "write", true);
      Reflect.set(report.adapter.limits!, "maxFileBytes", 123);
      Reflect.set(report.optimizations, "writeAdmission", true);
      expect(fs.inspect().adapter.native.write).toBe(false);
      expect(fs.inspect().adapter.limits!.maxFileBytes).toBe(8);
      expect(fs.inspect().optimizations.writeAdmission).toBe(false);
      await expect(fs.writeFile("/value", "x")).rejects.toMatchObject({ code: "not-supported" });
    } finally {
      await fs.close();
    }
  });

  it("preserves backend write:false and rejects facade/bridge mutations before any backend work", async () => {
    let calls = 0;
    const fail = (): never => {
      calls++;
      throw new Error("unexpected backend access");
    };
    const backend: RecordBackendType = {
      capabilities: { write: false },
      async get() {
        return fail();
      },
      async set() {
        fail();
      },
      async delete() {
        fail();
      },
      async *list() {
        yield fail();
      },
    };
    const driver = defineRecordDriver(backend, { name: "read-only-backend", capabilities: { write: true } });
    expect(driver.capabilities.write).toBe(false);
    const fs = createFileSystem(createRecordAdapter(driver));
    try {
      await expect(fs.writeFile("/missing/child", "x", { parents: true })).rejects.toMatchObject({
        code: "not-supported",
      });
      await expect(fs.remove("/value")).rejects.toMatchObject({ code: "not-supported" });
      await expect(createKeyValueBridge(fs).set("value", "x")).rejects.toMatchObject({ code: "not-supported" });
      expect(calls).toBe(0);
    } finally {
      await fs.close();
    }
  });

  it("ignores malformed and noncanonical unstorage key aliases while listing owned records", async () => {
    const values = new Map<string, unknown>();
    const storage: UnstorageStorageType = {
      async getItem<T>(key: string): Promise<T | null> {
        return values.get(key) as T ?? null;
      },
      async setItem(key, value) {
        values.set(key, value);
      },
      async removeItem(key) {
        values.delete(key);
      },
      async getKeys(base = "") {
        return [...values.keys()].filter((key) => key.startsWith(base));
      },
    };
    const driver = createUnstorageDriver(storage);
    await driver.set({ version: 1, path: "/valid", parent: "/", name: "valid", kind: "directory", lastModified: 0 });
    values.set("opfs:record:~ZZ", {});
    values.set("opfs:record:~2Fwrong~2F..~2Fvalid", {});
    const records = [];
    for await (const record of driver.list("/")) records.push(record.path);
    expect(records).toEqual(["/valid"]);
  });

  it("keeps unrelated Cache origins and request aliases outside the owned record namespace", async () => {
    const canonical = new Request("https://opfs.invalid/opfs/%2Fvalid");
    const foreign = new Request("https://outside.invalid/opfs/%2Fforeign");
    const query = new Request("https://opfs.invalid/opfs/%2Fquery?foreign=1");
    const alias = new Request("https://opfs.invalid/opfs/%2falias");
    const matched: string[] = [];
    const cache = {
      async keys() {
        return [foreign, query, alias, canonical];
      },
      async match(request: Request) {
        matched.push(request.url);
        return Response.json({
          version: 1,
          path: "/valid",
          parent: "/",
          name: "valid",
          kind: "directory",
          lastModified: 0,
        });
      },
    } as unknown as Cache;
    const records = [];
    for await (const record of createCacheDriver(cache).list("/")) records.push(record.path);
    expect(records).toEqual(["/valid"]);
    expect(matched).toEqual([canonical.url]);
  });

  it("does not publish a staged OPFS write when the producer aborts at EOF", async () => {
    const controller = new AbortController();
    let commits = 0;
    let aborts = 0;
    const writable: OpfsWritableFileStreamType = {
      async write() {},
      async seek() {},
      async truncate() {},
      async close() {
        commits += 1;
      },
      async abort() {
        aborts += 1;
      },
    };
    const file: OpfsFileHandleType = {
      kind: "file",
      name: "abort.bin",
      async getFile() {
        return new File([], "abort.bin");
      },
      async createWritable() {
        return writable;
      },
    };
    const root: OpfsDirectoryHandleType = {
      kind: "directory",
      name: "",
      async getFileHandle() {
        return file;
      },
      async getDirectoryHandle() {
        return root;
      },
      async removeEntry() {},
      async *entries() {},
    };
    const source = new ReadableStream<Uint8Array>({
      pull(stream) {
        stream.close();
        controller.abort("producer finished after cancellation");
      },
    }, { highWaterMark: 0 });
    const driver = createOpfsDriver(root);
    await expect(driver.writeStream!("/abort.bin" as PathType, source, {
      mode: "replace",
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "aborted" });
    expect(commits).toBe(0);
    expect(aborts).toBe(1);
  });

  it("keeps requirements, limits, and optimizations as structured inspectable data", () => {
    const driver = defineDriver({
      name: "fixture",
      kind: "record",
      provides: ["get", "set", "list"],
      ownership: "borrowed",
      requirements: [{ code: "database", state: "available" }],
      limits: [
        { code: "value-bytes", kind: "hard", source: "provider", unit: "bytes", value: 64 * 1024 },
        {
          code: "quota-bytes",
          kind: "dynamic",
          source: "probe",
          unit: "bytes",
          detail: "Probe storage quota before admission.",
        },
      ],
      optimizations: [
        { code: "partition", enabled: true, changesBehavior: true, disableable: true },
      ],
    });

    expect(driver.inspect()).toMatchObject({
      name: "fixture",
      kind: "record",
      provides: ["get", "set", "list"],
      ownership: "borrowed",
      requirements: [{ code: "database", state: "available" }],
      limits: [
        { code: "value-bytes", kind: "hard", source: "provider" },
        { code: "quota-bytes", kind: "dynamic", source: "probe" },
      ],
      optimizations: [{ code: "partition", enabled: true, changesBehavior: true, disableable: true }],
    });
  });

  it("rejects a behavior-changing optimization that cannot be disabled", () => {
    expect(() =>
      defineDriver({
        name: "unsafe",
        kind: "object",
        optimizations: [{ code: "cache", enabled: true, changesBehavior: true, disableable: false }],
      })
    ).toThrow(TypeError);
  });

  it("lets a third-party record driver preflight logical size before an adapter exists", () => {
    const driver = defineRecordDriver(new TestRecordBackend(), {
      name: "records",
      limits: [{ code: "file-bytes", kind: "policy", source: "user", unit: "bytes", value: 8 }],
    });

    expect(driver.plan({ operation: "write", path: "/small.bin", size: 8, source: "bytes", mode: "replace" }))
      .toMatchObject({
        supported: true,
        support: "native",
      });
    expect(driver.plan({ operation: "write", path: "/large.bin", size: 9, source: "bytes", mode: "replace" }))
      .toMatchObject({
        supported: false,
        support: "unsupported",
        problems: [{ code: "file-too-large", layer: "driver", severity: "error" }],
        actions: [{ kind: "reduce-input" }, { kind: "select-driver" }],
      });
  });

  it("enforces read-only policy at the driver seam before an adapter exists", () => {
    const backend = new TestRecordBackend();
    const driver = defineRecordDriver(backend, {
      name: "read-only",
      readOnly: true,
    });
    const record: RecordType = {
      version: 1,
      path: "/value" as PathType,
      parent: "/" as PathType,
      name: "value",
      kind: "directory",
      lastModified: 0,
    };

    expect(driver.capabilities.write).toBe(false);
    expect(driver.provides.includes("set")).toBe(false);
    expect(driver.provides.includes("delete")).toBe(false);
    expect(driver.plan({ operation: "write", path: "/value", size: 0, source: "bytes", mode: "replace" }))
      .toMatchObject({
        supported: false,
        problems: [{ code: "read-only", layer: "driver", severity: "error" }],
      });
    expect(() => driver.set(record)).toThrow();
  });

  it("copies SharedArrayBuffer-backed stream chunks before asynchronous OPFS writes", async () => {
    if (typeof SharedArrayBuffer !== "function") return;

    let nativeBytes: Uint8Array<ArrayBuffer> | undefined;
    const writable: OpfsWritableFileStreamType = {
      async write(data): Promise<void> {
        nativeBytes = data instanceof Uint8Array ? data : data.data;
      },
      async seek(): Promise<void> {},
      async truncate(): Promise<void> {},
      async close(): Promise<void> {},
      async abort(): Promise<void> {},
    };
    const file: OpfsFileHandleType = {
      kind: "file",
      name: "shared.bin",
      async getFile(): Promise<File> {
        throw new Error("The replace-mode regression test must not read the existing file.");
      },
      async createWritable(): Promise<OpfsWritableFileStreamType> {
        return writable;
      },
    };
    const root: OpfsDirectoryHandleType = {
      kind: "directory",
      name: "",
      async getFileHandle(): Promise<OpfsFileHandleType> {
        return file;
      },
      async getDirectoryHandle(): Promise<OpfsDirectoryHandleType> {
        return root;
      },
      async removeEntry(): Promise<void> {},
      async *entries(): AsyncIterableIterator<readonly [string, never]> {},
    };

    const shared = new SharedArrayBuffer(4);
    const sourceBytes = new Uint8Array(shared);
    sourceBytes.set([11, 22, 33, 44]);
    const source = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(sourceBytes);
        controller.close();
      },
    });

    const driver = createOpfsDriver(root);
    if (driver.writeStream === undefined) throw new Error("The OPFS driver must provide native streaming writes.");
    await driver.writeStream("/shared.bin" as PathType, source, { mode: "replace" });

    expect(nativeBytes).toBeDefined();
    expect(nativeBytes!.buffer instanceof ArrayBuffer).toBe(true);
    expect([...nativeBytes!]).toEqual([11, 22, 33, 44]);
  });

  it("disposes a borrowed backend only when ownership is transferred", async () => {
    const borrowed = new TestRecordBackend();
    const borrowedDriver = defineRecordDriver(borrowed, { name: "borrowed" });
    expect(borrowedDriver.dispose).toBeUndefined();
    expect(borrowed.disposed).toBe(false);

    const owned = new TestRecordBackend();
    const ownedDriver = defineRecordDriver(owned, { name: "owned", disposeBackend: true });
    await ownedDriver.dispose?.();
    expect(owned.disposed).toBe(true);
  });
});

/** One structural browser-root seam; these controls test driver ownership, not a real browser. */
function opfsWriter(
  writable: OpfsWritableFileStreamType,
  getFile = async () => new File([], "owned.bin"),
  acquired: () => void = () => {},
) {
  const file: OpfsFileHandleType = {
    kind: "file",
    name: "owned.bin",
    getFile,
    async createWritable() {
      acquired();
      return writable;
    },
  };
  const root: OpfsDirectoryHandleType = {
    kind: "directory",
    name: "",
    async getFileHandle() {
      return file;
    },
    async getDirectoryHandle() {
      return root;
    },
    async removeEntry() {},
    async *entries() {
      yield* [];
    },
  };
  return createOpfsDriver(root);
}

/** Enumerates authored fault events across ownership scopes without deduplicating equal reasons. */
function faultsOf(reason: unknown): readonly unknown[] {
  return reason instanceof AggregateError ? reason.errors.flatMap((nested: unknown) => faultsOf(nested)) : [reason];
}

/** Captures a rejected undefined reason without treating a successful void result as failure. */
async function rejected(action: Promise<unknown>): Promise<unknown> {
  try {
    await action;
  } catch (reason) {
    return reason;
  }
  throw new Error("Expected an actual rejected operation.");
}

/** Registers native lock retirement before any fallible behavioral assertion. */
function ownInput(
  releases: Array<() => void | Promise<unknown>>,
  source: ReadableStream<Uint8Array>,
): { reader: ReadableStreamDefaultReader<Uint8Array>; release: () => void } {
  const reader = source.getReader();
  const release = reader.releaseLock.bind(reader);
  releases.push(async () => {
    if (source.locked) await closeFixture([() => reader.cancel(), release]);
  });
  Reflect.set(source, "getReader", () => reader);
  return { reader, release };
}

describe("OPFS acquired resource retirement", () => {
  for (const reason of [undefined, null, new Error("Authored OPFS write fault.")]) {
    it(`retains write/cancel/release/abort events (${String(reason)})`, async () =>
      await withReleases(async (releases) => {
        const cancelFault = new Error("Authored producer cancellation fault.");
        const releaseFault = new Error("Authored reader release fault.");
        const abortFault = new Error("Authored writable abort fault.");
        let cancellations = 0, unlocks = 0, aborts = 0, commits = 0;
        const writable: OpfsWritableFileStreamType = {
          async write() {
            throw reason;
          },
          async seek() {},
          async truncate() {},
          async close() {
            commits++;
          },
          async abort() {
            aborts++;
            throw abortFault;
          },
        };
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancellations++;
            throw cancelFault;
          },
        }, { highWaterMark: 0 });
        const { reader, release } = ownInput(releases, source);
        reader.releaseLock = () => {
          release();
          unlocks++;
          throw releaseFault;
        };
        Reflect.set(source, "getReader", () => reader);
        const failure = await rejected(opfsWriter(writable).writeStream!("/owned.bin", source, { mode: "replace" }));
        expect(failure).toBeInstanceOf(AggregateError);
        const outer = failure as AggregateError;
        expect(outer.errors[1]).toBe(abortFault);
        const input = outer.errors[0] as AggregateError;
        expect(input).toBeInstanceOf(AggregateError);
        expect(faultsOf(input)).toEqual([reason, cancelFault, releaseFault]);
        expect(input.cause).toBe(reason);
        expect(cancellations).toBe(1);
        expect(unlocks).toBe(1);
        expect(aborts).toBe(1);
        expect(commits).toBe(0);
        expect(source.locked).toBe(false);
      }));
  }

  for (const reason of [undefined, null, new Error("Authored terminal producer fault.")]) {
    it(`keeps stored producer failure without recancelling it (${String(reason)})`, async () =>
      await withReleases(async (releases) => {
        let cancels = 0, commits = 0, aborts = 0;
        const writable: OpfsWritableFileStreamType = {
          async write() {},
          async seek() {},
          async truncate() {},
          async close() {
            commits++;
          },
          async abort() {
            aborts++;
          },
        };
        const source = new ReadableStream<Uint8Array>({
          pull() {
            throw reason;
          },
          cancel() {
            cancels++;
          },
        }, { highWaterMark: 0 });
        ownInput(releases, source);
        expect(await rejected(opfsWriter(writable).writeStream!("/owned.bin", source, { mode: "replace" }))).toBe(
          reason,
        );
        expect(cancels).toBe(0);
        expect(commits).toBe(0);
        expect(aborts).toBe(1);
        expect(source.locked).toBe(false);
      }));
  }

  for (
    const value of ["invalid bytes", new DataView(new ArrayBuffer(2)), {
      byteLength: 2,
      subarray() {
        return new Uint8Array([1, 2]);
      },
    }]
  ) {
    it(`refuses a non-byte JavaScript chunk before native write/publication (${Object.prototype.toString.call(value)})`, async () =>
      await withReleases(async (releases) => {
        let writes = 0, commits = 0, aborts = 0, cancels = 0;
        const writable: OpfsWritableFileStreamType = {
          async write() {
            writes++;
          },
          async seek() {},
          async truncate() {},
          async close() {
            commits++;
          },
          async abort() {
            aborts++;
          },
        };
        const source = new ReadableStream<Uint8Array>({
          pull(controller) {
            Reflect.apply(controller.enqueue, controller, [value]);
          },
          cancel() {
            cancels++;
          },
        }, { highWaterMark: 0 });
        ownInput(releases, source);
        expect(await rejected(opfsWriter(writable).writeStream!("/owned.bin", source, { mode: "replace" })))
          .toBeInstanceOf(TypeError);
        expect(writes).toBe(0);
        expect(commits).toBe(0);
        expect(aborts).toBe(1);
        expect(cancels).toBe(1);
        expect(source.locked).toBe(false);
      }));
  }

  it("does not publish after EOF when reader release fails", async () =>
    await withReleases(async (releases) => {
      const reason = new Error("Authored reader release fault after EOF.");
      let commits = 0, aborts = 0, cancels = 0;
      const writable: OpfsWritableFileStreamType = {
        async write() {},
        async seek() {},
        async truncate() {},
        async close() {
          commits++;
        },
        async abort() {
          aborts++;
        },
      };
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.close();
        },
        cancel() {
          cancels++;
        },
      }, { highWaterMark: 0 });
      const { reader, release } = ownInput(releases, source);
      reader.releaseLock = () => {
        release();
        throw reason;
      };
      Reflect.set(source, "getReader", () => reader);
      expect(await rejected(opfsWriter(writable).writeStream!("/owned.bin", source, { mode: "replace" }))).toBe(reason);
      expect(commits).toBe(0);
      expect(aborts).toBe(1);
      expect(cancels).toBe(0);
      expect(source.locked).toBe(false);
    }));

  for (const terminal of ["close", "abort"] as const) {
    it(`orders an admitted write and shares winning ${terminal} settlement`, async () =>
      await withReleases(async (releases) => {
        const writing = Promise.withResolvers<void>();
        const releaseWrite = Promise.withResolvers<void>();
        const ending = Promise.withResolvers<void>();
        const releaseEnd = Promise.withResolvers<void>();
        const fault = new Error("Authored native terminal fault.");
        const observedBytes: number[] = [];
        let closes = 0, aborts = 0;
        const writable: OpfsWritableFileStreamType = {
          async write(data) {
            writing.resolve();
            await releaseWrite.promise;
            const bytes = data instanceof Uint8Array ? data : data.data;
            observedBytes.push(...bytes);
          },
          async seek() {},
          async truncate() {},
          async close() {
            closes++;
            ending.resolve();
            await releaseEnd.promise;
            throw fault;
          },
          async abort() {
            aborts++;
            ending.resolve();
            await releaseEnd.promise;
            throw fault;
          },
        };
        const resource = await opfsWriter(writable).openWritableFile!("/owned.bin");
        let consumedTerminal = false;
        releases.push(async () => {
          try {
            await resource.abort("fixture retirement");
          } catch (reason) {
            if (!consumedTerminal) throw reason;
          }
        });
        releases.push(() => {
          releaseEnd.resolve();
          releaseWrite.resolve();
        });
        const write = resource.write(new Uint8Array([3, 4]), { at: 0 });
        const writeOutcome = write.then(
          () => ({ ok: true as const }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
        releases.push(async () => {
          const outcome = await writeOutcome;
          if (!outcome.ok) throw outcome.reason;
        });
        releases.push(() => {
          releaseWrite.resolve();
        });
        await within(writing.promise, "native OPFS admitted write");
        const first = terminal === "close" ? resource.close() : resource.abort("authored cancellation");
        let settled = false;
        const outcome = first.then(() => ({ ok: true as const }), (reason: unknown) => ({ ok: false as const, reason }))
          .finally(() => {
            settled = true;
          });
        releases.push(async () => {
          await outcome;
        });
        releases.push(() => {
          releaseEnd.resolve();
          releaseWrite.resolve();
        });
        const second = terminal === "close" ? resource.abort("late cancellation") : resource.close();
        const secondOutcome = second.then(
          () => ({ ok: true as const }),
          (reason: unknown) => ({ ok: false as const, reason }),
        );
        releases.push(async () => {
          releaseEnd.resolve();
          releaseWrite.resolve();
          await secondOutcome;
        });
        expect(second).toBe(first);
        await setImmediate();
        expect(closes + aborts).toBe(0);
        expect(settled).toBe(false);
        await expect(resource.write(new Uint8Array([9]), { at: 0 })).rejects.toBeInstanceOf(TypeError);
        releaseWrite.resolve();
        await within(ending.promise, "native OPFS winning terminal admission");
        await setImmediate();
        expect(settled).toBe(false);
        releaseEnd.resolve();
        const result = await outcome;
        consumedTerminal = true;
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("Expected native terminal rejection.");
        expect(result.reason).toBe(fault);
        expect(observedBytes).toEqual([3, 4]);
        expect(closes).toBe(terminal === "close" ? 1 : 0);
        expect(aborts).toBe(terminal === "abort" ? 1 : 0);
      }));
  }
});

it("aborts an acquired OPFS writer if queue construction policy evaluation fails", async () => {
  const reason = new Error("Authored policy read fault after native acquisition.");
  let acquisitions = 0, aborts = 0, closes = 0;
  const writable: OpfsWritableFileStreamType = {
    async write() {},
    async seek() {},
    async truncate() {},
    async close() {
      closes++;
    },
    async abort(value) {
      expect(value).toBe(reason);
      aborts++;
    },
  };
  const options = {
    get maxPendingBytes() {
      if (acquisitions > 0) throw reason;
      return 1;
    },
  };
  // Preflight can read policy repeatedly. Only actual native acquisition arms
  // this fault, so the assertion exercises the acquired owner's abort path.
  const driver = opfsWriter(writable, undefined, () => {
    acquisitions++;
  });
  expect(await rejected(driver.openWritableFile!("/owned.bin", options))).toBe(reason);
  expect(acquisitions).toBe(1);
  expect(aborts).toBe(1);
  expect(closes).toBe(0);
});
