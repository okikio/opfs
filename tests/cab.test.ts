import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openCab } from "../src/archive/cab.ts";
import fixtures from "./fixtures/cab/independent.json" with { type: "json" };
import vectors from "./fixtures/cab/vectors.json" with { type: "json" };
import mszip from "./fixtures/cab/mszip.json" with { type: "json" };
import { readMszip } from "../src/archive/mszip.ts";

function source(bytes: Uint8Array): ByteSourceType {
  return createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
}

/** Independent fixture navigation for corrupting records, not candidate parser output. */
function layout(
  bytes: Uint8Array,
): { folder: number; files: number; blocks: { header: number; body: number; size: number }[] } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reserved = (view.getUint16(30, true) & 4) !== 0;
  const folder = reserved ? 40 + view.getUint16(36, true) : 36;
  const blockReserve = reserved ? bytes[39]! : 0;
  let at = view.getUint32(folder, true);
  const blocks = [];
  for (let index = 0; index < view.getUint16(folder + 4, true); index++) {
    const size = view.getUint16(at + 4, true);
    blocks.push({ header: at, body: at + 8 + blockReserve, size });
    at += 8 + blockReserve + size;
  }
  return { folder, files: view.getUint32(16, true), blocks };
}

function word(bytes: Uint8Array, at: number, value: number, width = 4): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (width === 2) view.setUint16(at, value, true);
  else view.setUint32(at, value, true);
}

const original = decodeBase64(fixtures.stored.archive);

describe("MSZIP dictionary and packed framing", () => {
  for (const fixture of mszip.vectors) {
    it(`decodes independent zlib ${fixture.name} complete bytes and a late selected range`, async () => {
      const bytes = decodeBase64(fixture.archive);
      const archive = await openCab(source(bytes));
      const expected = decodeBase64(fixture.body);
      expect(archive.folders[0]!.readable).toBe(true);
      expect((await archive.read(0)).bytes).toEqual(expected);
      const late = await archive.read(0, { offset: expected.length - 7, length: 7 });
      expect(late.bytes).toEqual(expected.subarray(-7));
      expect(late.blocks.slice(0, -1).every((block) => block.role === "history")).toBe(true);
      expect(late.blocks.at(-1)?.role).toBe("covering");
      expect(late.work.outputBytes).toBe(7);
      expect(late.work.sourceBytes).toBe(archive.folders[0]!.blocks.reduce((sum, block) => sum + block.storedSize, 0));
      const sizes = fixture.parts.map((part) => decodeBase64(part).length);
      let total = 0;
      const historyCopies = sizes.slice(0, -1).reduce((sum, size) => {
        total += size;
        return sum + Math.min(total, 32768);
      }, 0);
      expect(late.work.decodedBytes).toBe(expected.length + historyCopies);
      if (fixture.name === "short-history") {
        expect(fixture.consumerExit).not.toBe(0);
        expect(fixture.consumerFullBytesMatch).toBe(false);
      } else {
        expect(fixture.consumerExit).toBe(0);
        expect(fixture.consumerFullBytesMatch).toBe(true);
      }
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
    });
  }

  it("rejects missing history, truncation at every packed byte, trailing bytes and output mismatch", () => {
    const fixture = mszip.vectors.find((vector) => vector.name === "dynamic-history")!;
    const packed = decodeBase64(fixture.packed[1]!);
    const history = decodeBase64(fixture.parts[0]!);
    const size = decodeBase64(fixture.parts[1]!).length;
    expect(fixture.requiresHistory[1]).toBe(true);
    expect(() => readMszip(packed, size, new Uint8Array())).toThrow();
    for (let cut = 0; cut < packed.length; cut++) {
      expect(() => readMszip(packed.subarray(0, cut), size, history)).toThrow();
    }
    const trailing = new Uint8Array(packed.length + 1);
    trailing.set(packed);
    expect(() => readMszip(trailing, size, history)).toThrow();
    expect(() => readMszip(packed, size - 1, history)).toThrow();
    expect(() => readMszip(packed, size + 1, history)).toThrow();
    expect(() => readMszip(new Uint8Array([67, 75, 7]), 1, history)).toThrow();
    // Final stored block with LEN1/NLEN65534 and literal A, independently authored RFC1951 bytes.
    const stored = new Uint8Array([67, 75, 1, 1, 0, 254, 255, 65]);
    expect(readMszip(stored, 1, history)).toEqual(new Uint8Array([65]));
    stored[5] = 0;
    expect(() => readMszip(stored, 1, history)).toThrow();
  });

  it("validates dynamic tree authority, repeat bounds and reserved fixed symbols", () => {
    // RFC1951 fields are authored here, independently of the decoder's Huffman implementation.
    const packed = (fields: readonly (readonly [number, number])[]): Uint8Array => {
      const bits: number[] = [];
      for (const [value, count] of fields) for (let i = 0; i < count; i++) bits.push((value >>> i) & 1);
      const bytes = new Uint8Array(2 + Math.ceil(bits.length / 8));
      bytes.set([67, 75]);
      for (let i = 0; i < bits.length; i++) bytes[2 + (i >>> 3)]! |= bits[i]! << (i & 7);
      return bytes;
    };
    const header = [[1, 1], [2, 2], [0, 5], [0, 5], [0, 4]] as const;
    for (const lengths of [[1, 1, 1, 0], [2, 2, 2, 0], [0, 0, 0, 0]]) {
      expect(() =>
        readMszip(packed([...header, ...lengths.map((length) => [length, 3] as const)]), 1, new Uint8Array())
      ).toThrow();
    }
    // Alphabet {0:1,16:1}, followed by repeat16 before any previous length.
    expect(() => readMszip(packed([...header, [1, 3], [0, 3], [0, 3], [1, 3], [1, 1]]), 1, new Uint8Array())).toThrow();
    // Alphabet {0:1,18:1}; repeated zeros either overflow258 lengths or omit the required EOB.
    for (const second of [127, 109]) {
      expect(() =>
        readMszip(
          packed([...header, [0, 3], [0, 3], [1, 3], [1, 3], [1, 1], [127, 7], [1, 1], [second, 7]]),
          1,
          new Uint8Array(),
        )
      ).toThrow();
    }
    // Fixed literal symbol286 has canonical code11000110; emitted MSB first, hence reversed integer99.
    expect(() => readMszip(packed([[1, 1], [1, 2], [99, 8]]), 1, new Uint8Array())).toThrow();
    // Fixed length257 (0000001), followed by reserved distance30 (11110).
    expect(() => readMszip(packed([[1, 1], [1, 2], [64, 7], [15, 5]]), 3, new Uint8Array([65]))).toThrow();
    // Maximum distance32768 (code29+13extra), length3 and EOB, with all32KiB of history present.
    const maximum = packed([[1, 1], [1, 2], [64, 7], [23, 5], [8191, 13], [0, 7]]);
    const history = new Uint8Array(32768);
    history.set([12, 34, 56]);
    expect(readMszip(maximum, 3, history)).toEqual(new Uint8Array([12, 34, 56]));
    expect(() => readMszip(maximum, 3, history.subarray(1))).toThrow();
  });

  it("checks predecessor parity and reserves complete replay budgets before payload reads", async () => {
    const fixture = mszip.vectors[0]!;
    const bytes = decodeBase64(fixture.archive);
    const physical = layout(bytes);
    const corrupted = bytes.slice();
    corrupted[physical.blocks[0]!.body + 10] = corrupted[physical.blocks[0]!.body + 10]! ^ 1;
    const archive = await openCab(source(corrupted));
    await expect(archive.read(0, { offset: 40000, length: 1 })).rejects.toMatchObject({ code: "checksum-mismatch" });
    let calls = 0;
    const indexed = await openCab({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls++;
        return bytes.slice(offset, offset + length);
      },
    });
    const before = calls;
    for (const limits of [{ maxSourceBytes: 1 }, { maxDecodedBytes: 1 }, { maxRequests: 1 }, { maxOutputBytes: 0 }]) {
      await expect(indexed.read(0, { offset: 40000, length: 1, ...limits })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
      expect(calls).toBe(before);
    }
    const pending = await indexed.read(0, { offset: 40000, length: 1, verify: false });
    expect(pending.integrity).toBe("pending");
    expect(pending.blocks.every((block) => block.status === "pending")).toBe(true);
  });

  it("retains opening cancellation despite a fresh operation signal, including empty ranges", async () => {
    const abort = new AbortController();
    const archive = await openCab(source(decodeBase64(mszip.vectors[0]!.archive)), { signal: abort.signal });
    const reason = new Error("archive stopped");
    abort.abort(reason);
    for (const length of [0, 1]) {
      await expect(archive.read(0, { length, signal: new AbortController().signal })).rejects.toBe(reason);
    }
  });

  it("bounds empty-block CPU work across all CFDATA units and reports actual block counts", async () => {
    // Independently authored non-final fixed blocks: BFINAL0/BTYPE01 + seven-bit EOB0.
    // A final stored block supplies one A byte after those empty blocks.
    const empty = (count: number): Uint8Array => {
      const bits: number[] = [];
      const append = (value: number, count: number): void => {
        for (let i = 0; i < count; i++) bits.push((value >>> i) & 1);
      };
      for (let i = 0; i < count; i++) {
        append(2, 3);
        append(0, 7);
      }
      append(1, 3);
      while (bits.length % 8) bits.push(0);
      append(1, 16);
      append(65534, 16);
      append(65, 8);
      const result = new Uint8Array(2 + bits.length / 8);
      result.set([67, 75]);
      for (let i = 0; i < bits.length; i++) result[2 + (i >>> 3)]! |= bits[i]! << (i & 7);
      return result;
    };
    const unit = empty(5000);
    const base = decodeBase64(vectors.vectors[0]!.archive);
    const block = layout(base).blocks[0]!;
    const bytes = new Uint8Array(block.body + unit.length * 2 + 8);
    bytes.set(base.subarray(0, block.body));
    bytes.set(unit, block.body);
    word(bytes, 8, bytes.length);
    word(bytes, 40, 2, 2);
    word(bytes, 42, 1, 2);
    word(bytes, 44, 2);
    word(bytes, block.header, 0);
    word(bytes, block.header + 4, unit.length, 2);
    const second = block.body + unit.length;
    word(bytes, second, 0);
    word(bytes, second + 4, unit.length, 2);
    word(bytes, second + 6, 1, 2);
    bytes.set(unit, second + 8);
    const archive = await openCab(source(bytes));
    await expect(archive.read(0)).rejects.toMatchObject({ code: "budget-exceeded" });
    const result = await archive.read(0, { maxDeflateBlocks: 10002 });
    expect(result.bytes).toEqual(new Uint8Array([65, 65]));
    expect(result.deflateBlocks).toBe(10002);
    await expect(archive.read(0, { maxDeflateBlocks: 10001 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(0, { maxDeflateBlocks: 65537 })).rejects.toBeInstanceOf(RangeError);
    expect((await archive.read(0, { length: 0, maxDeflateBlocks: 0 })).deflateBlocks).toBe(0);
  });

  it("preserves opening lifetime and distinct external ledgers before payload I/O", async () => {
    const bytes = decodeBase64(mszip.vectors[0]!.archive);
    const baseline = await openCab(source(bytes));
    const expected = await baseline.read(0, { offset: 40000, length: 1 });
    let calls = 0;
    const input: ByteSourceType = {
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls++;
        return bytes.slice(offset, offset + length);
      },
    };
    const dimensions = [["maxSourceBytes", "sourceBytes"], ["maxRequests", "requests"], [
      "maxDecodedBytes",
      "decodedBytes",
    ], ["maxOutputBytes", "outputBytes"]] as const;
    for (const [limit, work] of dimensions) {
      const opening = await openCab(input, { [limit]: baseline.work[work] });
      const before = calls;
      await expect(opening.read(0, { offset: 40000, length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toBe(before);
      const external = createArchiveLedger({ [limit]: baseline.work[work] });
      const indexed = await openCab(input, { ledger: external });
      const count = calls;
      await expect(indexed.read(0, { offset: 40000, length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
      expect(calls).toBe(count);
      const operation = createArchiveLedger({ [limit]: 0 });
      const fresh = await openCab(input);
      const initial = calls;
      await expect(fresh.read(0, { offset: 40000, length: 1, ledger: operation })).rejects.toMatchObject({
        code: "budget-exceeded",
      });
      expect(calls).toBe(initial);
    }
    const ledger = createArchiveLedger();
    const indexed = await openCab(input, { ledger });
    const result = await indexed.read(0, { offset: 40000, length: 1, ledger });
    for (const [, dimension] of dimensions) {
      expect(ledger.inspect()[dimension]).toBe(indexed.work[dimension] + result.work[dimension]);
    }
    expect(result.work).toEqual(expected.work);
  });

  it("captures descriptor and opening options before the first source await", async () => {
    const bytes = decodeBase64(mszip.vectors[0]!.archive);
    const options = { maxOutputBytes: 0 };
    const reads = { size: 0, identity: 0, stability: 0, read: 0 };
    const input = {
      get size() {
        reads.size++;
        return bytes.length;
      },
      get identity() {
        reads.identity++;
        return "original";
      },
      get stability(): "immutable" {
        reads.stability++;
        return "immutable";
      },
      get read() {
        reads.read++;
        return async (offset: number, length: number): Promise<Uint8Array> => {
          options.maxOutputBytes = 100;
          return bytes.slice(offset, offset + length);
        };
      },
    };
    const archive = await openCab(input, options);
    expect(reads).toEqual({ size: 1, identity: 1, stability: 1, read: 1 });
    expect(archive.source.identity).toBe("original");
    await expect(archive.read(0, { length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    for (const overrides of [{ stability: "truthy" }, { identity: 42 }, { identity: "x".repeat(8193) }]) {
      await expect(
        openCab({ ...source(bytes), ...overrides } as unknown as ByteSourceType, { allowUnverifiedSource: true }),
      ).rejects.toBeInstanceOf(TypeError);
    }
  });
});

describe("bounded CAB inspection", () => {
  for (const profile of ["stored", "mszip"] as const) {
    it(`indexes independent gcab ${profile} files without reading data bodies`, async () => {
      const fixture = fixtures[profile];
      const bytes = decodeBase64(fixture.archive);
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
      expect(Array.from(hash, (value) => value.toString(16).padStart(2, "0")).join("")).toBe(fixture.sha256);
      const calls: { offset: number; length: number }[] = [];
      const archive = await openCab({
        size: bytes.length,
        stability: "immutable",
        async read(offset, length) {
          calls.push({ offset, length });
          return bytes.slice(offset, offset + length);
        },
      });
      expect(archive.entries.map((entry) => entry.name)).toEqual(fixture.entries.map((entry) => entry.name));
      for (const block of layout(bytes).blocks) {
        expect(calls.some(({ offset, length }) => offset < block.body + block.size && offset + length > block.body))
          .toBe(false);
      }
      expect(archive.work.sourceBytes).toBeLessThan(2048);
      expect(Object.isFrozen(archive.entries)).toBe(true);
      expect(Object.isFrozen(archive.folders[0]!.blocks)).toBe(true);
      for (const entry of archive.entries) {
        const result = await archive.read(entry.id);
        expect(result.bytes).toEqual(decodeBase64(fixture.entries[entry.id]!.body));
        expect(result.integrity).toBe(entry.size === 0 ? "none" : "block-checksum-verified");
      }
    });
  }

  it("checks independent consumer-validated parity vectors with all payload remainder lengths", async () => {
    expect(vectors.vectors).toHaveLength(4);
    for (const fixture of vectors.vectors) {
      const archive = await openCab(source(decodeBase64(fixture.archive)));
      expect(archive.folders[0]!.blocks[0]!.checksum).toBe(fixture.checksum);
      const result = await archive.read(0);
      expect(result.bytes).toEqual(decodeBase64(fixture.body));
      expect(result.integrity).toBe("block-checksum-verified");
    }
  });

  it("lists reserved-block diagnostics but refuses their unresolved payload-checksum scope", async () => {
    expect(vectors.reservedDiagnostics).toHaveLength(24);
    for (const fixture of vectors.reservedDiagnostics) {
      const archive = await openCab(source(decodeBase64(fixture.archive)));
      expect(archive.folders[0]!.blockReserveBytes).toBe(fixture.blockReserveBytes);
      expect(archive.folders[0]!.readable).toBe(false);
      await expect(archive.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
      await expect(archive.read(0, { verify: false })).rejects.toMatchObject({ code: "unsupported-profile" });
    }
  });

  it("keeps header and folder reserved metadata separate from unsupported block reserves", async () => {
    const base = decodeBase64(vectors.vectors[0]!.archive);
    const bytes = new Uint8Array(base.length + 7);
    bytes.set(base.subarray(0, 36));
    bytes.set([2, 0, 1, 0, 0xaa, 0xbb], 36); // two header bytes, one folder byte, no block bytes
    bytes.set(base.subarray(36, 44), 42);
    bytes[50] = 0xcc;
    bytes.set(base.subarray(44), 51);
    word(bytes, 8, bytes.length);
    word(bytes, 16, 51);
    word(bytes, 30, 4, 2);
    word(bytes, 42, 69);
    const archive = await openCab(source(bytes));
    expect(archive.folders[0]!.readable).toBe(true);
    expect((await archive.read(0)).bytes).toEqual(new Uint8Array([0x11]));
    expect((await archive.read(0)).integrity).toBe("block-checksum-verified");
  });

  it("maps files to separate folders and refuses physical folder overlap", async () => {
    // Combine two independently consumed block vectors with a separately authored two-folder directory.
    const first = decodeBase64(vectors.vectors.find((vector) => vector.size === 1)!.archive);
    const second = decodeBase64(vectors.vectors.find((vector) => vector.size === 2)!.archive);
    const bytes = new Uint8Array(107);
    bytes.set(first.subarray(0, 36));
    word(bytes, 8, 107);
    word(bytes, 16, 52);
    word(bytes, 26, 2, 2);
    word(bytes, 28, 2, 2);
    bytes.set(first.subarray(36, 44), 36);
    word(bytes, 36, 88);
    bytes.set(second.subarray(36, 44), 44);
    word(bytes, 44, 97);
    bytes.set(first.subarray(44, 62), 52);
    bytes.set(second.subarray(44, 62), 70);
    word(bytes, 78, 1, 2);
    bytes[86] = 98;
    bytes.set(first.subarray(62), 88);
    bytes.set(second.subarray(62), 97);
    const archive = await openCab(source(bytes));
    expect(archive.folders).toHaveLength(2);
    expect((await archive.read(0)).bytes).toEqual(new Uint8Array([0x11]));
    expect((await archive.read(1)).bytes).toEqual(new Uint8Array([0x11, 0x22]));
    word(bytes, 44, 88);
    await expect(openCab(source(bytes))).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("reads full covering blocks for a verified prefix and exposes neighboring-file cost", async () => {
    const archive = await openCab(source(original));
    const result = await archive.read(0, { length: 3, maxOutputBytes: 3 });
    expect(result.bytes).toEqual(new Uint8Array([0, 1, 2]));
    expect(result.work.sourceBytes).toBe(32768);
    expect(result.work.decodedBytes).toBe(32768);
    expect(result.work.outputBytes).toBe(3);
    expect(result.blocks).toEqual([{ blockId: 0, role: "covering", status: "checksum-verified" }]);
    const unchecked = await archive.read(0, { length: 3, verify: false, maxSourceBytes: 3, maxDecodedBytes: 3 });
    expect(unchecked.integrity).toBe("pending");
    expect(unchecked.work.sourceBytes).toBe(3);
    expect(unchecked.blocks).toEqual([{ blockId: 0, role: "covering", status: "pending" }]);
    const large = archive.entries.find((entry) => entry.name === "large.bin")!;
    const late = await archive.read(large.id, { offset: 100000, length: 7 });
    expect(late.bytes).toEqual(decodeBase64(fixtures.stored.entries[large.id]!.body).subarray(100000, 100007));
    expect(late.blocks).toHaveLength(1);
    expect(late.work.sourceBytes).toBe(32768);
    const across = await archive.read(large.id, { offset: 32690, length: 20 });
    expect(across.blocks).toHaveLength(2);
    expect(across.bytes).toEqual(decodeBase64(fixtures.stored.entries[large.id]!.body).subarray(32690, 32710));
  });

  it("detects corruption beyond a requested file and never calls absent checksums verified", async () => {
    const bytes = original.slice();
    const block = layout(bytes).blocks[0]!;
    // Offset100 belongs to the neighboring large file, outside the first file's73-byte extent.
    bytes[block.body + 100] = bytes[block.body + 100]! ^ 1;
    const archive = await openCab(source(bytes));
    await expect(archive.read(0, { length: 1 })).rejects.toMatchObject({ code: "checksum-mismatch" });
    expect((await archive.read(0, { length: 1, verify: false })).bytes).toEqual(new Uint8Array([0]));
    word(bytes, block.header, 0);
    const absent = await openCab(source(bytes));
    const result = await absent.read(0, { length: 1, maxSourceBytes: 1 });
    expect(result.integrity).toBe("none");
    expect(result.blocks).toEqual([{ blockId: 0, role: "covering", status: "checksum-absent" }]);
    expect(result.work.sourceBytes).toBe(1);
    expect((await absent.read(0, { length: 0 })).blocks).toEqual([]);
  });

  it("bounds directory admission, source work, selected work and aggregate previews", async () => {
    for (
      const options of [
        { maxFolders: 0 },
        { maxEntries: 1 },
        { maxBlocks: 1 },
        { maxMetadataBytes: 35 },
        { maxSourceBytes: 35 },
        { maxRequests: 0 },
        { maxDecodedBytes: 35 },
      ]
    ) await expect(openCab(source(original), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openCab(source(original), { maxNameBytes: 2 })).rejects.toBeInstanceOf(Error);
    await expect(openCab(source(original), { maxNameBytes: 257 })).rejects.toBeInstanceOf(RangeError);
    const archive = await openCab(source(original));
    for (const options of [{ maxSourceBytes: 1 }, { maxDecodedBytes: 1 }, { maxOutputBytes: 0 }, { maxRequests: 0 }]) {
      await expect(archive.read(0, { length: 1, ...options })).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const ledger = createArchiveLedger({ maxOutputBytes: 3 });
    await archive.read(0, { length: 2, ledger });
    await expect(archive.read(0, { length: 2, ledger })).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("rejects bad physical/logical extents, stored/split block sizes and truncated metadata/data", async () => {
    const parsed = layout(original);
    const malformed: Uint8Array[] = [];
    const mutation = (offset: number, value: number, width = 4) => {
      const bytes = original.slice();
      word(bytes, offset, value, width);
      malformed.push(bytes);
    };
    mutation(4, 1);
    mutation(8, original.length - 1);
    mutation(16, 35);
    mutation(parsed.folder, 36);
    mutation(parsed.files + 4, 0xffffffff);
    mutation(parsed.files, 0xffffffff);
    mutation(parsed.files + 8, 1, 2);
    mutation(parsed.blocks[0]!.header + 4, 32767, 2);
    mutation(parsed.blocks[0]!.header + 6, 32769, 2);
    for (const bytes of [...malformed, original.subarray(0, 35), original.subarray(0, -1)]) {
      await expect(openCab(source(bytes))).rejects.toBeInstanceOf(Error);
    }
    const split = original.slice();
    word(split, parsed.blocks[0]!.header + 6, 0, 2);
    await expect(openCab(source(split))).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("refuses cabinet sets, unsupported versions and locale-dependent names without executing attributes", async () => {
    for (const flags of [1, 2, 8]) {
      const bytes = original.slice();
      word(bytes, 30, flags, 2);
      await expect(openCab(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
    const continuation = original.slice();
    word(continuation, layout(continuation).files + 8, 0xfffd, 2);
    await expect(openCab(source(continuation))).rejects.toMatchObject({ code: "unsupported-profile" });
    const version = original.slice();
    version[24] = 2;
    await expect(openCab(source(version))).rejects.toMatchObject({ code: "unsupported-profile" });
    const locale = original.slice();
    locale[layout(locale).files + 16] = 255;
    await expect(openCab(source(locale))).rejects.toMatchObject({ code: "unsupported-profile" });
    const utf8 = original.slice();
    word(utf8, layout(utf8).files + 14, 0x80, 2);
    utf8[layout(utf8).files + 16] = 255;
    await expect(openCab(source(utf8))).rejects.toMatchObject({ code: "unsupported-profile" });
  });

  it("preserves duplicate raw names and refuses invalid caller ranges", async () => {
    const bytes = original.slice();
    const first = layout(bytes).files;
    // first.bin and large.bin are both nine bytes, so this preserves all fixture extents.
    bytes.set(new TextEncoder().encode("first.bin"), first + 16 + 10 + 16);
    const archive = await openCab(source(bytes));
    expect(archive.entries.filter((entry) => entry.name === "first.bin")).toHaveLength(2);
    for (const options of [{ offset: -1 }, { length: Infinity }, { offset: 74 }, { offset: 72, length: 2 }]) {
      await expect(archive.read(0, options)).rejects.toBeInstanceOf(RangeError);
    }
    await expect(archive.read(1000)).rejects.toBeInstanceOf(RangeError);
  });

  it("requires snapshot evidence, preserves source errors and observes cancellation including empty reads", async () => {
    let calls = 0;
    const borrowed: ByteSourceType = {
      size: original.length,
      async read(offset, length) {
        calls++;
        return original.slice(offset, offset + length);
      },
    };
    await expect(openCab(borrowed)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(calls).toBe(0);
    const archive = await openCab(borrowed, { allowUnverifiedSource: true });
    expect(archive.source.stability).toBe("unverified");
    const controller = new AbortController();
    const reason = new Error("cancel CAB");
    controller.abort(reason);
    const before = calls;
    await expect(openCab(borrowed, { allowUnverifiedSource: true, signal: controller.signal })).rejects.toBe(reason);
    await expect(archive.read(0, { length: 0, signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toBe(before);
    await expect(openCab({
      size: original.length,
      stability: "caller",
      read() {
        return Promise.reject(reason);
      },
    })).rejects.toBe(reason);
    await expect(openCab({
      size: original.length,
      stability: "caller",
      async read() {
        return new Uint8Array(35);
      },
    })).rejects.toMatchObject({ code: "invalid-archive" });
  });
});
