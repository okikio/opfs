/** Authored format audits against independently pre-established native byte oracles.
 * These grammar readers are research controls, not independent native decoders. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { parseArgs } from "node:util";
import { read, save } from "./native.ts";
import type { ChunkType, FixtureType } from "./native.ts";

/** Coding words are little-endian physical words with most-significant bit first. */
class Bits {
  readonly data: Buffer;
  position = 0;
  count = 0;
  value = 0n;
  constructor(data: Buffer) {
    this.data = data;
  }
  ensure(count: number): void {
    while (this.count < count) {
      ok(this.position + 2 <= this.data.length, "Truncated coding word.");
      this.value = this.value << 16n | BigInt(this.data.readUInt16LE(this.position));
      this.position += 2;
      this.count += 16;
    }
  }
  take(count: number): number {
    ok(count >= 0 && count <= 32 && this.count >= count);
    this.count -= count;
    const result = Number(this.value >> BigInt(this.count));
    this.value &= (1n << BigInt(this.count)) - 1n;
    return result;
  }
  read(count: number): number {
    this.ensure(count);
    return this.take(count);
  }
  raw(length: number): Buffer {
    ok(this.count === 0 && this.position + length <= this.data.length);
    const value = this.data.subarray(this.position, this.position + length);
    this.position += length;
    return value;
  }
  alignRaw(): void {
    if (!this.count) equal(this.read(16), 0);
    else equal(this.value, 0n, "Nonzero raw header alignment.");
    this.count = 0;
    this.value = 0n;
  }
}

type TreeType = Map<string, number>;
/** Empty trees are allowed as metadata but cannot supply a decoded symbol. */
function tree(lengths: readonly number[], maximum: number): TreeType {
  const result: TreeType = new Map();
  let code = 0;
  for (let width = 1; width <= maximum; width++) {
    for (const [symbol, length] of lengths.entries()) {
      if (width === length) {
        result.set(`${width}:${code}`, symbol);
        code++;
      }
    }
    ok(code <= 2 ** width, "Oversubscribed canonical tree.");
    code *= 2;
  }
  ok(!code || code === 2 ** (maximum + 1), "Incomplete nonempty tree.");
  return result;
}
function symbol(bits: Bits, codes: TreeType, maximum: number, preload = false): number {
  ok(codes.size > 0);
  if (preload) bits.ensure(16);
  let code = 0;
  for (let width = 1; width <= maximum; width++) {
    code = code * 2 + (preload ? bits.take(1) : bits.read(1));
    const value = codes.get(`${width}:${code}`);
    if (value !== undefined) return value;
  }
  throw new Error("Invalid canonical symbol.");
}

/** The next-byte length escape is read outside the preloaded coding-word queue. */
function xpress(chunk: ChunkType) {
  const data = Buffer.from(chunk.packed, "base64"), expected = Buffer.from(chunk.decoded, "base64");
  ok(data.length >= 256 && data.length <= 65536 && expected.length <= 32768);
  const lengths = Array.from(
      { length: 512 },
      (_, index) => ((data[Math.floor(index / 2)] ?? 0) >> (4 * (index % 2))) & 15,
    ),
    codes = tree(lengths, 15);
  ok(codes.size > 0);
  const bits = new Bits(data);
  bits.position = 256;
  bits.ensure(32);
  const output = Buffer.alloc(expected.length), extended: number[] = [];
  let at = 0;
  const byte = (): number => {
    const value = data[bits.position++];
    ok(value !== undefined, "Truncated interleaved length byte.");
    return value;
  };
  while (at < expected.length) {
    const value = symbol(bits, codes, 15, true);
    bits.ensure(16);
    if (value < 256) {
      output[at++] = value;
      continue;
    }
    let length = value & 15;
    const width = value >> 4 & 15;
    if (length === 15) {
      const extra = byte();
      length += extra;
      if (extra === 255) {
        length = byte() | byte() << 8;
        ok(length >= 15);
        extended.push(length);
      }
    }
    length += 3;
    const distance = 2 ** width + bits.take(width);
    bits.ensure(16);
    ok(distance <= at && length <= expected.length - at);
    for (let index = 0; index < length; index++) {
      const value = output[at - distance];
      ok(value !== undefined);
      output[at++] = value;
    }
  }
  deepStrictEqual(output, expected, "Complete XPRESS bytes differ from the native API oracle.");
  const end = symbol(bits, codes, 15, true);
  bits.ensure(16);
  equal(end, 256);
  equal(bits.position, data.length);
  equal(bits.value, 0n);
  ok(bits.count >= 16 && bits.count <= 31);
  return {
    packed: data.length,
    decoded: output.length,
    endSymbol: end,
    remainingZeroBits: bits.count,
    exactExtent: true,
    extendedU16Lengths: extended,
  };
}

/** Pretree changes are modulo 17; a run may not cross the declared alphabet. */
function lengths(bits: Bits, target: number[], start: number, stop: number): void {
  const pretree = tree(Array.from({ length: 20 }, () => bits.read(4)), 15);
  let at = start;
  while (at < stop) {
    const value = symbol(bits, pretree, 15), previous = target[at];
    ok(previous !== undefined);
    if (value < 17) {
      target[at++] = (previous - value + 17) % 17;
      continue;
    }
    let run: number, length: number;
    if (value === 17) {
      run = 4 + bits.read(4);
      length = 0;
    } else if (value === 18) {
      run = 20 + bits.read(5);
      length = 0;
    } else {
      run = 4 + bits.read(1);
      const delta = symbol(bits, pretree, 15);
      ok(delta <= 16);
      length = (previous - delta + 17) % 17;
    }
    ok(run <= stop - at);
    target.fill(length, at, at + run);
    at += run;
  }
}
function lzx(chunk: ChunkType) {
  const data = Buffer.from(chunk.packed, "base64"), expected = Buffer.from(chunk.decoded, "base64");
  ok(data.length <= 65536 && expected.length <= 32768);
  const bits = new Bits(data),
    output = Buffer.alloc(expected.length),
    recent = [1, 1, 1],
    mainLengths = Array<number>(496).fill(0),
    lengthLengths = Array<number>(249).fill(0);
  const blocks = [], uses = { repeated: 0, explicit: 0, aligned: 0 };
  let at = 0;
  while (at < expected.length) {
    ok(blocks.length < 1024);
    const type = bits.read(3), defaultSizeBit = bits.read(1), size = defaultSizeBit ? 32768 : bits.read(16);
    ok(size > 0 && size <= expected.length - at);
    blocks.push({ type, defaultSizeBit, decoded: size });
    if (type === 3) {
      bits.alignRaw();
      const values = bits.raw(12);
      for (let index = 0; index < 3; index++) {
        const value = values.readUInt32LE(index * 4);
        ok(value > 0);
        recent[index] = value;
      }
      bits.raw(size).copy(output, at);
      at += size;
      if (size & 1) deepStrictEqual(bits.raw(1), Buffer.from([0]));
      continue;
    }
    ok(type === 1 || type === 2);
    const aligned = type === 2 ? tree(Array.from({ length: 8 }, () => bits.read(3)), 7) : new Map<string, number>();
    lengths(bits, mainLengths, 0, 256);
    lengths(bits, mainLengths, 256, 496);
    lengths(bits, lengthLengths, 0, 249);
    const mainTree = tree(mainLengths, 16), lengthTree = tree(lengthLengths, 16), end = at + size;
    while (at < end) {
      const value = symbol(bits, mainTree, 16);
      if (value < 256) {
        output[at++] = value;
        continue;
      }
      const slot = Math.floor((value - 256) / 8);
      let length = value & 7;
      if (length === 7) length += symbol(bits, lengthTree, 16);
      length += 2;
      let distance: number;
      if (slot < 3) {
        uses.repeated++;
        const previous = recent[slot], first = recent[0];
        ok(previous !== undefined && first !== undefined);
        distance = previous;
        recent[slot] = first;
      } else {
        uses.explicit++;
        const extra = slot < 4 ? 0 : Math.floor(slot / 2) - 1,
          base = slot < 4 ? slot - 2 : (2 + (slot & 1)) * 2 ** extra - 2;
        if (type === 2 && slot >= 8) {
          uses.aligned++;
          distance = bits.read(extra - 3) * 8 + symbol(bits, aligned, 7) + base;
        } else distance = bits.read(extra) + base;
        const first = recent[0], second = recent[1];
        ok(first !== undefined && second !== undefined);
        recent[2] = second;
        recent[1] = first;
      }
      recent[0] = distance;
      ok(distance > 0 && distance <= at && length <= end - at);
      for (let index = 0; index < length; index++) {
        const value = output[at - distance];
        ok(value !== undefined);
        output[at++] = value;
      }
    }
  }
  equal(bits.position, data.length);
  ok(bits.count >= 0 && bits.count <= 15);
  equal(bits.value, 0n);
  const beforeE8 = output.toString("base64"), translated: number[] = [];
  at = 0;
  while (at < output.length - 10) {
    if (output[at] !== 0xe8) {
      at++;
      continue;
    }
    const absolute = output.readInt32LE(at + 1);
    let relative = absolute;
    if (absolute >= 0 && absolute < 12000000) relative = absolute - at;
    else if (absolute >= -at && absolute < 0) relative = absolute + 12000000;
    if (relative !== absolute) {
      output.writeInt32LE(relative, at + 1);
      translated.push(at);
    }
    at += 5;
  }
  deepStrictEqual(output, expected, "Complete LZX bytes differ from independently established native resource oracle.");
  return {
    packed: data.length,
    decoded: output.length,
    blocks,
    uses,
    remainingZeroBits: bits.count,
    exactExtent: true,
    e8TranslatedPositions: translated,
    beforeE8,
  };
}

/** Audit fixed native resource receipts and save separate new research evidence. */
export function audit(profile: "xpress" | "lzx"): void {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { output: { type: "string" } } });
  const input = positionals[0];
  ok(input && positionals.length === 1 && values.output, "Use INPUT_NATIVE_JSON --output NEW_AUDIT_JSON.");
  const fixture: FixtureType = JSON.parse(read(input).toString("utf8"));
  ok(fixture.nativeResources.length <= 256);
  const receipts = [];
  for (const [resource, value] of fixture.nativeResources.entries()) {
    ok(value.chunks.length <= 64);
    for (const [chunk, data] of value.chunks.entries()) {
      if (data.compressed) receipts.push({ resource, chunk, ...(profile === "xpress" ? xpress(data) : lzx(data)) });
    }
  }
  save(values.output, {
    evidenceProfile:
      "Authored grammar audit against pre-established independent native complete resource bytes; not a third independent decoder",
    runtime: process.version,
    receipts,
  });
}
