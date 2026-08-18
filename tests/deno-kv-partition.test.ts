import { describe, it } from "node:test";
import { expect } from "@std/expect";

import { createFileSystem, FileSystemError } from "../mod.ts";
import {
  createDenoKvAdapter,
  DENO_KV_MAX_VALUE_BYTES,
  DENO_KV_SAFE_INLINE_BYTES,
  DENO_KV_SAFE_PART_BYTES,
  type DenoKvEntryType,
  type DenoKvType,
} from "../src/adapter/deno-kv.ts";
import { createDenoKvDriver } from "../src/driver/deno-kv.ts";

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

/**
 * Deno KV contract double with the documented per-value ceiling enforced.
 *
 * It deliberately exposes stored tuples so tests can prove partition cleanup and
 * listing behavior without depending on a Deno executable in the portable suite.
 */
class FakeDenoKv implements DenoKvType {
  readonly values = new Map<string, { key: Deno.KvKey; value: unknown }>();
  partGets = 0;
  listMatches = 0;

  async get<T = unknown>(key: Deno.KvKey): Promise<DenoKvEntryType<T>> {
    if (key[1] === "part") this.partGets += 1;
    const found = this.values.get(id(key));
    return { key, value: (found?.value as T | undefined) ?? null };
  }

  async set(key: Deno.KvKey, value: unknown): Promise<void> {
    if (size(value) > DENO_KV_MAX_VALUE_BYTES) throw new RangeError("Deno KV value exceeds 64 KiB");
    this.values.set(id(key), { key: [...key], value });
  }

  async delete(key: Deno.KvKey): Promise<void> {
    this.values.delete(id(key));
  }

  async *list<T = unknown>(selector: Deno.KvListSelector): AsyncIterable<DenoKvEntryType<T>> {
    if (!("prefix" in selector)) return;
    for (const entry of this.values.values()) {
      if (!starts(entry.key, selector.prefix)) continue;
      this.listMatches += 1;
      yield { key: entry.key, value: entry.value as T };
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
  });

  it("collects old unreachable physical generations without touching the published generation", async () => {
    const database = new FakeDenoKv();
    const driver = createDenoKvDriver(database, { partBytes: 48 * 1024 });
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
    await fileSystem.writeFile("/value.bin", bytes(96 * 1024));

    const visibleParts = [...database.values.values()]
      .filter((entry) => entry.key[1] === "part")
      .map((entry) => id(entry.key));
    const oldGeneration = `${(Date.now() - 2 * 60 * 60 * 1000).toString(36)}-orphan`;
    await database.set(["okikio-opfs", "part", "/value.bin", oldGeneration, 0], new Uint8Array([1]));
    await database.set(["okikio-opfs", "part", "/value.bin", oldGeneration, 1], new Uint8Array([2]));

    const result = await driver.collect();

    expect(result.deleted).toBe(2);
    expect(result.truncated).toBe(false);
    expect(database.values.has(id(["okikio-opfs", "part", "/value.bin", oldGeneration, 0]))).toBe(false);
    expect(visibleParts.every((value) => database.values.has(value))).toBe(true);
    expect(await fileSystem.readFile("/value.bin")).toEqual(bytes(96 * 1024));
    await fileSystem.close();
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
    const input = bytes(220 * 1024);

    await fileSystem.writeFile("/large.bin", input);

    expect(await fileSystem.readFile("/large.bin")).toEqual(input);
    const inspection = fileSystem.inspect();
    expect(inspection.adapter.partition?.layout).toBe("deno-kv-parts-v2");
    expect(inspection.adapter.limits?.maxValueBytes).toBe(DENO_KV_MAX_VALUE_BYTES);
    expect(fileSystem.plan({ operation: "write", source: "bytes", size: input.byteLength }).support).toBe(
      "partitioned",
    );
    expect([...database.values.values()].every((entry) => size(entry.value) <= DENO_KV_MAX_VALUE_BYTES)).toBe(true);
    await fileSystem.close();
  });

  it("indexes directory listings by direct parent instead of the complete descendant path prefix", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await fileSystem.writeFile("/tree/root.bin", new Uint8Array([1]), { parents: true });
    await fileSystem.writeFile("/tree/child/leaf.bin", new Uint8Array([2]), { parents: true });
    await fileSystem.writeFile("/tree/child/grand/deep.bin", new Uint8Array([3]), { parents: true });
    database.listMatches = 0;

    const entries: string[] = [];
    for await (const entry of fileSystem.readDir("/tree")) entries.push(`${entry.kind}:${entry.name}`);

    expect(entries.sort()).toEqual(["directory:child", "file:root.bin"]);
    expect(database.listMatches).toBe(2);
    await fileSystem.close();
  });

  it("lists partitioned file metadata without loading its physical body parts", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await fileSystem.writeFile("/large.bin", bytes(160 * 1024));
    database.partGets = 0;

    const names: string[] = [];
    for await (const entry of fileSystem.readDir("/")) names.push(entry.name);

    expect(names).toEqual(["large.bin"]);
    expect(database.partGets).toBe(0);
    await fileSystem.close();
  });

  it("stats and ranges avoid reconstructing unrelated partition bodies", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
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
    await fileSystem.close();
  });

  it("streams large replacements through the partition lane without facade buffering", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
      metrics: "basic",
    });
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
    await fileSystem.close();
  });

  it("can disable the partitioned stream optimization and force the bounded facade fallback", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "none",
      metrics: "basic",
      optimizations: { streamWrite: false },
      maxBufferedWriteBytes: 256 * 1024,
    });
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
    await fileSystem.close();
  });

  it("classifies a small append by the resulting partitioned logical file size", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "none",
      metrics: "basic",
    });
    await fileSystem.writeFile("/value.bin", bytes(96 * 1024));
    const before = fileSystem.getMetrics().operations.write?.partitioned ?? 0;

    await fileSystem.writeFile("/value.bin", new Uint8Array([1, 2, 3]), { mode: "append" });

    expect(fileSystem.getMetrics().operations.write?.partitioned).toBe(before + 1);
    const stat = await fileSystem.stat("/value.bin");
    expect(stat.kind).toBe("file");
    if (stat.kind === "file") expect(stat.size).toBe(96 * 1024 + 3);
    await fileSystem.close();
  });

  it("plans stream append input buffering separately from the resulting large file", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), {
      coordination: "none",
      maxBufferedWriteBytes: 64 * 1024,
    });

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
    await fileSystem.close();
  });

  it("patches partitioned append and update writes without changing untouched bytes", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
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
    await fileSystem.close();
  });

  it("preserves zero-filled gaps and truncate semantics in direct partitioned updates", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partBytes: 48 * 1024 }), {
      coordination: "none",
    });
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
    await fileSystem.close();
  });

  it("removes the previous partition generation after a successful smaller overwrite", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database), { coordination: "none" });
    await fileSystem.writeFile("/value.bin", bytes(180 * 1024));
    expect([...database.values.values()].some((entry) => entry.key[1] === "part")).toBe(true);

    await fileSystem.writeFile("/value.bin", new Uint8Array([1, 2, 3]));

    expect([...database.values.values()].some((entry) => entry.key[1] === "part")).toBe(false);
    expect([...await fileSystem.readFile("/value.bin")]).toEqual([1, 2, 3]);
    await fileSystem.close();
  });

  it("fails before the provider rejects a large inline value when partitioning is disabled", async () => {
    const database = new FakeDenoKv();
    const fileSystem = createFileSystem(createDenoKvAdapter(database, { partition: "never" }), {
      coordination: "none",
    });

    try {
      await fileSystem.writeFile("/too-large.bin", bytes(80 * 1024));
      throw new Error("expected too-large failure");
    } catch (error) {
      expect(error).toBeInstanceOf(FileSystemError);
      if (error instanceof FileSystemError) expect(error.code).toBe("too-large");
    } finally {
      await fileSystem.close();
    }
  });
});
