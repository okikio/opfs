import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import { createBlobSource } from "../src/source.ts";
import { createArchiveLedger, openUdf } from "../src/archive/udf.ts";
import type { UdfArchiveType } from "../src/archive/udf.ts";
import fixture from "./fixtures/udf/independent.json" with { type: "json" };

const sector = 2048;
const source = (bytes: Uint8Array) => createBlobSource(new Blob([new Uint8Array(bytes).buffer]));
/** Independent polynomial long division; the ECMA known three-byte vector is checked below. */
function crc(bytes: Uint8Array): number {
  let remainder = 0;
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      const outgoing = remainder >>> 15;
      remainder = (remainder * 2 + (byte >>> bit & 1)) & 65535;
      if (outgoing) remainder ^= 0x1021;
    }
  }
  for (let bit = 0; bit < 16; bit++) {
    const outgoing = remainder >>> 15;
    remainder = remainder * 2 & 65535;
    if (outgoing) remainder ^= 0x1021;
  }
  return remainder;
}
const data = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function tagged(bytes: Uint8Array, id: number, block: number, length: number): void {
  const view = data(bytes);
  view.setUint16(0, id, true);
  view.setUint16(2, 2, true);
  bytes[4] = 0;
  bytes[5] = 0;
  view.setUint16(8, crc(bytes.subarray(16, length)), true);
  view.setUint16(10, length - 16, true);
  view.setUint32(12, block, true);
  bytes[4] = bytes.subarray(0, 16).reduce((sum, byte, index) => sum + (index === 4 ? 0 : byte), 0) & 255;
}
function charset(bytes: Uint8Array, offset: number): void {
  bytes.set(new TextEncoder().encode("OSTA Compressed Unicode"), offset + 1);
}
function domain(bytes: Uint8Array, offset: number): void {
  bytes.set(new TextEncoder().encode("*OSTA UDF Compliant"), offset + 1);
  data(bytes).setUint16(offset + 24, 0x0102, true);
}
function address(bytes: Uint8Array, offset: number, block: number, length = sector): void {
  data(bytes).setUint32(offset, length, true);
  data(bytes).setUint32(offset + 4, block, true);
}
/** Authored physical layout, not a claim of genuine-producer interoperability. */
function wire(): Uint8Array {
  const bytes = new Uint8Array(280 * sector);
  const block = (number: number) => bytes.subarray(number * sector, (number + 1) * sector);
  for (const [index, id] of ["BEA01", "NSR02", "TEA01"].entries()) {
    const value = block(16 + index);
    value.set(new TextEncoder().encode(id), 1);
    value[6] = 1;
  }
  address(block(256), 16, 32, sector * 16);
  tagged(block(256), 2, 256, 512);
  data(block(32)).setUint16(56, 1, true);
  data(block(32)).setUint16(58, 1, true);
  tagged(block(32), 1, 32, 512);
  const partition = block(33);
  data(partition).setUint16(20, 1, true);
  partition.set(new TextEncoder().encode("+NSR02"), 25);
  data(partition).setUint32(184, 1, true);
  data(partition).setUint32(188, 263, true);
  data(partition).setUint32(192, 17, true);
  tagged(partition, 5, 33, 512);
  const logical = block(34);
  charset(logical, 20);
  domain(logical, 216);
  data(logical).setUint32(212, sector, true);
  address(logical, 248, 0);
  data(logical).setUint32(264, 6, true);
  data(logical).setUint32(268, 1, true);
  address(logical, 432, 261, sector * 2);
  logical[440] = 1;
  logical[441] = 6;
  data(logical).setUint16(442, 1, true);
  tagged(logical, 6, 34, 446);
  tagged(block(35), 8, 35, 512);
  const integrity = block(261);
  data(integrity).setUint32(28, 1, true);
  data(integrity).setUint32(72, 1, true);
  data(integrity).setUint32(76, 46, true);
  data(integrity).setUint16(128, 0x0102, true);
  tagged(integrity, 9, 261, 134);
  tagged(block(262), 8, 262, 512);
  const fsd = block(263);
  charset(fsd, 48);
  charset(fsd, 240);
  domain(fsd, 416);
  address(fsd, 400, 1);
  tagged(fsd, 256, 0, 512);
  const fe = (number: number, type: number, length: number, physical: number): void => {
    const bytes = block(263 + number);
    data(bytes).setUint16(20, 4, true);
    data(bytes).setUint16(24, 1, true);
    bytes[27] = type;
    data(bytes).setBigUint64(56, BigInt(length), true);
    data(bytes).setUint32(172, 8, true);
    address(bytes, 176, physical, length);
    tagged(bytes, 261, number, 184);
  };
  fe(1, 4, 88, 2);
  fe(3, 5, 3, 4);
  const directory = block(265);
  const parent = directory.subarray(0, 40);
  data(parent).setUint16(16, 1, true);
  parent[18] = 10;
  address(parent, 20, 1);
  tagged(parent, 0x0101, 2, 40);
  const file = directory.subarray(40, 88);
  data(file).setUint16(16, 1, true);
  file[19] = 9;
  address(file, 20, 3);
  file[38] = 8;
  file.set(new TextEncoder().encode("file.bin"), 39);
  tagged(file, 0x0101, 2, 48);
  block(267).set([42, 0, 255]);
  return bytes;
}
function retag(image: Uint8Array, block: number): void {
  const bytes = image.subarray(block * sector, (block + 1) * sector);
  tagged(bytes, data(bytes).getUint16(0, true), data(bytes).getUint32(12, true), data(bytes).getUint16(10, true) + 16);
}
function path(archive: UdfArchiveType, id: number): string {
  const entry = archive.entries[id]!;
  return entry.parentId < 0 ? entry.name : `${path(archive, entry.parentId)}/${entry.name}`;
}

describe("bounded UDF 1.02", () => {
  it("matches the ECMA CRC example and reads authored recorded extents", async () => {
    expect(crc(new Uint8Array([0x70, 0x6a, 0x77]))).toBe(0x3299);
    const archive = await openUdf(source(wire()));
    expect(archive.metadata).toBe("descriptor-crc16-verified");
    expect(archive.entries[0]).toMatchObject({ name: "file.bin", size: 3, icb: 3, allocation: "short" });
    expect((await archive.read(0)).bytes).toEqual(new Uint8Array([42, 0, 255]));
    expect((await archive.read(0, { offset: 1, length: 1 })).bytes).toEqual(new Uint8Array([0]));
    expect((await archive.read(0)).integrity).toBe("none");
  });
  it("reads every original file through the genuine UDF namespace", async () => {
    expect(fixture.listing).toContain("Type = Udf");
    const archive = await openUdf(source(decodeBase64(fixture.archive)));
    const indexed = new Map(
      archive.entries.filter((entry) => entry.kind === "file").map((entry) => [path(archive, entry.id), entry]),
    );
    expect(indexed.size).toBe(fixture.entries.length);
    for (const item of fixture.entries) {
      const entry = indexed.get(item.name);
      expect(entry).toBeDefined();
      expect((await archive.read(entry!.id)).bytes).toEqual(decodeBase64(item.body));
    }
  });
  it("borrows member ranges without fetching unrelated payload extents", async () => {
    const raw = decodeBase64(fixture.archive);
    const calls: [number, number][] = [];
    const archive = await openUdf({
      size: raw.length,
      stability: "immutable",
      identity: "genuine-fixture",
      async read(offset, length) {
        calls.push([offset, length]);
        return raw.subarray(offset, offset + length);
      },
    });
    const entry = archive.entries.find((entry) => entry.name === "large.bin")!;
    const unrelated = archive.entries.find((entry) => entry.name === "unrelated.bin")!;
    calls.length = 0;
    const member = archive.member(entry.id);
    const bytes = await member.read(2040, 37);
    expect(bytes).toEqual(
      decodeBase64(fixture.entries.find((item) => item.name === "large.bin")!.body).subarray(2040, 2077),
    );
    expect(calls.reduce((sum, [, length]) => sum + length, 0)).toBe(37);
    expect(
      calls.some(([offset, length]) =>
        unrelated.extents.some((extent) => offset < extent.offset + extent.length && offset + length > extent.offset)
      ),
    ).toBe(false);
    expect(member.identity).toContain(`:icb:${entry.icb}`);
  });
});

describe("UDF framing refusal", () => {
  it("refuses damaged tags, uncovered fields, wrong locations and body CRC corruption", async () => {
    for (const offset of [256 * sector + 4, 33 * sector + 188, 264 * sector + 56, 265 * sector + 39]) {
      const bytes = wire();
      bytes[offset] = bytes[offset]! ^ 1;
      await expect(openUdf(source(bytes))).rejects.toMatchObject({ code: "checksum-mismatch" });
    }
    const uncovered = wire();
    tagged(uncovered.subarray(34 * sector, 35 * sector), 6, 34, 440);
    await expect(openUdf(source(uncovered))).rejects.toMatchObject({ code: "invalid-archive" });
    const location = wire();
    data(location).setUint32(256 * sector + 12, 255, true);
    retag(location, 256);
    await expect(openUdf(source(location))).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("refuses unsupported revisions, maps, ICB strategies, sparse and transformed allocations", async () => {
    for (
      const [block, offset, value, width] of [[34, 240, 0x0150, 2], [34, 440, 2, 1], [264, 20, 4096, 2], [
        266,
        176,
        0x40000003,
        4,
      ], [266, 34, 0x800, 2]] as const
    ) {
      const bytes = wire();
      const view = data(bytes.subarray(block * sector));
      if (width === 1) view.setUint8(offset, value);
      else if (width === 2) view.setUint16(offset, value, true);
      else view.setUint32(offset, value, true);
      retag(bytes, block);
      await expect(openUdf(source(bytes))).rejects.toMatchObject({ code: "unsupported-profile" });
    }
  });
  it("bounds allocation sums, information lengths, directory records and parent links", async () => {
    const identifier = wire();
    identifier[33 * sector + 31] = 65;
    retag(identifier, 33);
    await expect(openUdf(source(identifier))).rejects.toMatchObject({ code: "invalid-archive" });
    const range = wire();
    data(range).setUint32(266 * sector + 180, 17, true);
    retag(range, 266);
    await expect(openUdf(source(range))).rejects.toMatchObject({ code: "invalid-archive" });
    const size = wire();
    data(size).setBigUint64(266 * sector + 56, 9007199254740992n, true);
    retag(size, 266);
    await expect(openUdf(source(size))).rejects.toMatchObject({ code: "unsupported-profile" });
    const parent = wire();
    data(parent).setUint32(265 * sector + 24, 3, true);
    tagged(parent.subarray(265 * sector, 265 * sector + 40), 0x0101, 2, 40);
    await expect(openUdf(source(parent))).rejects.toMatchObject({ code: "invalid-archive" });
    const truncated = wire();
    data(truncated).setUint16(265 * sector + 40 + 36, 0xfffc, true);
    await expect(openUdf(source(truncated))).rejects.toMatchObject({ code: "invalid-archive" });
    await expect(openUdf(source(wire().subarray(0, -1)))).rejects.toMatchObject({ code: "invalid-archive" });
  });
});

describe("UDF limits and lifetime", () => {
  it("admits bounded index and selected output before member access", async () => {
    for (
      const options of [{ maxDescriptors: 0 }, { maxEntries: 0 }, { maxDirectoryBytes: 87 }, { maxNamesBytes: 7 }, {
        maxExtents: 1,
      }, { maxOutputBytes: 0 }]
    ) {
      await expect(openUdf(source(wire()), options)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    const bytes = wire();
    let calls = 0;
    const archive = await openUdf({
      size: bytes.length,
      stability: "immutable",
      async read(offset, length) {
        calls++;
        return bytes.subarray(offset, offset + length);
      },
    });
    const before = calls;
    await expect(archive.read(0, { maxOutputBytes: 2 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(calls).toBe(before);
  });
  it("retains the opening ledger and all abort signals through reads and member sources", async () => {
    const ledger = createArchiveLedger();
    const abort = new AbortController();
    const archive = await openUdf(source(wire()), { ledger, signal: abort.signal });
    const member = archive.member(0, { maxSourceBytes: 2 });
    expect(await member.read(0, 2)).toEqual(new Uint8Array([42, 0]));
    await expect(member.read(2, 1)).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(ledger.inspect().sourceBytes).toBeGreaterThan(archive.work.sourceBytes);
    const reason = new Error("UDF opening lifetime ended");
    abort.abort(reason);
    await expect(archive.read(0, { length: 0 })).rejects.toBe(reason);
    await expect(member.read(0, 0)).rejects.toBe(reason);
  });
  it("joins an outstanding provider read and retains its independent failure during abort", async () => {
    const raw = wire();
    let active = false;
    let release: ((reason: unknown) => void) | undefined;
    const abort = new AbortController();
    const archive = await openUdf({
      size: raw.length,
      stability: "immutable",
      read(offset, length) {
        if (!active) return Promise.resolve(raw.subarray(offset, offset + length));
        return new Promise((_resolve, reject) => {
          release = reject;
        });
      },
    });
    active = true;
    const pending = archive.read(0, { signal: abort.signal });
    abort.abort(new Error("Cancelled while provider is active"));
    const failure = new Error("Independent provider failed");
    release!(failure);
    await expect(pending).rejects.toBe(failure);
  });
});

describe("UDF exact admission and graph controls", () => {
  it("rejects exhausted opening/additional source and request ledgers before provider I/O", async () => {
    for (const kind of ["sourceBytes", "requests"] as const) {
      let locked = false;
      const failure = new Error(`Exhausted ${kind}`);
      const base = createArchiveLedger();
      const ledger = {
        reserve(dimension: keyof ReturnType<typeof base.inspect>, count: number) {
          if (locked && dimension === kind && count) throw failure;
          base.reserve(dimension, count);
        },
        inspect: () => base.inspect(),
      };
      const raw = wire();
      let calls = 0;
      const archive = await openUdf({
        size: raw.length,
        stability: "immutable",
        async read(offset, length) {
          calls++;
          return raw.subarray(offset, offset + length);
        },
      }, { ledger });
      const member = archive.member(0);
      const before = calls;
      locked = true;
      await expect(archive.read(0)).rejects.toBe(failure);
      await expect(member.read(0, 3)).rejects.toBe(failure);
      expect(calls).toBe(before);
      const extra = createArchiveLedger(kind === "sourceBytes" ? { maxSourceBytes: 2 } : { maxRequests: 0 });
      const fresh = await openUdf(source(raw));
      await expect(fresh.read(0, { ledger: extra })).rejects.toMatchObject({ code: "budget-exceeded" });
    }
  });
  it("reserves exact physical source costs once across repeated and distinct ledgers", async () => {
    const ledger = createArchiveLedger();
    const archive = await openUdf(source(wire()), { ledger });
    const before = ledger.inspect();
    const result = await archive.read(0, { ledger });
    expect(result.work).toEqual({ sourceBytes: 3, requests: 1, decodedBytes: 0, outputBytes: 3 });
    expect(ledger.inspect().sourceBytes - before.sourceBytes).toBe(3);
    expect(ledger.inspect().requests - before.requests).toBe(1);
    const extra = createArchiveLedger();
    await archive.member(0, { ledger: extra }).read(0, 3);
    expect(extra.inspect()).toEqual(result.work);
  });
  it("refuses directory cycles, wrong kinds and ambiguous alias ICB lengths", async () => {
    const cycle = wire();
    const fid = cycle.subarray(265 * sector + 40, 265 * sector + 88);
    fid[18] = 2;
    address(fid, 20, 1);
    tagged(fid, 0x0101, 2, 48);
    await expect(openUdf(source(cycle))).rejects.toMatchObject({ code: "unsupported-profile" });
    const kind = wire();
    const wrong = kind.subarray(265 * sector + 40, 265 * sector + 88);
    wrong[18] = 2;
    tagged(wrong, 0x0101, 2, 48);
    await expect(openUdf(source(kind))).rejects.toMatchObject({ code: "invalid-archive" });
    const alias = wire();
    const truncated = alias.subarray(265 * sector + 40, 265 * sector + 88);
    truncated[18] = 2;
    address(truncated, 20, 1, 176);
    tagged(truncated, 0x0101, 2, 48);
    await expect(openUdf(source(alias))).rejects.toMatchObject({ code: "invalid-archive" });
  });
  it("captures source capability and policy before awaiting provider code", async () => {
    const raw = wire();
    let first = true;
    let release: (() => void) | undefined;
    const provider = {
      size: raw.length,
      stability: "immutable" as const,
      async read(offset: number, length: number) {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return raw.subarray(offset, offset + length);
      },
    };
    const options = { maxEntries: 0 };
    const pending = openUdf(provider, options);
    options.maxEntries = 100;
    provider.read = async () => {
      throw new Error("Changed source read must not be used");
    };
    release!();
    await expect(pending).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(openUdf({ ...source(raw), stability: "invalid" as never })).rejects.toBeInstanceOf(TypeError);
  });
});

describe("UDF independently accepted allocation profiles", () => {
  for (const adapted of fixture.adaptations) {
    it(`reads every original byte for the labelled ${adapted.name} adaptation`, async () => {
      const raw = decodeBase64(adapted.archive);
      const calls: [number, number][] = [];
      const archive = await openUdf({
        size: raw.length,
        stability: "immutable",
        async read(offset, length) {
          calls.push([offset, length]);
          return raw.subarray(offset, offset + length);
        },
      });
      const indexed = new Map(
        archive.entries.filter((entry) => entry.kind === "file").map((entry) => [path(archive, entry.id), entry]),
      );
      expect(indexed.size).toBe(fixture.entries.length);
      for (const item of fixture.entries) {
        const actual = (await archive.read(indexed.get(item.name)!.id)).bytes;
        const expected = decodeBase64(item.body);
        expect(actual.length).toBe(expected.length);
        expect(actual.every((byte, index) => byte === expected[index])).toBe(true);
      }
      const entry = indexed.get("large.bin")!;
      expect(entry.allocation).toBe(adapted.name.includes("long") ? "long" : "short");
      if (adapted.name.startsWith("split")) {
        expect(entry.extents).toHaveLength(2);
        calls.length = 0;
        const range = await archive.read(entry.id, { offset: 2040, length: 37 });
        expect(range.bytes).toEqual(
          decodeBase64(fixture.entries.find((item) => item.name === "large.bin")!.body).subarray(2040, 2077),
        );
        expect(calls.map(([, length]) => length)).toEqual([8, 29]);
        expect(range.work).toMatchObject({ sourceBytes: 37, requests: 2, outputBytes: 37 });
        const before = calls.length;
        await expect(archive.read(entry.id, { offset: 2040, length: 37, maxRequests: 1 })).rejects.toMatchObject({
          code: "budget-exceeded",
        });
        expect(calls.length).toBe(before);
      }
    });
  }
  it("actually indexes directory identifiers that cross physical sector boundaries", async () => {
    const raw = decodeBase64(fixture.archive);
    const archive = await openUdf(source(raw));
    const crossing = archive.entries.filter((entry) => {
      const bytes = raw.subarray(entry.recordOffset);
      const length = Math.ceil((38 + bytes[19]! + data(bytes).getUint16(36, true)) / 4) * 4;
      return entry.recordOffset % sector + length > sector;
    });
    expect(crossing.length).toBeGreaterThan(0);
    expect(archive.entries.some((entry) => entry.name === "雪.bin")).toBe(true);
    expect(archive.entries.some((entry) => entry.name === "café.bin")).toBe(true);
  });
});
