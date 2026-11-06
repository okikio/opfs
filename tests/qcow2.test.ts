import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import native from "./fixtures/qcow2/independent.json" with { type: "json" };
import { ArchiveError, createArchiveLedger, openQcow2 } from "../src/image/qcow2.ts";
import type { ByteSourceType } from "../src/source.ts";

// Authored specification controls, not a native interoperability claim. Each
// table has one fixed physical cluster, independent of the candidate's parser.
function fixture(version: 2 | 3 = 3) {
  const cluster = 512, bytes = new Uint8Array(cluster * 8), wire = new DataView(bytes.buffer);
  wire.setUint32(0, 0x514649fb);
  wire.setUint32(4, version);
  wire.setUint32(20, 9);
  wire.setBigUint64(24, 2048n);
  wire.setUint32(36, 1);
  wire.setBigUint64(40, 512n);
  wire.setBigUint64(48, 1024n);
  wire.setUint32(56, 1);
  if (version === 3) {
    wire.setUint32(96, 4);
    wire.setUint32(100, 104);
  }
  wire.setBigUint64(512, 2048n | (1n << 63n));
  wire.setBigUint64(1024, 1536n);
  wire.setBigUint64(2048, 2560n | (1n << 63n));
  // A preallocated zero cluster is distinct from the preceding absent cluster.
  wire.setBigUint64(2064, version === 3 ? 3073n : 0n);
  wire.setBigUint64(2072, 3584n);
  bytes.set(Uint8Array.from({ length: 512 }, (_, i) => i % 251), 2560);
  bytes.fill(0xa5, 3072, 3584);
  bytes.set(Uint8Array.from({ length: 512 }, (_, i) => 255 - (i % 253)), 3584);
  const original = new Uint8Array(2048);
  original.set(bytes.subarray(2560, 3072));
  original.set(bytes.subarray(3584, 4096), 1536);
  return { bytes, wire, original };
}
function source(
  bytes: Uint8Array,
  action?: (offset: number, length: number, signal?: AbortSignal) => void,
): ByteSourceType {
  return {
    size: bytes.length,
    stability: "caller",
    async read(offset, length, options) {
      action?.(offset, length, options?.signal);
      return bytes.slice(offset, offset + length);
    },
  };
}
async function refusal(run: () => unknown | Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(ArchiveError);
    expect((error as ArchiveError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code} refusal.`);
}

describe("QCOW2 standalone guest bytes", () => {
  it("matches all nine genuine QEMU originals, selected crossings and nested guest ranges", async () => {
    for (const item of native.fixtures) {
      const original = decodeBase64(item.original.base64), cluster = item.observed.clusterSize;
      const image = await openQcow2(source(decodeBase64(item.image.base64)));
      expect(image.version).toBe(item.observed.version);
      expect(image.headerLength).toBe(item.observed.headerLength);
      expect((await image.read()).bytes).toEqual(original);
      const offsets = [
        0,
        1,
        cluster - 1,
        cluster,
        cluster * 2 - 7,
        cluster * 64 - 1,
        65535,
        original.length - 513,
        original.length - 1,
        original.length,
      ];
      for (const offset of offsets.filter((value) => value >= 0 && value <= original.length)) {
        const length = Math.min(37, original.length - offset);
        expect((await image.read({ offset, length })).bytes).toEqual(original.slice(offset, offset + length));
        expect(await image.source().read(offset, length)).toEqual(original.slice(offset, offset + length));
      }
    }
  });
  it("reads genuine native holes and preallocated zeros with zero payload requests", async () => {
    for (const item of native.fixtures.filter((item) => item.case.startsWith("holes-") || item.case === "zero-v3")) {
      const image = await openQcow2(source(decodeBase64(item.image.base64)));
      const offset = item.case === "zero-v3" ? 4096 : 0;
      const selected = image.map(offset, 37)[0]!;
      expect(selected.kind).toBe(item.case === "zero-v3" ? "zero" : "hole");
      if (item.case === "zero-v3") {
        expect(item.observed.selectedEntries[1]!.descriptor).toBe("8000000000005001");
        expect(selected.sourceOffset).toBe(20480);
      }
      const read = await image.read({ offset, length: 37, maxSourceBytes: 0, maxRequests: 0 });
      expect(read.bytes).toEqual(new Uint8Array(37));
      expect(read.work.sourceBytes).toBe(0);
      expect(read.work.requests).toBe(0);
    }
  });
  it("refuses genuine QEMU compression, backing dependencies and internal snapshots", async () => {
    expect(native.controls.map((item) => item.case)).toEqual(["compressed", "backing", "snapshot"]);
    for (const item of native.controls) {
      await refusal(() => openQcow2(source(decodeBase64(item.image.base64))), "unsupported-profile");
    }
  });
  it("admits exact serialized L1 EOF while retaining rounded metadata protection", async () => {
    const item = fixture(), bytes = new Uint8Array(4104);
    bytes.set(item.bytes);
    new DataView(bytes.buffer).setBigUint64(40, 4096n);
    new DataView(bytes.buffer).setBigUint64(4096, 2048n | (1n << 63n));
    const image = await openQcow2(source(bytes));
    expect((await image.read()).bytes).toEqual(item.original);
    await refusal(() => openQcow2(source(bytes.slice(0, -1))), "invalid-archive");
    // Cluster alignment makes a payload alias into the last L1 allocation
    // intersect its serialized prefix too. Keep the complete cluster present
    // so the rejection proves a metadata role conflict, not a short source.
    const padded = new Uint8Array(4608);
    padded.set(bytes);
    new DataView(padded.buffer).setBigUint64(2048, 4096n);
    await refusal(() => openQcow2(source(padded)), "invalid-archive");
  });
  it("reads full version 2/3 originals and every selected cluster boundary", async () => {
    for (const version of [2, 3] as const) {
      const item = fixture(version), image = await openQcow2(source(item.bytes));
      expect(image.version).toBe(version);
      expect(image.validation).toBe("active-mapping-bounds");
      expect(image.refcountValidation).toBe("not-checked");
      expect((await image.read()).bytes).toEqual(item.original);
      for (const offset of [0, 1, 500, 511, 512, 1017, 1024, 1523, 1536, 2011, 2048]) {
        const length = Math.min(37, 2048 - offset), read = await image.read({ offset, length });
        expect(read.bytes).toEqual(item.original.slice(offset, offset + length));
        expect(read.integrity).toBe("none");
      }
    }
  });
  it("distinguishes absent and preallocated-zero regions without reading either payload", async () => {
    const item = fixture(), requested: number[] = [];
    const image = await openQcow2(source(item.bytes, (offset) => requested.push(offset)));
    requested.length = 0;
    expect(image.map(512, 1024)).toEqual([
      { offset: 512, length: 512, kind: "hole", copied: false },
      { offset: 1024, length: 512, kind: "zero", copied: false, sourceOffset: 3072 },
    ]);
    const read = await image.read({ offset: 512, length: 1024, maxSourceBytes: 0, maxRequests: 0 });
    expect(read.bytes).toEqual(new Uint8Array(1024));
    expect(read.work).toEqual({ sourceBytes: 0, requests: 0, decodedBytes: 1024, outputBytes: 1024 });
    expect(requested).toEqual([]);
  });
  it("returns independent owned data and immutable mapping inspection", async () => {
    const item = fixture(), image = await openQcow2(source(item.bytes));
    const read = await image.read({ length: 7 });
    read.bytes.fill(255);
    expect((await image.read({ length: 7 })).bytes).toEqual(item.original.slice(0, 7));
    expect(Object.isFrozen(image.map(0, 7))).toBe(true);
    expect(Object.isFrozen(image.map(0, 7)[0])).toBe(true);
    expect(() => image.map(2048, 1)).toThrow(RangeError);
    expect(() => image.map(-1, 1)).toThrow(RangeError);
  });
  it("owns reused header/table scratch and captures source/options before the first await", async () => {
    const item = fixture(), scratch = new Uint8Array(512);
    const options = { maxOutputBytes: 32 };
    const input = {
      size: item.bytes.length,
      stability: "caller" as const,
      identity: "original",
      async read(offset: number, length: number): Promise<Uint8Array> {
        scratch.set(item.bytes.subarray(offset, offset + length));
        return scratch.subarray(0, length);
      },
    };
    const opened = openQcow2(input, options);
    input.size = 0;
    input.identity = "changed";
    input.read = () => {
      throw new Error("Replaced source method used.");
    };
    options.maxOutputBytes = 0;
    const image = await opened;
    expect((await image.read({ offset: 0, length: 7 })).bytes).toEqual(item.original.slice(0, 7));
    expect(image.source().identity).toContain("original");
  });
  it("retains opening aggregate limits and deduplicates the same nested ledger owner", async () => {
    const item = fixture(), ledger = createArchiveLedger({ maxSourceBytes: 1623 });
    const image = await openQcow2(source(item.bytes), { ledger });
    expect(image.work.sourceBytes).toBe(1616);
    const nested = image.source({ ledger });
    expect(await nested.read(0, 7)).toEqual(item.original.slice(0, 7));
    expect(ledger.inspect().sourceBytes).toBe(1623);
    await refusal(() => image.read({ length: 1 }), "budget-exceeded");
  });
  it("retains nested local and additional ledger caps without replacing the opening owner", async () => {
    const item = fixture(), image = await openQcow2(source(item.bytes));
    const extra = createArchiveLedger({ maxOutputBytes: 7 });
    const nested = image.source({ ledger: extra, maxDecodedBytes: 7 });
    expect(await nested.read(0, 7)).toEqual(item.original.slice(0, 7));
    await refusal(() => nested.read(0, 1), "budget-exceeded");
    expect((await image.read({ length: 1 })).bytes).toEqual(item.original.slice(0, 1));
  });
  it("admits exact source/request/output costs before payload I/O", async () => {
    const item = fixture();
    let calls = 0;
    const image = await openQcow2(source(item.bytes, () => calls++));
    calls = 0;
    for (
      const options of [
        { maxSourceBytes: 6 },
        { maxRequests: 0 },
        { maxOutputBytes: 6 },
        { maxDecodedBytes: 6 },
        { ledger: createArchiveLedger({ maxSourceBytes: 6 }) },
        { ledger: createArchiveLedger({ maxRequests: 0 }) },
      ]
    ) await refusal(() => image.read({ length: 7, ...options }), "budget-exceeded");
    expect(calls).toBe(0);
  });
  it("observes a foreign ledger abort before payload I/O and preserves the abort reason", async () => {
    const item = fixture(), control = new AbortController(), sentinel = new Error("ledger abort");
    let calls = 0;
    const image = await openQcow2(source(item.bytes, () => calls++));
    calls = 0;
    const ledger = {
      reserve() {
        control.abort(sentinel);
      },
      inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
    };
    await expect(image.read({ length: 7, signal: control.signal, ledger })).rejects.toBe(sentinel);
    expect(calls).toBe(0);
  });
  it("stops owner admission immediately when the first external owner aborts", async () => {
    const item = fixture(), control = new AbortController(), sentinel = new Error("first owner abort");
    let armed = false, calls = 0, later = 0;
    const opening = {
      reserve() {
        if (armed) control.abort(sentinel);
      },
      inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
    };
    const image = await openQcow2(source(item.bytes, () => calls++), { signal: control.signal, ledger: opening });
    const extra = {
      ...opening,
      reserve() {
        later++;
      },
    };
    armed = true;
    calls = 0;
    await expect(image.read({ length: 7, ledger: extra })).rejects.toBe(sentinel);
    expect(calls).toBe(0);
    expect(later).toBe(0);
  });
  it("omits an overlong derived identity without truncating it or losing stability", async () => {
    const item = fixture(), image = await openQcow2({ ...source(item.bytes), identity: "x".repeat(8192) });
    const nested = image.source();
    expect(nested.identity).toBeUndefined();
    expect(nested.stability).toBe("caller");
    expect(await nested.read(0, 7)).toEqual(item.original.slice(0, 7));
  });
  it("composes original and nested cancellation, including empty selections", async () => {
    const item = fixture(), control = new AbortController(), sentinel = new Error("parent abort");
    const image = await openQcow2(source(item.bytes), { signal: control.signal });
    const nested = image.source();
    control.abort(sentinel);
    expect(() => image.map(0, 0)).toThrow(sentinel);
    await expect(image.read({ length: 0 })).rejects.toBe(sentinel);
    await expect(nested.read(0, 0)).rejects.toBe(sentinel);
  });
  it("awaits in-flight borrowed reads and retains their own failure", async () => {
    const item = fixture(), control = new AbortController(), sentinel = new Error("provider fault");
    let payload = false;
    const input = source(item.bytes);
    const image = await openQcow2({
      ...input,
      async read(offset, length, opts) {
        if (payload) {
          control.abort(new Error("cancel after dispatch"));
          await Promise.resolve();
          throw sentinel;
        }
        return input.read(offset, length, opts);
      },
    });
    payload = true;
    await expect(image.read({ length: 7, signal: control.signal })).rejects.toBe(sentinel);
  });
  it("limits serialized metadata, table entries, L2 tables and selected fragmentation", async () => {
    const item = fixture();
    for (
      const options of [{ maxMetadataBytes: 583 }, { maxTableEntries: 128 }, { maxL2Tables: 0 }, {
        maxRefcountBlocks: 0,
      }]
    ) {
      await refusal(() => openQcow2(source(item.bytes), options), "budget-exceeded");
    }
    const image = await openQcow2(source(item.bytes), { maxSegments: 1 });
    await refusal(() => image.read({ offset: 511, length: 2 }), "budget-exceeded");
    expect((await image.read({ offset: 512, length: 1 })).bytes).toEqual(Uint8Array.of(0));
  });
  it("refuses unsafe wire integers and excessive logical declarations before further I/O", async () => {
    for (const offset of [24, 40, 48]) {
      const item = fixture();
      item.wire.setBigUint64(offset, 9007199254740993n);
      let calls = 0;
      await refusal(() => openQcow2(source(item.bytes, () => calls++)), "unsupported-profile");
      expect(calls).toBe(1);
    }
    const item = fixture();
    item.wire.setBigUint64(24, 1024n ** 4n + 1n);
    let calls = 0;
    await refusal(() => openQcow2(source(item.bytes, () => calls++)), "budget-exceeded");
    expect(calls).toBe(1);
  });
  it("rejects every truncated physical layout before returning an index", async () => {
    const item = fixture();
    for (const end of [0, 71, 72, 511, 512, 1023, 1535, 2047, 2559, 3071, 4095]) {
      await refusal(() => openQcow2(source(item.bytes.slice(0, end))), "invalid-archive");
    }
  });
  it("refuses unsupported features including compressed entries outside the selected guest range", async () => {
    const controls: ((wire: DataView) => void)[] = [
      (wire) => wire.setUint32(4, 1),
      (wire) => wire.setBigUint64(8, 200n),
      (wire) => wire.setUint32(16, 1),
      (wire) => wire.setUint32(32, 1),
      (wire) => wire.setUint32(60, 1),
      (wire) => wire.setBigUint64(64, 512n),
      (wire) => wire.setBigUint64(72, 1n),
      (wire) => wire.setBigUint64(72, 2n),
      (wire) => wire.setBigUint64(72, 4n),
      (wire) => wire.setBigUint64(72, 16n),
      (wire) => wire.setBigUint64(80, 1n),
      (wire) => wire.setBigUint64(88, 1n),
      (wire) => wire.setUint32(96, 5),
      (wire) => wire.setUint32(100, 120),
      (wire) => wire.setBigUint64(2552, 1n << 62n),
    ];
    for (const mutate of controls) {
      const item = fixture();
      mutate(item.wire);
      await refusal(() => openQcow2(source(item.bytes)), "unsupported-profile");
    }
  });
  it("validates alignment, reserved bits, guest coverage and zero preallocation bounds", async () => {
    const controls: ((wire: DataView) => void)[] = [
      (wire) => wire.setBigUint64(40, 513n),
      (wire) => wire.setBigUint64(48, 1025n),
      (wire) => wire.setBigUint64(512, 2049n),
      (wire) => wire.setBigUint64(2048, 2562n),
      (wire) => wire.setBigUint64(2064, 8193n),
      (wire) => wire.setBigUint64(2048, 1n << 63n),
      (wire) => wire.setBigUint64(24, 32769n),
      (wire) => wire.setBigUint64(1024, 1537n),
    ];
    for (const mutate of controls) {
      const item = fixture();
      mutate(item.wire);
      await refusal(() => openQcow2(source(item.bytes)), "invalid-archive");
    }
    const v2 = fixture(2);
    v2.wire.setBigUint64(2064, 1n);
    await refusal(() => openQcow2(source(v2.bytes)), "invalid-archive");
  });
  it("rejects metadata role collisions and payload aliases into metadata", async () => {
    for (
      const mutate of [
        (wire: DataView) => wire.setBigUint64(40, 1024n),
        (wire: DataView) => wire.setBigUint64(1024, 2048n),
        (wire: DataView) => wire.setBigUint64(2048, 512n),
        (wire: DataView) => wire.setBigUint64(2064, 1537n),
      ]
    ) {
      const item = fixture();
      mutate(item.wire);
      await refusal(() => openQcow2(source(item.bytes)), "invalid-archive");
    }
  });
  it("allows shared data clusters without turning copied hints into refcount proof", async () => {
    const item = fixture();
    item.wire.setBigUint64(2072, 2560n | (1n << 63n));
    const image = await openQcow2(source(item.bytes));
    expect((await image.read({ offset: 1536, length: 512 })).bytes).toEqual(item.original.slice(0, 512));
    expect(image.refcountValidation).toBe("not-checked");
  });
  it("frames known feature names and refuses unqualified extension types", async () => {
    const item = fixture();
    item.wire.setUint32(104, 0x6803f857);
    item.wire.setUint32(108, 48);
    item.bytes.set([2, 63, 65, 66], 112);
    const image = await openQcow2(source(item.bytes));
    expect(image.size).toBe(2048);
    item.wire.setUint32(108, 47);
    await refusal(() => openQcow2(source(item.bytes)), "invalid-archive");
    item.wire.setUint32(108, 48);
    item.bytes[112] = 3;
    await refusal(() => openQcow2(source(item.bytes)), "invalid-archive");
    item.bytes[112] = 0;
    item.wire.setUint32(104, 0x44415441);
    await refusal(() => openQcow2(source(item.bytes)), "unsupported-profile");
  });
  it("accepts genuine cross-realm byte extents", async () => {
    const item = fixture();
    const foreign = runInNewContext("(bytes) => new Uint8Array(bytes)") as (bytes: Uint8Array) => Uint8Array;
    const image = await openQcow2({
      size: item.bytes.length,
      stability: "caller",
      async read(offset, length) {
        return foreign(item.bytes.subarray(offset, offset + length));
      },
    });
    expect((await image.read({ length: 7 })).bytes).toEqual(item.original.slice(0, 7));
  });
  it("supports an empty guest without synthetic payload I/O", async () => {
    const item = fixture();
    item.wire.setBigUint64(24, 0n);
    item.wire.setUint32(36, 0);
    item.wire.setBigUint64(40, 0n);
    const image = await openQcow2(source(item.bytes), { maxGuestBytes: 0, maxL2Tables: 0 });
    expect(image.map(0, 0)).toEqual([]);
    expect((await image.read()).work).toEqual({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 });
  });
  it("checks an opening ledger abort before physical I/O", async () => {
    const item = fixture(), control = new AbortController(), sentinel = new Error("opening admission abort");
    let calls = 0;
    const ledger = {
      reserve() {
        control.abort(sentinel);
      },
      inspect: () => ({ sourceBytes: 0, requests: 0, decodedBytes: 0, outputBytes: 0 }),
    };
    await expect(openQcow2(source(item.bytes, () => calls++), { ledger, signal: control.signal })).rejects.toBe(
      sentinel,
    );
    expect(calls).toBe(0);
  });
  it("requires truthful stability and bounded source identity", async () => {
    const item = fixture(), input = source(item.bytes);
    await refusal(() => openQcow2({ size: input.size, read: input.read }), "unsupported-profile");
    await expect(openQcow2({ ...input, stability: "invalid" } as unknown as ByteSourceType)).rejects.toBeInstanceOf(
      TypeError,
    );
    await expect(openQcow2({ ...input, identity: "x".repeat(8193) })).rejects.toBeInstanceOf(TypeError);
    const image = await openQcow2({ size: item.bytes.length, read: input.read }, { allowUnverifiedSource: true });
    expect(image.source().stability).toBeUndefined();
    expect(image.source().identity).toBeUndefined();
  });
});
