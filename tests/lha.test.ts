import { describe, it } from "node:test";
import { expect } from "@std/expect";
import { decodeBase64 } from "@std/encoding/base64";
import type { ByteSourceType } from "../src/source.ts";
import { createArchiveLedger, openLha } from "../src/archive/lha.ts";
import fixtures from "./fixtures/lha/independent.json" with { type: "json" };

const encode = (text: string) => new TextEncoder().encode(text);
/** Independent polynomial-long-division oracle, using a forward polynomial and reversed input bits. */
function checksum(bytes: Uint8Array): number {
  let state = 0;
  for (const byte of bytes) {
    let reversed = 0;
    for (let bit = 0; bit < 8; bit++) reversed = reversed * 2 + ((byte >>> bit) & 1);
    state ^= reversed << 8;
    for (let bit = 0; bit < 8; bit++) state = ((state << 1) ^ (state & 0x8000 ? 0x8005 : 0)) & 65535;
  }
  let result = 0;
  for (let bit = 0; bit < 16; bit++) result = result * 2 + ((state >>> bit) & 1);
  return result;
}
function join(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
function sum(header: Uint8Array): void {
  header[1] = header.subarray(2, header[0]! + 2).reduce((sum, byte) => (sum + byte) & 255, 0);
}
/** Authored envelopes isolate malformed framing; genuine JLHA fixtures provide interoperability separately. */
function wire(
  level: 0 | 1 | 2,
  body = encode("123456789"),
  extras: { type: number; body: Uint8Array }[] = [],
): Uint8Array {
  const name = encode("tiny.txt");
  const extensions = level === 0
    ? []
    : [{ type: 0, body: new Uint8Array(2) }, ...(level === 2 ? [{ type: 1, body: name }] : []), ...extras];
  const sizes = extensions.map((entry) => entry.body.length + 3);
  const size = level === 2 ? 26 : 24 + name.length + (level === 1 ? 3 : 0);
  const base = new Uint8Array(size);
  const fields = new DataView(base.buffer);
  if (level === 2) fields.setUint16(0, size + sizes.reduce((a, b) => a + b, 0), true);
  else base[0] = size - 2;
  base.set(encode("-lh0-"), 2);
  fields.setUint32(7, body.length + (level === 1 ? sizes.reduce((a, b) => a + b, 0) : 0), true);
  fields.setUint32(11, body.length, true);
  base[19] = 32;
  base[20] = level;
  if (level === 2) {
    fields.setUint16(21, checksum(body), true);
    base[23] = 85;
  } else {
    base[21] = name.length;
    base.set(name, 22);
    fields.setUint16(22 + name.length, checksum(body), true);
  }
  if (level === 1) base[24 + name.length] = 85;
  if (level !== 0) fields.setUint16(size - 2, sizes[0] ?? 0, true);
  if (level !== 2) sum(base);
  const chain = extensions.map((entry, index) => {
    const bytes = new Uint8Array(entry.body.length + 3);
    bytes[0] = entry.type;
    bytes.set(entry.body, 1);
    new DataView(bytes.buffer).setUint16(bytes.length - 2, sizes[index + 1] ?? 0, true);
    return bytes;
  });
  const header = join([base, ...chain]);
  if (level !== 0) new DataView(header.buffer).setUint16(size + 1, checksum(header), true);
  return join([header, body, new Uint8Array(1)]);
}
/** A provider may reuse one scratch buffer without changing its immutable physical bytes. */
function source(bytes: Uint8Array, calls: { offset: number; length: number }[] = []): ByteSourceType {
  const scratch = new Uint8Array(bytes.length);
  return {
    size: bytes.length,
    stability: "immutable",
    async read(offset, length) {
      calls.push({ offset, length });
      scratch.set(bytes.subarray(offset, offset + length));
      return scratch.subarray(0, length);
    },
  };
}

describe("bounded LHA stored member inspection", () => {
  it("reads every genuine JLHA level and independent full-byte payload oracle without indexing payloads", async () => {
    for (const fixture of fixtures.fixtures) {
      const calls: { offset: number; length: number }[] = [];
      const archive = await openLha(source(decodeBase64(fixture.archive.base64), calls));
      const opening = calls.slice();
      for (const entry of archive.entries.filter((entry) => entry.kind === "file")) {
        const name = entry.name.replaceAll("\\", "/");
        const original = (fixture.payloads as Record<string, { base64: string }>)[name];
        expect(original, `${fixture.level}/${entry.name}`).toBeDefined();
        const expected = decodeBase64(original!.base64);
        expect(entry.level).toBe(fixture.level);
        expect(entry.readable).toBe(true);
        expect(
          opening.some((call) =>
            call.offset < entry.offset + entry.storedSize && call.offset + call.length > entry.offset
          ),
        ).toBe(false);
        const result = await archive.read(entry.id);
        expect(result.bytes).toEqual(expected);
        expect(result.integrity).toBe("crc16-verified");
        expect(result.work.sourceBytes).toBe(expected.length);
        if (expected.length > 37) {
          const offset = expected.length - 37;
          expect((await archive.read(entry.id, { offset, length: 37, verify: false })).bytes).toEqual(
            expected.slice(offset),
          );
          expect((await archive.read(entry.id, { offset, length: 37 })).bytes).toEqual(expected.slice(offset));
        }
      }
      expect(archive.entries.filter((entry) => entry.kind === "file").length).toBe(
        Object.keys(fixture.payloads).length,
      );
    }
  });

  it("separates header evidence, full file CRC and unverified selected suffixes", async () => {
    expect(checksum(encode("123456789"))).toBe(0xbb3d);
    for (const level of [0, 1, 2] as const) {
      const bytes = wire(level);
      const archive = await openLha(source(bytes));
      expect(archive.entries[0]!.crc16).toBe(0xbb3d);
      expect(archive.entries[0]!.headerIntegrity).toBe(
        level === 0 ? "sum-verified" : level === 1 ? "sum-and-crc16-verified" : "crc16-verified",
      );
      const preview = await archive.read(0, { offset: 2, length: 3, verify: false });
      expect(preview.bytes).toEqual(encode("345"));
      expect(preview.integrity).toBe("pending");
      expect(preview.work).toEqual({ sourceBytes: 3, requests: 1, decodedBytes: 3, outputBytes: 3 });
      const corrupt = bytes.slice();
      corrupt[archive.entries[0]!.offset + 8] = 0;
      const changed = await openLha(source(corrupt));
      expect((await changed.read(0, { length: 1, verify: false })).bytes).toEqual(encode("1"));
      await expect(changed.read(0, { length: 1 })).rejects.toMatchObject({ code: "checksum-mismatch" });
      await expect(changed.read(0, { verify: false })).rejects.toMatchObject({ code: "checksum-mismatch" });
      const empty = await openLha(source(wire(level, new Uint8Array())));
      expect((await empty.read(0)).integrity).toBe("crc16-verified");
    }
  });

  it("refuses malformed checksums, extension geometry, structural unknowns and unsupported methods", async () => {
    for (const level of [0, 1, 2] as const) {
      const bytes = wire(level);
      const bad = bytes.slice();
      bad[15] = 99;
      await expect(openLha(source(bad))).rejects.toMatchObject({ code: "checksum-mismatch" });
      await expect(openLha(source(bytes.subarray(0, -1)))).rejects.toMatchObject({ code: "invalid-archive" });
      await expect(openLha(source(join([bytes, new Uint8Array(1)])))).rejects.toBeDefined();
      const method = bytes.slice();
      method.set(encode("-lh5-"), 2);
      if (level !== 2) sum(method);
      if (level === 0) {
        const compressed = await openLha(source(method));
        expect(compressed.entries[0]!.readable).toBe(false);
        await expect(compressed.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
      }
    }
    for (const type of [0x39, 0x42, 0x7f]) {
      await expect(openLha(source(wire(2, encode("x"), [{ type, body: new Uint8Array(16) }])))).rejects.toMatchObject({
        code: "unsupported-profile",
      });
    }
    await expect(openLha(source(wire(2, encode("x"), [{ type: 1, body: encode("other") }])))).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    const skip = wire(1);
    new DataView(skip.buffer).setUint32(7, 0, true);
    sum(skip);
    await expect(openLha(source(skip))).rejects.toMatchObject({ code: "invalid-archive" });
    const invalidChain = wire(2);
    new DataView(invalidChain.buffer).setUint16(24, 2, true);
    await expect(openLha(source(invalidChain))).rejects.toMatchObject({ code: "invalid-archive" });
    const wrongSize = wire(0);
    new DataView(wrongSize.buffer).setUint32(11, 8, true);
    sum(wrongSize);
    await expect(openLha(source(wrongSize))).rejects.toMatchObject({ code: "invalid-archive" });
  });

  it("preserves raw naming evidence, decodes only explicit separators, and refuses special-member reads", async () => {
    const body = encode("123456789");
    const directory = new Uint8Array([115, 117, 98, 255]);
    const named = await openLha(source(wire(2, body, [{ type: 2, body: directory }])));
    expect(named.entries[0]!.name).toBe("sub/tiny.txt");
    expect(named.entries[0]!.rawDirectory).toEqual(directory);
    const nonAscii = wire(2, body, [{ type: 2, body: new Uint8Array([233, 255]) }]);
    await expect(openLha(source(nonAscii))).rejects.toMatchObject({ code: "unsupported-profile" });
    const explicit = await openLha(source(nonAscii), {
      decodeName(bytes, role) {
        return role === "directory" ? "café/" : new TextDecoder().decode(bytes);
      },
    });
    expect(explicit.entries[0]!.name).toBe("café/tiny.txt");
    const special = await openLha(source(wire(2, body, [{ type: 0x50, body: new Uint8Array([0, 160]) }])));
    expect(special.entries[0]!.kind).toBe("special");
    await expect(special.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
    expect(() => special.member(0)).toThrow();
    const zero = wire(0, new Uint8Array());
    zero.set(encode("-lhd-"), 2);
    sum(zero);
    const listing = await openLha(source(zero));
    expect(listing.entries[0]!.kind).toBe("directory");
    await expect(listing.read(0)).rejects.toMatchObject({ code: "unsupported-profile" });
    // Total length 256 has a zero low byte, which must not be mistaken for EOF.
    const lowZero = wire(2, body, [{ type: 0x3f, body: new Uint8Array(211) }]);
    expect(lowZero[0]).toBe(0);
    expect((await (await openLha(source(lowZero))).read(0)).bytes).toEqual(body);
  });

  it("captures descriptors and options before awaits and protects retained raw names from callbacks", async () => {
    const bytes = wire(2);
    const calls: { offset: number; length: number }[] = [];
    const original = source(bytes, calls);
    const input = { ...original };
    let began!: () => void;
    const first = new Promise<void>((resolve) => began = resolve);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    input.read = async (offset, length) => {
      if (offset === 0) {
        began();
        await gate;
      }
      return original.read(offset, length);
    };
    const options = {
      maxEntries: 1,
      decodeName(value: Uint8Array) {
        const text = new TextDecoder().decode(value);
        // The borrowed provider reuses scratch synchronously, before its Promise settles.
        void original.read(0, 22);
        value.fill(0);
        return text;
      },
    };
    const pending = openLha(input, options);
    await first;
    input.size = 0;
    input.stability = "caller";
    input.read = async () => {
      throw new Error("mutated method");
    };
    options.maxEntries = 0;
    options.decodeName = () => "changed";
    release();
    const archive = await pending;
    expect(archive.entries[0]!.name).toBe("tiny.txt");
    expect(archive.entries[0]!.rawName).toEqual(encode("tiny.txt"));
    archive.entries[0]!.rawName.fill(0);
    expect(archive.entries[0]!.rawName).toEqual(encode("tiny.txt"));
    const result = await archive.read(0);
    await original.read(0, 22);
    expect(result.bytes).toEqual(encode("123456789"));
  });

  it("retains opening/additional/member limits, admits known physical work before I/O, and deduplicates shared ledgers", async () => {
    const bytes = wire(0);
    const calls: { offset: number; length: number }[] = [];
    const ledger = createArchiveLedger({ maxSourceBytes: bytes.length + 100, maxOutputBytes: 100 });
    const archive = await openLha(source(bytes, calls), { ledger });
    const before = ledger.inspect();
    const result = await archive.read(0, { length: 2, verify: false, ledger });
    expect(ledger.inspect().sourceBytes - before.sourceBytes).toBe(2);
    expect(result.work.outputBytes).toBe(2);
    const nested = archive.member(0, { ledger, maxSourceBytes: 3 });
    const memberBefore = ledger.inspect();
    expect(await nested.read(1, 2)).toEqual(encode("23"));
    expect(ledger.inspect().sourceBytes - memberBefore.sourceBytes).toBe(2);
    await expect(nested.read(0, 2)).rejects.toMatchObject({ code: "budget-exceeded" });
    const callCount = calls.length;
    await expect(archive.read(0, { ledger: createArchiveLedger({ maxSourceBytes: 0 }), length: 1 })).rejects
      .toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(0, { maxRequests: 0, length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    await expect(archive.read(0, { maxOutputBytes: 0, length: 1 })).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(calls.length).toBe(callCount);
    const exhausted = await openLha(source(bytes, calls), { maxSourceBytes: bytes.length - 9 });
    await expect(exhausted.read(0, { length: 1, verify: false })).rejects.toMatchObject({ code: "budget-exceeded" });
  });

  it("enforces metadata limits, stable-source evidence, exact reads and source/cancellation failure identity", async () => {
    const bytes = wire(2);
    for (
      const caps of [{ maxEntries: 0 }, { maxHeaderBytes: 21 }, { maxEntryHeaderBytes: 21 }, { maxExtensions: 0 }, {
        maxNameBytes: 2,
      }]
    ) {
      await expect(openLha(source(bytes), caps)).rejects.toMatchObject({ code: "budget-exceeded" });
    }
    await expect(openLha({ size: bytes.length, read: source(bytes).read })).rejects.toMatchObject({
      code: "unsupported-profile",
    });
    await expect(openLha({ ...source(bytes), stability: "wrong" as "caller" })).rejects.toBeInstanceOf(TypeError);
    await expect(openLha({ ...source(bytes), identity: "x".repeat(8193) })).rejects.toBeInstanceOf(TypeError);
    await expect(openLha({ ...source(bytes), read: async () => new Uint8Array() })).rejects.toMatchObject({
      code: "invalid-archive",
    });
    const failure = new Error("provider failed");
    await expect(openLha({
      ...source(bytes),
      read: async () => {
        throw failure;
      },
    })).rejects.toBe(failure);
    const controller = new AbortController();
    const archive = await openLha(source(bytes), { signal: controller.signal });
    const member = archive.member(0);
    controller.abort(failure);
    await expect(archive.read(0, { length: 0 })).rejects.toBe(failure);
    await expect(member.read(0, 1)).rejects.toBe(failure);
    const later = new AbortController();
    const sourceBytes = source(bytes);
    const active = await openLha({
      ...sourceBytes,
      async read(offset, length) {
        const part = await sourceBytes.read(offset, length);
        if (offset >= 26 && length === 9) later.abort(failure);
        return part;
      },
    }, { signal: later.signal });
    await expect(active.read(0)).rejects.toBe(failure);
  });
});
