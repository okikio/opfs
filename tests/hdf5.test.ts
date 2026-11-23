import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { runInNewContext } from "node:vm";
import { createArchiveLedger, openHdf5 } from "../src/dataset/hdf5.ts";
import { createByteSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import fixture from "./fixtures/hdf5/independent.json" with { type: "json" };
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const native = fixture.files[0]!;
const original = decode(native.bytesBase64);
const source = () => createByteSource(original, { identity: "independent-classic-hdf5" });
const open = () => openHdf5(source(), { profile: "classic-contiguous" });
function mutated(edit: (bytes: Uint8Array, view: DataView) => void): ByteSourceType {
  const b = new Uint8Array(original);
  edit(b, new DataView(b.buffer));
  return createByteSource(b);
}
function authorityMessage(bytes: Uint8Array, object: number, type: number): number {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = object + 16;
  for (let i = 0; i < d.getUint16(object + 2, true); i++) {
    if (d.getUint16(at, true) === type) return at;
    at += 8 + d.getUint16(at + 2, true);
  }
  throw new Error("Missing fixture message.");
}
const i32 = native.datasets.find((d) => d.name === "i32_le")!;

describe("HDF5 classic contiguous preview", () => {
  it("lists every genuine root link and returns owned names without following soft links", async () => {
    const file = await open();
    expect(file.list().map((x) => x.name)).toEqual(native.rootLinks.map((x) => x.name));
    const links = file.list();
    links[0]!.nameBytes.fill(0);
    expect(file.list()[0]!.nameBytes[0]).not.toBe(0);
    expect(links.find((x) => x.name === "soft")?.target).toBe("/i32_le");
    await expect(file.dataset("soft")).rejects.toThrow();
    await expect(file.dataset("nested")).rejects.toThrow();
  });
  it("matches authored numeric oracles, physical extents and independent h5py/h5dump full bytes for all 37 datasets", async () => {
    const file = await open();
    for (const oracle of native.datasets) {
      const dataset = await file.dataset(oracle.name);
      expect(dataset.shape).toEqual(oracle.shape);
      expect(dataset.objectAddress).toBe(oracle.objectAddress);
      expect(dataset.elements).toBe(oracle.elements);
      expect(dataset.dataAddress ?? null).toBe(oracle.dataAddress);
      expect(dataset.byteLength).toBe(oracle.storageBytes);
      const raw = await dataset.source().read(0, dataset.byteLength);
      expect(raw).toEqual(decode(oracle.originalBase64));
      const read = await dataset.read();
      expect(read.integrity).toBe("not-provided");
      expect(read.values.length).toBe(oracle.values.length);
      for (let i = 0; i < oracle.values.length; i++) {
        const expected = oracle.values[i]!;
        const actual = read.values[i]!;
        if ("integer" in expected) expect(BigInt(actual)).toBe(BigInt(expected.integer!));
        else if ("float" in expected) {
          const value = expected.float;
          if (value === "nan") expect(Number.isNaN(actual)).toBe(true);
          else if (value === "+infinity") expect(actual).toBe(Infinity);
          else if (value === "-infinity") expect(actual).toBe(-Infinity);
          else if (value === "-zero") expect(Object.is(actual, -0)).toBe(true);
          else expect(actual).toBe(Number(value));
        }
      }
      const selected = await dataset.read({ offset: oracle.selected.offset, count: oracle.selected.count });
      expect(selected.values.length).toBe(oracle.selected.count);
      expect(
        await dataset.source().read(
          oracle.selected.offset * dataset.datatype.bytes,
          oracle.selected.count * dataset.datatype.bytes,
        ),
      ).toEqual(decode(oracle.selected.bytesBase64));
      expect(oracle.h5pyFullBytes && oracle.h5dumpFullBytes).toBe(true);
    }
  });
  it("keeps 64-bit integers exact and permits empty and scalar datasets", async () => {
    const f = await open();
    expect((await (await f.dataset("i64_be")).read()).values).toBeInstanceOf(BigInt64Array);
    expect((await (await f.dataset("u64_le")).read()).values).toBeInstanceOf(BigUint64Array);
    expect((await f.dataset("empty")).elements).toBe(0);
    expect((await (await f.dataset("empty")).read()).values.length).toBe(0);
    expect((await f.dataset("scalar")).shape).toEqual([]);
  });
  it("rejects genuine unsupported layouts without inventing fill or traversing another tree profile", async () => {
    for (const entry of fixture.unsupported) {
      const action = async () => {
        const f = await openHdf5(createByteSource(decode(entry.bytesBase64)), { profile: "classic-contiguous" });
        await f.dataset(entry.label === "large-tree" ? "v0000" : "data");
      };
      await expect(action()).rejects.toThrow();
    }
  });
  it("requires explicit profile and snapshot evidence before source I/O", async () => {
    let reads = 0;
    const unstable = {
      size: original.length,
      read: async (o: number, n: number) => {
        reads++;
        return original.slice(o, o + n);
      },
    };
    await expect(openHdf5(unstable, { profile: "classic-contiguous" })).rejects.toThrow(/stable source/);
    expect(reads).toBe(0);
    await openHdf5(unstable, { profile: "classic-contiguous", allowUnverifiedSource: true });
  });
  it("snapshots source methods/provenance and accepts cross-realm native byte views", async () => {
    let calls = 0;
    const s: ByteSourceType = {
      size: original.length,
      identity: "before",
      stability: "caller",
      async read(o, n) {
        calls++;
        return runInNewContext("new Uint8Array(bytes)", { bytes: Array.from(original.subarray(o, o + n)) });
      },
    };
    const f = await openHdf5(s, { profile: "classic-contiguous" });
    Object.assign(s, {
      read: () => {
        throw new Error("mutated");
      },
      identity: "after",
      size: 0,
      stability: "broken",
    });
    const data = await f.dataset("i32_le");
    expect((await data.read({ count: 1 })).values.length).toBe(1);
    expect(data.source().identity).toContain("before");
    expect(calls).toBeGreaterThan(0);
  });
  it("preserves opening and image-level cancellation when a fresh child signal is passed", async () => {
    const owner = new AbortController();
    const f = await openHdf5(source(), { profile: "classic-contiguous", signal: owner.signal });
    const child = new AbortController();
    const data = await f.dataset("i32_le", { signal: child.signal });
    child.abort(new Error("child authority"));
    await expect(data.read({ signal: new AbortController().signal })).rejects.toThrow("child authority");
    expect(() => data.source({ signal: new AbortController().signal })).toThrow("child authority");
    owner.abort(new Error("open authority"));
    await expect(f.dataset("scalar", { signal: new AbortController().signal })).rejects.toThrow("open authority");
    expect(() => f.list({ signal: new AbortController().signal })).toThrow("open authority");
  });
  it("pre-reserves every payload request, byte and result before calling its borrowed source", async () => {
    let reads = 0;
    const src = {
      size: original.length,
      stability: "caller" as const,
      read: async (o: number, n: number) => {
        reads++;
        return original.slice(o, o + n);
      },
    };
    const ledger = createArchiveLedger({ maxOutputBytes: 0 });
    const f = await openHdf5(src, { profile: "classic-contiguous", ledger });
    const d = await f.dataset("grid");
    const before = reads;
    await expect(d.read({ count: 1 })).rejects.toThrow(/outputBytes/);
    expect(reads).toBe(before);
    const normal = await openHdf5(src, { profile: "classic-contiguous" });
    const grid = await normal.dataset("grid");
    const mark = reads;
    for (const limits of [{ maxSourceBytes: 0 }, { maxRequests: 0 }, { maxDecodedBytes: 0 }, { maxOutputBytes: 0 }]) {
      await expect(grid.read({ count: 1, ...limits })).rejects.toThrow();
    }
    expect(reads).toBe(mark);
  });
  it("deduplicates an inherited external owner and keeps its exhausted allowance on raw source reads", async () => {
    const ledger = createArchiveLedger();
    const f = await openHdf5(source(), { profile: "classic-contiguous", ledger });
    const data = await f.dataset("i32_le", { ledger });
    const before = ledger.inspect().outputBytes;
    await data.read({ count: 1, ledger });
    expect(ledger.inspect().outputBytes - before).toBe(4);
    const empty = createArchiveLedger({ maxOutputBytes: 0 });
    const raw = data.source({ ledger: empty });
    await expect(raw.read(0, 1)).rejects.toThrow(/outputBytes/);
  });
  it("rejects short reads and native-extent spoofing", async () => {
    for (const spoof of [false, true]) {
      const s = {
        size: original.length,
        stability: "caller" as const,
        read: async () => {
          const b = new Uint8Array(1);
          if (spoof) Object.defineProperty(b, "byteLength", { value: 96 });
          return b;
        },
      };
      await expect(openHdf5(s, { profile: "classic-contiguous" })).rejects.toThrow(/exact requested extent/);
    }
  });
  it("enforces metadata, links, messages, rank and selected range policies", async () => {
    for (const policy of [{ maxMetadataBytes: 95 }, { maxNodes: 0 }, { maxMessages: 0 }, { maxLinks: 1 }]) {
      await expect(openHdf5(source(), { profile: "classic-contiguous", ...policy })).rejects.toThrow();
    }
    const f = await openHdf5(source(), { profile: "classic-contiguous", maxElements: 1, maxReadBytes: 4 });
    const d = await f.dataset("i32_le");
    await expect(d.read({ count: 2 })).rejects.toThrow();
    await expect(d.read({ offset: d.elements + 1, count: 0 })).rejects.toThrow();
    expect((await d.read({ offset: d.elements, count: 0 })).values.length).toBe(0);
  });
  it("rejects malformed header, datatype, shape and selected extents", async () => {
    for (
      const edit of [
        (b: Uint8Array) => b[8] = 3,
        (b: Uint8Array, d: DataView) => d.setBigUint64(40, BigInt(b.length + 1), true),
        (_b: Uint8Array, d: DataView) => d.setBigUint64(24, 1n, true),
      ]
    ) await expect(openHdf5(mutated(edit), { profile: "classic-contiguous" })).rejects.toThrow();
    for (const type of [1, 3, 8]) {
      const s = mutated((b) => {
        const at = authorityMessage(b, i32.objectAddress, type);
        if (type === 1) b[at + 8 + 1] = 33;
        else if (type === 3) b[at + 8 + 8] = 1;
        else b[at + 8 + 1] = 2;
      });
      const f = await openHdf5(s, { profile: "classic-contiguous" });
      await expect(f.dataset("i32_le")).rejects.toThrow();
    }
  });
  it("captures source failure identity and observes cancellation after callback", async () => {
    const error = new Error("provider failed");
    await expect(
      openHdf5({ size: 100, stability: "caller", read: () => Promise.reject(error) }, {
        profile: "classic-contiguous",
      }),
    ).rejects.toBe(error);
    const abort = new AbortController();
    await expect(openHdf5({
      size: original.length,
      stability: "caller",
      read: async (o, n) => {
        abort.abort(error);
        return original.slice(o, o + n);
      },
    }, { profile: "classic-contiguous", signal: abort.signal })).rejects.toBe(error);
  });
  it("accepts bounded authored object continuations and rejects cycles/duplicate authority", async () => {
    const b = new Uint8Array(original.length + 256);
    b.set(original);
    const v = new DataView(b.buffer), object = i32.objectAddress;
    b.set(original.subarray(object + 16, object + 272), original.length);
    v.setBigUint64(40, BigInt(b.length), true);
    v.setUint16(object + 2, 6, true);
    v.setUint32(object + 8, 24, true);
    v.setUint16(object + 16, 16, true);
    v.setUint16(object + 18, 16, true);
    b.fill(0, object + 20, object + 24);
    v.setBigUint64(object + 24, BigInt(original.length), true);
    v.setBigUint64(object + 32, 256n, true);
    const f = await openHdf5(createByteSource(b), { profile: "classic-contiguous" });
    expect((await (await f.dataset("i32_le")).read()).values.length).toBe(i32.elements);
    const cycle = new Uint8Array(b);
    new DataView(cycle.buffer).setBigUint64(object + 24, BigInt(object + 16), true);
    const broken = await openHdf5(createByteSource(cycle), { profile: "classic-contiguous" });
    await expect(broken.dataset("i32_le")).rejects.toThrow(/overlap or cycle/);
    const duplicate = mutated((bytes, d) => d.setUint16(authorityMessage(bytes, object, 0), 3, true));
    const dup = await openHdf5(duplicate, { profile: "classic-contiguous" });
    await expect(dup.dataset("i32_le")).rejects.toThrow(/Duplicate/);
  });
  it("checks genuine root upper-bound keys and refuses malformed literal-name UTF8", async () => {
    const boundary = await openHdf5(source(), { profile: "classic-contiguous" });
    expect(boundary.list().length).toBe(40);
    await expect(openHdf5(mutated((_b, v) => v.setBigUint64(136 + 40, 0n, true)), { profile: "classic-contiguous" }))
      .rejects.toThrow(/upper key/);
    await expect(openHdf5(
      mutated((b, v) => {
        const heap = Number(v.getBigUint64(680 + 24, true));
        const first = Number(v.getBigUint64(1072 + 8, true));
        b[heap + first] = 255;
      }),
      { profile: "classic-contiguous" },
    )).rejects.toThrow(/UTF-8/);
  });
  it("preserves literal BOM-prefixed names and their distinct plain-name neighbor", async () => {
    const s = mutated((b, v) => {
      const heap = Number(v.getBigUint64(680 + 24, true));
      const plain = Number(v.getBigUint64(7320 + 8 + 4 * 40, true));
      const bom = Number(v.getBigUint64(7320 + 8 + 5 * 40, true));
      b.set([117, 56, 0], heap + plain);
      b.set([239, 187, 191, 117, 56], heap + bom);
    });
    const file = await openHdf5(s, { profile: "classic-contiguous" });
    expect(file.list().slice(-2).map((x) => x.name)).toEqual(["u8", "\uFEFFu8"]);
    expect((await file.dataset("u8")).datatype.bytes).toBe(8);
    expect((await file.dataset("\uFEFFu8")).datatype.bytes).toBe(1);
  });
  it("rejects inconsistent root caches and continuations overlapping the object prefix", async () => {
    await expect(openHdf5(mutated((_b, v) => v.setBigUint64(80, 680n, true)), { profile: "classic-contiguous" }))
      .rejects.toThrow(/cached root/);
    const s = mutated((b, v) => {
      const at = authorityMessage(b, i32.objectAddress, 0);
      v.setUint16(at, 16, true);
      v.setUint16(at + 2, 16, true);
      v.setBigUint64(at + 8, BigInt(i32.objectAddress), true);
      v.setBigUint64(at + 16, 16n, true);
      v.setUint32(i32.objectAddress + 8, at + 24 - i32.objectAddress - 16, true);
    });
    const f = await openHdf5(s, { profile: "classic-contiguous" });
    await expect(f.dataset("i32_le")).rejects.toThrow(/overlap or cycle/);
  });
  it("keeps exhausted opening external source/request/decoded owners authoritative before payload I/O", async () => {
    for (const kind of ["sourceBytes", "requests", "decodedBytes"] as const) {
      let calls = 0;
      const max = 1024 * 1024;
      const ledger = createArchiveLedger({ maxSourceBytes: max, maxRequests: max, maxDecodedBytes: max });
      const source = {
        size: original.length,
        stability: "caller" as const,
        async read(o: number, n: number) {
          calls++;
          return original.slice(o, o + n);
        },
      };
      const file = await openHdf5(source, { profile: "classic-contiguous", ledger });
      const dataset = await file.dataset("grid");
      ledger.reserve(kind, max - ledger.inspect()[kind]);
      const before = calls;
      await expect(dataset.read({ count: 1, ledger })).rejects.toThrow();
      expect(calls).toBe(before);
    }
  });
});
