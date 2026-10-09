/// <reference types="deno" />
import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem, FileSystemError } from "../mod.ts";
import {
  createDenoKvAdapter,
  DENO_KV_MAX_VALUE_BYTES,
  DENO_KV_SAFE_INLINE_BYTES,
  DENO_KV_SAFE_PART_BYTES,
  type DenoKvAtomicType,
  type DenoKvCheckType,
  type DenoKvCommitType,
  type DenoKvEntryType,
  type DenoKvType,
} from "../src/adapter/deno-kv.ts";
import { createDenoKvDriver } from "../src/driver/deno-kv.ts";
import { withFileSystem, within } from "./reliability.ts";

/** Stable JSON-ish key string used only by the in-memory Deno KV contract double. */
function id(key: readonly unknown[]): string {
  return JSON.stringify(key);
}

/** Returns whether one tuple starts with another tuple. */
function starts(key: readonly unknown[], prefix: readonly unknown[]): boolean {
  return prefix.every((value, index) => key[index] === value);
}

/** Conservative serialized-size estimate that rejects oversized test values before storage. */
function size(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Creates a promise gate used to interleave one logical read with a concurrent overwrite. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Mutation staged by the in-memory Deno KV atomic-operation double. */
type FakeDenoKvMutationType =
  | { readonly kind: "set"; readonly key: Deno.KvKey; readonly value: unknown }
  | { readonly kind: "delete"; readonly key: Deno.KvKey };

/**
 * Optimistic transaction double that mirrors the Deno KV methods used by the driver.
 *
 * Checks are evaluated together immediately before mutation. This matters for the
 * stale-writer test: all physical parts can exist while a failed version check
 * still prevents their manifest from becoming visible.
 */
class FakeDenoKvAtomic implements DenoKvAtomicType {
  readonly #database: FakeDenoKv;
  readonly #checks: DenoKvCheckType[] = [];
  readonly #mutations: FakeDenoKvMutationType[] = [];

  constructor(database: FakeDenoKv) {
    this.#database = database;
  }

  check(...checks: DenoKvCheckType[]): DenoKvAtomicType {
    this.#checks.push(...checks);
    return this;
  }

  set(key: Deno.KvKey, value: unknown): DenoKvAtomicType {
    this.#mutations.push({ kind: "set", key, value });
    return this;
  }

  delete(key: Deno.KvKey): DenoKvAtomicType {
    this.#mutations.push({ kind: "delete", key });
    return this;
  }

  async commit(): Promise<DenoKvCommitType> {
    return this.#database.commit(this.#checks, this.#mutations);
  }
}

/**
 * Deno KV contract double with value ceilings, versionstamps, and atomic checks.
 *
 * It deliberately exposes stored tuples so tests can prove partition cleanup and
 * listing behavior without depending on a Deno executable in the portable suite.
 * Versionstamps change for every replacement so the same double can reproduce an
 * independent writer winning after another writer has already read stale state.
 */
class FakeDenoKv implements DenoKvType {
  readonly values = new Map<string, { key: Deno.KvKey; value: unknown; versionstamp: string }>();
  #revision = 0;
  /** Counts every provider operation so preflight proves absence of reads as well as writes. */
  calls = 0;
  /** Injects actual provider boundaries without changing stored-value semantics. */
  beforeGet: ((key: Deno.KvKey) => void | Promise<void>) | undefined;
  beforeCommit: ((mutations: readonly FakeDenoKvMutationType[]) => void) | undefined;
  partGets = 0;
  listMatches = 0;
  /** Optional gate that pauses physical part reads after the manifest has already been resolved. */
  partReadGate?: Promise<void>;
  /** Signals the first physical part read so the test can commit a concurrent generation. */
  partReadStarted?: () => void;

  /** Creates the next deterministic versionstamp for a provider mutation. */
  #version(): string {
    this.#revision += 1;
    return this.#revision.toString(36).padStart(8, "0");
  }

  /** Applies one provider replacement after enforcing the documented value ceiling. */
  #put(key: Deno.KvKey, value: unknown): void {
    if (size(value) > 64 * 1024) throw new RangeError("Deno KV value exceeds 64 KiB");
    this.values.set(id(key), { key: [...key], value, versionstamp: this.#version() });
  }

  async get<T = unknown>(key: Deno.KvKey): Promise<DenoKvEntryType<T>> {
    this.calls += 1;
    await this.beforeGet?.(key);
    if (key[1] === "part") {
      this.partGets += 1;
      this.partReadStarted?.();
      if (this.partReadGate !== undefined) await this.partReadGate;
    }
    const found = this.values.get(id(key));
    return {
      key,
      value: (found?.value as T | undefined) ?? null,
      versionstamp: found?.versionstamp ?? null,
    };
  }

  async set(key: Deno.KvKey, value: unknown): Promise<void> {
    this.calls += 1;
    this.#put(key, value);
  }

  async delete(key: Deno.KvKey): Promise<void> {
    this.calls += 1;
    this.values.delete(id(key));
  }

  atomic(): DenoKvAtomicType {
    this.calls += 1;
    return new FakeDenoKvAtomic(this);
  }

  /** Evaluates one optimistic transaction without yielding between checks and mutations. */
  commit(checks: readonly DenoKvCheckType[], mutations: readonly FakeDenoKvMutationType[]): DenoKvCommitType {
    this.beforeCommit?.(mutations);
    for (const check of checks) {
      const current = this.values.get(id(check.key));
      if ((current?.versionstamp ?? null) !== check.versionstamp) return { ok: false };
    }
    // Validate the complete transaction before applying any mutation. The literal
    // provider ceiling keeps the double independent of driver constants.
    for (const mutation of mutations) {
      if (mutation.kind === "set" && size(mutation.value) > 64 * 1024) {
        throw new RangeError("Deno KV value exceeds 64 KiB");
      }
    }
    for (const mutation of mutations) {
      if (mutation.kind === "set") this.#put(mutation.key, mutation.value);
      else this.values.delete(id(mutation.key));
    }
    return { ok: true };
  }

  async *list<T = unknown>(selector: Deno.KvListSelector): AsyncIterable<DenoKvEntryType<T>> {
    this.calls += 1;
    if (!("prefix" in selector)) return;
    for (const entry of this.values.values()) {
      if (!starts(entry.key, selector.prefix)) continue;
      this.listMatches += 1;
      yield { key: entry.key, value: entry.value as T, versionstamp: entry.versionstamp };
    }
  }
}

/** Deterministic byte fixture with enough entropy to make accidental truncation visible. */
function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => index % 251);
}

describe("Deno KV partitioned records", () => {
  it("rejects configuration that treats Deno KV serialized ceilings as raw payload budgets", () => {
    const database = new FakeDenoKv();

    expect(() =>
      createDenoKvDriver(database, {
        partBytes: DENO_KV_SAFE_PART_BYTES + 1,
      })
    ).toThrow(RangeError);
    expect(() =>
      createDenoKvDriver(database, {
        inlineBytes: DENO_KV_SAFE_INLINE_BYTES + 1,
      })
    ).toThrow(RangeError);
  });

  it("rejects an oversized physical key during driver preflight before provider I/O", () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database);
    expect(driver.capabilities.replacement).toBe("atomic");
    expect(driver.capabilities.transactions).toBe(true);
    const path = `/${"segment".repeat(500)}`;

    const plan = driver.plan({
      operation: "write",
      path,
      size: 1,
      source: "bytes",
      mode: "replace",
    });

    expect(plan.supported).toBe(false);
    expect(plan.support).toBe("unsupported");
    expect(plan.problems).toContainEqual(expect.objectContaining({
      code: "key-too-large",
      layer: "driver",
      severity: "error",
      limit: expect.objectContaining({
        code: "serialized-key-bytes",
        kind: "hard",
        source: "provider",
      }),
    }));
    expect(database.values.size).toBe(0);
    expect(database.calls).toBe(0);
  });

  it("collects old unreachable physical generations without touching the published generation", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partBytes: 48 * 1024 });
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/value.bin", bytes(96 * 1024));

      const visibleParts = [...database.values.values()]
        .filter((entry) => entry.key[1] === "part")
        .map((entry) => id(entry.key));
      await fileSystem.writeFile("/value.bin", bytes(96 * 1024));
      const result = await driver.collect({ minAgeMs: 0 });
      expect(result.deleted).toBe(2);
      expect(result.truncated).toBe(false);
      expect(visibleParts.every((value) => !database.values.has(value))).toBe(true);
      expect(await fileSystem.readFile("/value.bin")).toEqual(bytes(96 * 1024));
    });
  });

  it("returns an actionable preflight result when partitioning is disabled", () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partition: "never", inlineBytes: 32 * 1024 });

    const plan = driver.plan({
      operation: "write",
      path: "/large.bin",
      size: 96 * 1024,
      source: "bytes",
      mode: "replace",
    });

    expect(plan.supported).toBe(false);
    expect(plan.problems).toContainEqual(expect.objectContaining({ code: "partition-disabled" }));
    expect(plan.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "change-policy" }),
      expect.objectContaining({ kind: "select-driver" }),
    ]));
  });
  it("stores a large logical file below the physical value ceiling and reconstructs it exactly", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
      metrics: "basic",
    });
    await withFileSystem(fileSystem, async () => {
      const input = bytes(220 * 1024);

      await fileSystem.writeFile("/large.bin", input);

      expect(await fileSystem.readFile("/large.bin")).toEqual(input);
      const inspection = fileSystem.inspect();
      expect(inspection.adapter.partition?.layout).toBe("deno-kv-parts-v3");
      expect(inspection.adapter.limits?.maxValueBytes).toBe(DENO_KV_MAX_VALUE_BYTES);
      expect(fileSystem.plan({ operation: "write", source: "bytes", size: input.byteLength }).support).toBe(
        "partitioned",
      );
      expect([...database.values.values()].every((entry) => size(entry.value) <= DENO_KV_MAX_VALUE_BYTES)).toBe(true);
    });
  });

  it("indexes directory listings by direct parent instead of the complete descendant path prefix", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/tree/root.bin", new Uint8Array([1]), { parents: true });
      await fileSystem.writeFile("/tree/child/leaf.bin", new Uint8Array([2]), { parents: true });
      await fileSystem.writeFile("/tree/child/grand/deep.bin", new Uint8Array([3]), { parents: true });
      database.listMatches = 0;

      const entries: string[] = [];
      for await (const entry of fileSystem.readDir("/tree")) entries.push(`${entry.kind}:${entry.name}`);

      expect(entries.sort()).toEqual(["directory:child", "file:root.bin"]);
      expect(database.listMatches).toBe(2);
    });
  });

  it("lists partitioned file metadata without loading its physical body parts", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/large.bin", bytes(160 * 1024));
      database.partGets = 0;

      const names: string[] = [];
      for await (const entry of fileSystem.readDir("/")) names.push(entry.name);

      expect(names).toEqual(["large.bin"]);
      expect(database.partGets).toBe(0);
    });
  });

  it("stats and ranges avoid reconstructing unrelated partition bodies", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
    await withFileSystem(fileSystem, async () => {
      const input = bytes(180 * 1024);
      await fileSystem.writeFile("/large.bin", input);

      database.partGets = 0;
      const stat = await fileSystem.stat("/large.bin");
      expect(stat.kind).toBe("file");
      if (stat.kind === "file") expect(stat.size).toBe(input.byteLength);
      expect(database.partGets).toBe(0);

      const range = await fileSystem.readFile("/large.bin", { at: 50 * 1024, length: 2048 });
      expect(range).toEqual(input.slice(50 * 1024, 52 * 1024));
      expect(database.partGets).toBe(1);
    });
  });

  it("streams large replacements through the partition lane without facade buffering", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
      metrics: "basic",
    });
    await withFileSystem(fileSystem, async () => {
      const input = bytes(190 * 1024);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let at = 0; at < input.byteLength; at += 7 * 1024) controller.enqueue(input.slice(at, at + 7 * 1024));
          controller.close();
        },
      });

      const plan = fileSystem.plan({ operation: "write", source: "stream", mode: "replace" });
      expect(plan.support).toBe("partitioned");
      await fileSystem.writeFile("/stream.bin", source);

      expect(await fileSystem.readFile("/stream.bin")).toEqual(input);
      expect(fileSystem.getMetrics().peakBufferedBytes).toBe(0);
      expect(fileSystem.getMetrics().operations.write?.partitioned).toBe(1);
    });
  });

  it("can disable the partitioned stream optimization and force the bounded facade fallback", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "none",
      metrics: "basic",
      optimizations: { streamWrite: false },
      maxBufferedWriteBytes: 256 * 1024,
    });
    await withFileSystem(fileSystem, async () => {
      const input = bytes(96 * 1024);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(input);
          controller.close();
        },
      });

      expect(fileSystem.inspect().support.streamWrite.replace).toBe("emulated");
      expect(
        fileSystem.plan({
          operation: "write",
          source: "stream",
          size: input.byteLength,
          inputBytes: input.byteLength,
        }).bufferBytes,
      ).toBe(input.byteLength);
      await fileSystem.writeFile("/fallback.bin", source);

      expect(await fileSystem.readFile("/fallback.bin")).toEqual(input);
      expect(fileSystem.getMetrics().peakBufferedBytes).toBeGreaterThanOrEqual(input.byteLength);
      expect(fileSystem.getMetrics().operations.write?.emulated).toBe(1);
    });
  });

  it("classifies a small append by the resulting partitioned logical file size", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "none",
      metrics: "basic",
    });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/value.bin", bytes(96 * 1024));
      const before = fileSystem.getMetrics().operations.write?.partitioned ?? 0;

      await fileSystem.writeFile("/value.bin", new Uint8Array([1, 2, 3]), { mode: "append" });

      expect(fileSystem.getMetrics().operations.write?.partitioned).toBe(before + 1);
      const stat = await fileSystem.stat("/value.bin");
      expect(stat.kind).toBe("file");
      if (stat.kind === "file") expect(stat.size).toBe(96 * 1024 + 3);
    });
  });

  it("plans stream append input buffering separately from the resulting large file", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "none",
      maxBufferedWriteBytes: 64 * 1024,
    });
    await withFileSystem(fileSystem, async () => {
      const plan = fileSystem.plan({
        operation: "write",
        source: "stream",
        mode: "append",
        size: 300 * 1024 * 1024,
        inputBytes: 1024,
      });

      expect(plan.supported).toBe(true);
      expect(plan.support).toBe("partitioned");
      expect(plan.bufferBytes).toBe(1024);
    });
  });

  it("patches partitioned append and update writes without changing untouched bytes", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
    await withFileSystem(fileSystem, async () => {
      const initial = bytes(150 * 1024);
      await fileSystem.writeFile("/patch.bin", initial);

      const appended = new Uint8Array([9, 8, 7, 6]);
      await fileSystem.writeFile("/patch.bin", appended, { mode: "append" });
      const afterAppend = await fileSystem.readFile("/patch.bin");
      expect(afterAppend.slice(0, initial.byteLength)).toEqual(initial);
      expect(afterAppend.slice(initial.byteLength)).toEqual(appended);

      const patch = new Uint8Array([1, 3, 5, 7, 9]);
      const at = 47 * 1024 + 11;
      await fileSystem.writeFile("/patch.bin", patch, { mode: "update", at });
      const expected = afterAppend.slice();
      expected.set(patch, at);
      expect(await fileSystem.readFile("/patch.bin")).toEqual(expected);
    });
  });

  it("preserves zero-filled gaps and truncate semantics in direct partitioned updates", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/gap.bin", bytes(96 * 1024));

      const at = 120 * 1024;
      await fileSystem.writeFile("/gap.bin", new Uint8Array([4, 5]), { mode: "update", at });
      const expanded = await fileSystem.readFile("/gap.bin");
      expect(expanded.byteLength).toBe(at + 2);
      expect(expanded.slice(96 * 1024, at).every((value) => value === 0)).toBe(true);
      expect([...expanded.slice(at)]).toEqual([4, 5]);

      await fileSystem.writeFile("/gap.bin", new Uint8Array([6, 7, 8]), {
        mode: "update",
        at: 32 * 1024,
        truncate: true,
      });
      const truncated = await fileSystem.readFile("/gap.bin");
      expect(truncated.byteLength).toBe(32 * 1024 + 3);
      expect([...truncated.slice(-3)]).toEqual([6, 7, 8]);
    });
  });

  it("keeps an in-flight reader on the superseded generation until explicit collection", async () => {
    const database = new FakeDenoKv();
    const maintenance = createDenoKvDriver(database);
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await withFileSystem(fileSystem, async () => {
      const initial = bytes(180 * 1024);
      await fileSystem.writeFile("/value.bin", initial);
      const oldParts = [...database.values.values()]
        .filter((entry) => entry.key[1] === "part")
        .map((entry) => id(entry.key));
      expect(oldParts.length).toBeGreaterThan(0);

      const started = deferred();
      const release = deferred();
      let signaled = false;
      database.partReadStarted = () => {
        if (signaled) return;
        signaled = true;
        started.resolve();
      };
      database.partReadGate = release.promise;

      const read = fileSystem.readFile("/value.bin");
      void read.catch(() => {});
      try {
        await within(started.promise, "partition read begins");
        await fileSystem.writeFile("/value.bin", new Uint8Array([1, 2, 3]));

        expect(oldParts.every((value) => database.values.has(value))).toBe(true);
        release.resolve();
        expect(await read).toEqual(initial);
        expect([...await fileSystem.readFile("/value.bin")]).toEqual([1, 2, 3]);

        const guarded = await maintenance.collect({ minAgeMs: 60_000 });
        expect(guarded.deleted).toBe(0);
        expect(oldParts.every((value) => database.values.has(value))).toBe(true);

        const reclaimed = await maintenance.collect({ minAgeMs: 0 });
        expect(reclaimed.deleted).toBe(oldParts.length);
        expect(oldParts.every((value) => !database.values.has(value))).toBe(true);
      } finally {
        release.resolve();
        delete database.partReadGate;
        await within(Promise.allSettled([read]), "partition reader cleanup");
      }
    });
  });

  it("rejects a stale partitioned writer when another writer changes the logical entry", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await withFileSystem(fileSystem, async () => {
      const initial = bytes(180 * 1024);
      await fileSystem.writeFile("/value.bin", initial);
      const originalParts = new Set(
        [...database.values.values()]
          .filter((entry) => entry.key[1] === "part")
          .map((entry) => id(entry.key)),
      );

      const started = deferred();
      const release = deferred();
      let signaled = false;
      database.partReadStarted = () => {
        if (signaled) return;
        signaled = true;
        started.resolve();
      };
      database.partReadGate = release.promise;

      const stale = fileSystem.writeFile("/value.bin", new Uint8Array([7]), { mode: "update", at: 0 });
      void stale.catch(() => {});
      try {
        await within(started.promise, "stale partition writer begins");
        await fileSystem.writeFile("/value.bin", new Uint8Array([1, 2, 3]));
        release.resolve();
        delete database.partReadGate;

        let failure: unknown;
        try {
          await stale;
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(FileSystemError);
        if (failure instanceof FileSystemError) expect(failure.code).toBe("locked");
        expect([...await fileSystem.readFile("/value.bin")]).toEqual([1, 2, 3]);

        const remainingParts = [...database.values.values()]
          .filter((entry) => entry.key[1] === "part")
          .map((entry) => id(entry.key));
        expect(new Set(remainingParts)).toEqual(originalParts);
      } finally {
        release.resolve();
        delete database.partReadGate;
        await within(Promise.allSettled([stale]), "stale partition writer cleanup");
      }
    });
  });

  it("keeps a reclamation fence through bounded deletion and tombstone retention", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database);
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await withFileSystem(fileSystem, async () => {
      await fileSystem.writeFile("/bounded.bin", bytes(180 * 1024));
      await fileSystem.writeFile("/bounded.bin", new Uint8Array([9]));

      const retired = [...database.values.values()]
        .filter((entry) => entry.key[1] === "generation" && Reflect.get(entry.value as object, "state") === "retired")
        .map((entry) => id(entry.key));
      expect(retired.length).toBe(1);

      const first = await driver.collect({ minAgeMs: 0, maxDeletes: 2 });
      expect(first.deleted).toBe(2);
      expect(first.truncated).toBe(true);
      expect(database.values.has(retired[0]!)).toBe(true);

      const second = await driver.collect({ minAgeMs: 0 });
      expect(second.deleted).toBeGreaterThan(0);
      expect(Reflect.get(database.values.get(retired[0]!)!.value as object, "state")).toBe("reclaimed");
      await driver.collect({ minAgeMs: 0, tombstoneAgeMs: 0 });
      expect(database.values.has(retired[0]!)).toBe(false);
      expect([...await fileSystem.readFile("/bounded.bin")]).toEqual([9]);
    });
  });

  it("fails before the provider rejects a large inline value when partitioning is disabled", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partition: "never" }), {
      coordination: "none",
    });
    await withFileSystem(fileSystem, async () => {
      await expect(fileSystem.writeFile("/too-large.bin", bytes(80 * 1024)))
        .rejects.toMatchObject({ code: "too-large" });
    });
  });
});

describe("Deno KV owned byte and generation cleanup", () => {
  it("interrupts pending native input after an actual part mutation fails", async () => {
    const database = new FakeDenoKv();
    const stalled = Promise.withResolvers<void>();
    const failure = new Error("actual KV part mutation fault");
    let reads = 0;
    let cancels = 0;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull(value) {
        if (reads++ === 0) value.enqueue(Uint8Array.of(17));
        else stalled.resolve();
      },
      cancel() {
        cancels++;
      },
    }, { highWaterMark: 0 });
    // Gate a real part dispatch until the second native read is pending.
    const originalCommit = database.commit.bind(database);
    const databaseWire: DenoKvType = {
      get: database.get.bind(database),
      set: database.set.bind(database),
      delete: database.delete.bind(database),
      list: database.list.bind(database),
      atomic() {
        const mutations: FakeDenoKvMutationType[] = [];
        const checks: DenoKvCheckType[] = [];
        const transaction: DenoKvAtomicType = {
          check(...values) {
            checks.push(...values);
            return transaction;
          },
          set(key, value) {
            mutations.push({ kind: "set", key, value });
            return transaction;
          },
          delete(key) {
            mutations.push({ kind: "delete", key });
            return transaction;
          },
          async commit() {
            if (mutations.some((entry) => entry.key[1] === "part")) {
              await stalled.promise;
              throw failure;
            }
            return originalCommit(checks, mutations);
          },
        };
        return transaction;
      },
    };
    const driver = createDenoKvDriver(databaseWire, { partition: "always", partBytes: 1, concurrency: 2 });
    const pending = driver.writeStream!("/value", source, { mode: "replace" });
    void pending.catch(() => {});
    try {
      await within(stalled.promise, "KV pending input admission");
      await expect(within(pending, "KV failed mapper retirement")).rejects.toMatchObject({ errors: [failure] });
      expect(cancels).toBe(1);
      expect(source.locked).toBe(false);
      expect(await driver.stat!("/value")).toBeNull();
    } finally {
      stalled.resolve();
      controller?.error(new Error("KV fixture teardown"));
      await within(Promise.allSettled([pending]), "KV owned pending cleanup");
    }
  });

  it("retains unsupported-source retirement failure beside the filesystem refusal", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partition: "never" });
    const cleanup = new Error("actual native cancellation fault");
    let cancels = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancels++;
        throw cleanup;
      },
    }, { highWaterMark: 0 });
    const failure = await driver.writeStream!("/value", source, { mode: "replace" }).then(
      () => {
        throw new Error("Expected unsupported streaming rejection");
      },
      (reason: unknown) => reason,
    );
    // This is the direct driver boundary: the refusal and retirement fault
    // are independent ordered events, before facade error translation.
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected driver-owned aggregate.");
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBeInstanceOf(FileSystemError);
    expect(failure.errors[0]).toMatchObject({ code: "not-supported", operation: "write", path: "/value" });
    expect(failure.errors[1]).toBe(cleanup);
    expect(failure.cause).toBe(failure.errors[0]);
    expect(database.calls).toBe(0);
    expect(cancels).toBe(1);
    expect(source.locked).toBe(false);
  });

  it("retains a staging fault beside failed generation-state acquisition during reclamation", async () => {
    const database = new FakeDenoKv();
    const staging = new Error("actual staged part fault");
    const cleanup = new Error("actual generation lookup fault");
    let staged = false;
    database.beforeCommit = (mutations) => {
      if (mutations.some((entry) => entry.key[1] === "part")) {
        staged = true;
        throw staging;
      }
    };
    database.beforeGet = (key) => {
      if (staged && key[1] === "generation") throw cleanup;
    };
    const driver = createDenoKvDriver(database, { partition: "always", partBytes: 1, concurrency: 1 });
    await expect(driver.writeFile!("/value", Uint8Array.of(17), { mode: "replace" })).rejects.toMatchObject({
      errors: [expect.objectContaining({ errors: [staging] }), cleanup],
    });
    database.beforeGet = undefined;
    database.beforeCommit = undefined;
    expect(await driver.stat!("/value")).toBeNull();
  });

  it("awaits reader-pin release and retains the already observed missing-part fault", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partition: "always", partBytes: 1 });
    await driver.writeFile!("/value", Uint8Array.of(17), { mode: "replace" });
    for (const [key, entry] of database.values) if (entry.key[1] === "part") database.values.delete(key);
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const cleanup = new Error("actual reader pin release lookup fault");
    let read = false;
    database.beforeGet = async (key) => {
      if (key[1] === "part") read = true;
      if (read && key[1] === "pin") {
        entered.resolve();
        await held.promise;
        throw cleanup;
      }
    };
    const stream = await driver.openReadStream!("/value");
    const reader = stream.getReader();
    let settled = false;
    const pending = reader.read().finally(() => settled = true);
    void pending.catch(() => {});
    try {
      await within(entered.promise, "KV reader pin retirement");
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      held.resolve();
      await expect(within(pending, "KV reader failure composition")).rejects.toMatchObject({
        errors: [expect.objectContaining({ code: "unknown" }), cleanup],
      });
    } finally {
      held.resolve();
      database.beforeGet = undefined;
      await within(Promise.allSettled([pending]), "KV reader cleanup");
      reader.releaseLock();
    }
  });
});

describe("Deno KV uncancellable read ownership", () => {
  it("joins a held physical get before consumer cancellation releases the pin", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partition: "always", partBytes: 1 });
    await driver.writeFile!("/value", Uint8Array.of(17), { mode: "replace" });
    const entered = deferred();
    const held = deferred();
    database.partReadGate = held.promise;
    database.partReadStarted = entered.resolve;
    const stream = await driver.openReadStream!("/value");
    const reader = stream.getReader();
    const pending = reader.read();
    void pending.catch(() => {});
    let cancelling: Promise<void> | undefined;
    try {
      await within(entered.promise, "KV physical read admission");
      let settled = false;
      cancelling = reader.cancel().finally(() => settled = true);
      void cancelling.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect([...database.values.values()].filter((entry) => entry.key[1] === "pin")).toHaveLength(1);
      held.resolve();
      await within(cancelling, "KV cancellation get and pin join");
      expect((await pending).done).toBe(true);
      expect([...database.values.values()].filter((entry) => entry.key[1] === "pin")).toHaveLength(0);
    } finally {
      held.resolve();
      await within(Promise.allSettled([pending, cancelling]), "KV physical read cleanup");
      reader.releaseLock();
    }
  });
});

describe("Deno KV concurrent read and pin retirement faults", () => {
  it("retains actual held get rejection and independent pin release beside cancellation", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partition: "always", partBytes: 1 });
    await driver.writeFile!("/value", Uint8Array.of(17), { mode: "replace" });
    const entered = deferred();
    const held = deferred();
    const readFault = new Error("actual physical read rejection");
    const releaseFault = new Error("actual pin release rejection");
    let failed = false;
    database.beforeGet = async (key) => {
      if (key[1] === "part") {
        entered.resolve();
        await held.promise;
        failed = true;
        throw readFault;
      }
      if (failed && key[1] === "pin") throw releaseFault;
    };
    const stream = await driver.openReadStream!("/value");
    const reader = stream.getReader();
    const pending = reader.read();
    void pending.catch(() => {});
    let cancelling: Promise<void> | undefined;
    try {
      await within(entered.promise, "held failing KV get");
      let settled = false;
      cancelling = reader.cancel().finally(() => settled = true);
      void cancelling.catch(() => {});
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      held.resolve();
      await expect(within(cancelling, "actual KV read and pin faults")).rejects.toMatchObject({
        errors: [readFault, releaseFault],
      });
      // Native cancel closes the reader; that EOF does not claim the get succeeded.
      expect((await pending).done).toBe(true);
    } finally {
      held.resolve();
      await within(Promise.allSettled([pending, cancelling]), "KV failed read cleanup");
      database.beforeGet = undefined;
      reader.releaseLock();
    }
  });
});

describe("Deno KV partition integrity", () => {
  const corruptions = [
    { name: "short first part", at: 0, prefix: [], parts: [Uint8Array.of(1), Uint8Array.of(3, 4)] },
    { name: "oversized first part", at: 0, prefix: [], parts: [Uint8Array.of(1, 2, 9), Uint8Array.of(3, 4)] },
    { name: "short final part", at: 3, prefix: [1, 2], parts: [Uint8Array.of(1, 2), Uint8Array.of(3)] },
    { name: "oversized final part", at: 3, prefix: [1, 2], parts: [Uint8Array.of(1, 2), Uint8Array.of(3, 4, 9)] },
    // The total still equals four bytes. A whole-body count cannot detect the
    // wrong boundary, which shifts ranges and can silently alter patch writes.
    { name: "equal-total redistribution", at: 0, prefix: [], parts: [Uint8Array.of(1), Uint8Array.of(2, 3, 4)] },
  ];
  const routes = ["record", "bytes", "range", "stream", "stream-range", "append", "update"] as const;
  for (const corruption of corruptions) {
    for (const route of routes) {
      it(`rejects ${corruption.name} through ${route} and releases its reader pins`, async () => {
        const database = new FakeDenoKv();
        const driver = createDenoKvDriver(database, { partition: "always", partBytes: 2, concurrency: 1 });
        await driver.writeFile!("/value", Uint8Array.of(1, 2, 3, 4), { mode: "replace" });
        const original = [...database.values.values()].find((entry) => entry.key[1] === "entry")!;
        const parts = [...database.values.values()].filter((entry) => entry.key[1] === "part")
          .sort((left, right) => Number(left.key[4]) - Number(right.key[4]));
        expect(parts).toHaveLength(2);
        for (let index = 0; index < parts.length; index++) {
          // Deliberate mutation of the private namespace models a damaged or
          // externally modified database, outside normal immutable insertion.
          await database.set(parts[index]!.key, corruption.parts[index]!);
        }
        const at = corruption.at;
        const delivered: number[] = [];

        const read = async (): Promise<unknown> => {
          if (route === "record") return await driver.get("/value");
          if (route === "bytes") return await driver.readFile!("/value");
          if (route === "range") return await driver.readFile!("/value", { at, length: 1 });
          if (route === "append" || route === "update") {
            return await driver.writeFile!("/value", Uint8Array.of(9), { mode: route, at: 3 });
          }
          const stream = await driver.openReadStream!("/value", route === "stream-range" ? { at, length: 1 } : {});
          const reader = stream.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              delivered.push(...next.value);
            }
          } finally {
            reader.releaseLock();
          }
        };
        // Mapper routes retain their pool aggregate; every route must preserve
        // the same filesystem integrity category rather than a message string.
        const failure = await read().then(
          () => {
            throw new Error("Expected partition integrity rejection");
          },
          (reason: unknown) => reason,
        );
        const reasons = failure instanceof AggregateError ? failure.errors : [failure];
        expect(reasons).toContainEqual(expect.objectContaining({ code: "unknown" }));
        expect(delivered).toEqual(route === "stream" ? corruption.prefix : []);
        expect(database.values.get(id(original.key))).toEqual(original);
        expect([...database.values.values()].filter((entry) => entry.key[1] === "pin")).toHaveLength(0);
        expect((await driver.probe()).pendingReaders).toBe(0);
      });
    }
  }

  for (const parts of [1, 3]) {
    it(`rejects a manifest with ${parts} parts for a two-part logical file before acquiring a pin`, async () => {
      const database = new FakeDenoKv();
      const driver = createDenoKvDriver(database, { partition: "always", partBytes: 2 });
      await driver.writeFile!("/value", Uint8Array.of(1, 2, 3, 4), { mode: "replace" });
      const entry = [...database.values.values()].find((entry) => entry.key[1] === "entry")!;
      await database.set(entry.key, { ...(entry.value as object), parts });
      database.partGets = 0;
      await expect(driver.get("/value")).rejects.toBeInstanceOf(Error);
      await expect(driver.stat!("/value")).rejects.toBeInstanceOf(Error);
      await expect(driver.openReadStream!("/value")).rejects.toBeInstanceOf(Error);
      await expect(Array.fromAsync(driver.list("/"))).rejects.toBeInstanceOf(Error);
      expect(database.partGets).toBe(0);
      expect([...database.values.values()].filter((entry) => entry.key[1] === "pin")).toHaveLength(0);
    });
  }

  it("preserves valid empty and partial-final files without reading unrelated range parts", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partition: "always", partBytes: 2 });
    await driver.writeFile!("/empty", new Uint8Array(), { mode: "replace" });
    await driver.writeFile!("/value", Uint8Array.of(1, 2, 3), { mode: "replace" });
    expect(await driver.readFile!("/empty")).toEqual(new Uint8Array());
    expect(await new Response(await driver.openReadStream!("/empty")).arrayBuffer()).toEqual(new ArrayBuffer(0));
    database.partGets = 0;
    expect(await driver.readFile!("/value", { at: 2, length: 1 })).toEqual(Uint8Array.of(3));
    expect(database.partGets).toBe(1);
    expect(new Uint8Array(await new Response(await driver.openReadStream!("/value")).arrayBuffer()))
      .toEqual(Uint8Array.of(1, 2, 3));
    expect([...database.values.values()].filter((entry) => entry.key[1] === "pin")).toHaveLength(0);
  });
});
