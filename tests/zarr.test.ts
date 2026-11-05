import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, createZarrObjectLedger, openZarr } from "../src/dataset/zarr.ts";
import type { ZarrStoreType } from "../src/dataset/zarr.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixture from "./fixtures/zarr/independent.json" with { type: "json" };

function same(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  for (let at = 0; at < actual.length; at++) {
    if (actual[at] !== expected[at]) throw new Error(`Zarr byte ${at}: ${actual[at]} != ${expected[at]}`);
  }
}
const bytesOf = (values: ArrayBufferView) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
function store(objects: Record<string, Uint8Array>, calls: string[] = []): ZarrStoreType {
  return {
    stability: "immutable",
    async open(key) {
      calls.push(key);
      return objects[key] === undefined ? undefined : source(objects[key]);
    },
  };
}
function nativeObjects(item: typeof fixture.fixtures[number]): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(item.objects).map(([key, value]) => [key, decodeBase64(value.base64)]));
}
const meta = (overrides: Record<string, unknown> = {}) =>
  new TextEncoder().encode(
    JSON.stringify({
      zarr_format: 2,
      shape: [4],
      chunks: [2],
      dtype: "|u1",
      compressor: null,
      filters: null,
      fill_value: 0,
      order: "C",
      ...overrides,
    }),
  );
const control = (overrides: Record<string, unknown> = {}) => ({
  ".zarray": meta(overrides),
  "0": Uint8Array.of(1, 2),
  "1": Uint8Array.of(3, 4),
});

describe("bounded Zarr v2 uncompressed arrays", () => {
  it("matches complete independent NumPy/Zarr arrays and selections for 82 genuine/reciprocal fixtures", async () => {
    expect(fixture.fixtures.length).toBe(82);
    expect(new Uint8Array(new Uint16Array([1]).buffer)[0]).toBe(1); // Fixture oracle is explicitly little-endian.
    for (const item of fixture.fixtures) {
      const array = await openZarr(store(nativeObjects(item)));
      const result = await array.read();
      const expected = decodeBase64(item.original.base64);
      same(bytesOf(result.values), expected);
      expect(result.integrity).toBe("not-provided");
      const width = array.elements ? expected.length / array.elements : 4;
      const count = Math.min(9, array.elements), offset = array.elements - count;
      const tail = await array.read({ offset, count });
      same(bytesOf(tail.values), expected.subarray(offset * width));
      if (item.profile === "missing" || item.profile === "missing-nan") {
        expect(result.fillMask.reduce((a, b) => a + b, 0)).toBe(12);
      } else expect(result.fillMask.some(Boolean)).toBe(false);
    }
  });
  it("reads only selected chunk extents, with full-shaped edge chunks and numeric nonzero booleans", async () => {
    const calls: string[] = [];
    const reads: [number, number][] = [];
    const array = await openZarr({
      stability: "caller",
      async open(key) {
        calls.push(key);
        const bytes = control()[key as keyof ReturnType<typeof control>];
        if (!bytes) return;
        const original = source(bytes);
        return {
          ...original,
          async read(offset, length, options) {
            reads.push([offset, length]);
            return original.read(offset, length, options);
          },
        };
      },
    });
    reads.length = 0;
    calls.length = 0;
    expect([...(await array.read({ offset: 1, count: 1 })).values]).toEqual([2]);
    expect(calls).toEqual(["0"]);
    expect(reads).toEqual([[1, 1]]);
    const missing = await openZarr(store({ ".zarray": meta({ shape: [3] }), "1": Uint8Array.of(3) }));
    await expect(missing.read({ offset: 2, count: 1 })).rejects.toThrow("full declared shape");
    const bool = fixture.fixtures.find((x) => x.profile === "boolean-noncanonical")!;
    same(bytesOf((await (await openZarr(store(nativeObjects(bool)))).read()).values), Uint8Array.of(0, 1, 1, 1));
  });
  it("rejects unsupported codecs, malformed metadata, rounded integer authority and unknown fill before chunks", async () => {
    for (
      const override of [
        { compressor: { id: "gzip" } },
        { filters: [{ id: "delta" }] },
        { zarr_format: 3 },
        { dtype: "|V8" },
        { dtype: "|i2" },
        { chunks: [0] },
        { shape: [1, 2] },
        { dimension_separator: "!" },
      ]
    ) {
      const calls: string[] = [];
      await expect(openZarr(store(control(override), calls))).rejects.toThrow();
      expect(calls).toEqual([".zarray"]);
    }
    for (
      const text of [
        '{"zarr_format":2,"zarr_format":2}',
        new TextDecoder().decode(meta()).replace('"shape":[4]', '"shape":[9007199254740993]'),
        new TextDecoder().decode(meta({ dtype: "<i8" })).replace('"fill_value":0', '"fill_value":9007199254740993'),
        new TextDecoder().decode(meta()).replace('"fill_value":0', '"fill_value":1.0000000000000001'),
      ]
    ) {
      await expect(openZarr(store({ ".zarray": new TextEncoder().encode(text) }))).rejects.toThrow();
    }
    const unknown = await openZarr(store({ ".zarray": meta({ fill_value: null }) }));
    await expect(unknown.read({ count: 1 })).rejects.toThrow("null/undefined fill");
    expect((await unknown.read({ count: 0 })).values.length).toBe(0);
    const present = await openZarr(store(control({ fill_value: null })));
    expect([...(await present.read({ count: 2 })).values]).toEqual([1, 2]);
  });
  it("charges absent lookups and retains opening/additional authorities without duplicate owner charges", async () => {
    const ledger = createArchiveLedger(), objects = createZarrObjectLedger(3), calls: string[] = [];
    const array = await openZarr(store({ ".zarray": meta() }, calls), { ledger, objectLedger: objects });
    const selected = await array.read({ count: 1, ledger, objectLedger: objects });
    expect(objects.inspect()).toBe(2);
    expect(selected.work.objects).toBe(1);
    expect(selected.fillMask[0]).toBe(1);
    const before = ledger.inspect();
    expect(before.outputBytes).toBe(2);
    expect(before.sourceBytes).toBe(meta().length);
    await array.read({ count: 1 });
    expect(objects.inspect()).toBe(3);
    await expect(array.read({ count: 1 })).rejects.toThrow();
    expect(calls.length).toBe(3);
    const output = createArchiveLedger({ maxOutputBytes: 0 });
    const second = await openZarr(store(control()), { ledger: output });
    await expect(second.read({ count: 1 })).rejects.toThrow();
    const extra = createArchiveLedger({ maxOutputBytes: 0 });
    await expect((await openZarr(store(control()))).read({ count: 1, ledger: extra })).rejects.toThrow();
  });
  it("admits known physical cost before chunk reads and bounds metadata, planning, chunks, segments and output", async () => {
    let physical = 0;
    const original = store(control());
    const input: ZarrStoreType = {
      stability: "immutable",
      async open(key) {
        const found = await original.open(key);
        if (!found) return;
        return {
          ...found,
          async read(at, n, opts) {
            if (key !== ".zarray") physical++;
            return found.read(at, n, opts);
          },
        };
      },
    };
    const array = await openZarr(input);
    for (const options of [{ maxSourceBytes: 0 }, { maxRequests: 0 }, { maxOutputBytes: 0 }, { maxDecodedBytes: 0 }]) {
      await expect(array.read({ count: 2, ...options })).rejects.toThrow();
    }
    expect(physical).toBe(0);
    for (const opts of [{ maxMetadataBytes: 1 }, { maxChunkBytes: 1 }, { maxRank: 0 }]) {
      await expect(openZarr(store(control()), opts)).rejects.toThrow();
    }
    for (const opts of [{ maxElements: 1 }, { maxChunks: 1 }, { maxSegments: 1 }, { maxPlanSteps: 1 }]) {
      const calls: string[] = [];
      const bounded = await openZarr(store(control(), calls), opts);
      calls.length = 0;
      await expect(bounded.read()).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });
  it("captures caller descriptors/options, joins cancellation and preserves original provider failures", async () => {
    const options = { maxElements: 1 };
    const original = store(control());
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mutable = {
      stability: "caller" as const,
      async open(key: string) {
        await barrier;
        return original.open(key);
      },
    };
    const pending = openZarr(mutable, options);
    options.maxElements = 999;
    mutable.open = async () => {
      throw new Error("mutated");
    };
    release();
    const array = await pending;
    await expect(array.read({ count: 2 })).rejects.toThrow();
    const parent = new AbortController(), aborted = await openZarr(store(control()), { signal: parent.signal });
    const reason = new Error("parent abort");
    parent.abort(reason);
    await expect(aborted.read({ count: 0 })).rejects.toBe(reason);
    const failure = new Error("provider");
    await expect(openZarr({
      stability: "immutable",
      async open() {
        throw failure;
      },
    })).rejects.toBe(failure);
    const controller = new AbortController();
    const abortedSource = await openZarr({
      stability: "immutable",
      async open(key) {
        const found = await original.open(key);
        if (!found) return;
        return {
          ...found,
          async read(at, n, opts) {
            const bytes = await found.read(at, n, opts);
            if (key !== ".zarray") controller.abort(reason);
            return bytes;
          },
        };
      },
    }, { signal: controller.signal });
    await expect(abortedSource.read({ count: 1 })).rejects.toBe(reason);
    const malformed: ByteSourceType = {
      size: 2,
      stability: "immutable",
      async read() {
        return new Uint8Array(1);
      },
    };
    const truncated = await openZarr({
      stability: "immutable",
      async open(key) {
        return key === ".zarray" ? source(meta()) : malformed;
      },
    });
    await expect(truncated.read({ count: 2 })).rejects.toThrow();
  });
  it("normalizes logical array paths without permitting dot segments or pretending object ETags make a store snapshot", async () => {
    const calls: string[] = [];
    const input = control();
    const nested = Object.fromEntries(Object.entries(input).map(([key, value]) => ["a/b/" + key, value]));
    const array = await openZarr(store(nested, calls), { path: "//a\\b//" });
    expect(array.path).toBe("a/b");
    expect([...(await array.read()).values]).toEqual([1, 2, 3, 4]);
    expect(calls[0]).toBe("a/b/.zarray");
    for (const path of ["../x", "a/./b", "café"]) await expect(openZarr(store(input), { path })).rejects.toThrow();
    await expect(openZarr({
      stability: "provider" as "caller",
      async open() {
        throw new Error("must not open");
      },
    })).rejects.toThrow("whole-store");
  });
});
