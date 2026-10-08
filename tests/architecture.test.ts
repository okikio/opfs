import { createBunDriver } from "../src/driver/bun.ts";
import { HOST_PROFILES } from "../src/driver/host.ts";
import { mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
/// <reference types="deno" />
import { describe, it } from "node:test";
import { withReleases } from "./close.ts";
import { within } from "./gate.ts";
import { expect } from "@std/expect";
import { createFileSystem } from "../mod.ts";
import { createNodeDriver } from "../src/driver/node.ts";
import { createDenoDriver } from "../src/driver/deno.ts";
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
            await expect(reader.read()).rejects.toMatchObject({ code: "aborted", cause: "stop native source" });
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
            await expect(write).rejects.toMatchObject({ code: "aborted", cause: stage });
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
    await expect(reader.read()).rejects.toMatchObject({ code: "aborted" });
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
    await expect(reader.read()).rejects.toMatchObject({ code: "aborted" });
    await within(closed.promise, "Node native descriptor close");
    expect(native?.destroyed).toBe(true);
    expect(native?.closed).toBe(true);
  }));
