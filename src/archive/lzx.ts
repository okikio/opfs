/** Internal bounded ordinary WIM LZX kernel; not CAB LZX or LZX Delta. @module */
import { isBytes, toView } from "../bytes.ts";
import { ArchiveError, invalid } from "./record.ts";

/** Coding words are little-endian, with their most significant bits consumed first. */
class Bits {
  position = 0;
  count = 0;
  value = 0;
  readonly bytes: Uint8Array;
  readonly charge: (count: number) => void;
  constructor(bytes: Uint8Array, charge: (count: number) => void) {
    this.bytes = bytes;
    this.charge = charge;
  }
  read(count: number): number {
    this.charge(count);
    while (this.count < count) {
      if (this.position + 2 > this.bytes.length) invalid("WIM LZX coding word is truncated.");
      this.value = this.value * 65536 + this.bytes[this.position]! + this.bytes[this.position + 1]! * 256;
      this.position += 2;
      this.count += 16;
    }
    this.count -= count;
    const divisor = 2 ** this.count, value = Math.floor(this.value / divisor);
    this.value %= divisor;
    return value;
  }
  raw(length: number): Uint8Array {
    this.charge(length);
    if (this.count || length > this.bytes.length - this.position) invalid("WIM LZX raw bytes are unavailable.");
    const bytes = this.bytes.subarray(this.position, this.position + length);
    this.position += length;
    return bytes;
  }
  align(): void {
    // A raw header always advances to the next word, even if already aligned.
    if (!this.count && this.read(16) !== 0) invalid("WIM LZX raw alignment is not zero.");
    if (this.value !== 0) invalid("WIM LZX raw alignment is not zero.");
    this.count = this.value = 0;
  }
}

interface TreeType {
  readonly counts: Uint16Array;
  readonly first: Uint32Array;
  readonly starts: Uint16Array;
  readonly symbols: Uint16Array;
  readonly width: number;
}

/** Empty trees are inert until used; every nonempty canonical tree must fill its code space. */
function tree(lengths: Uint8Array, maximum: number, charge: (count: number) => void): TreeType {
  charge(lengths.length);
  const counts = new Uint16Array(maximum + 1), first = new Uint32Array(maximum + 1);
  const starts = new Uint16Array(maximum + 1), symbols = new Uint16Array(lengths.length);
  let width = 0;
  for (const length of lengths) {
    if (length > maximum) invalid("WIM LZX Huffman length exceeds its alphabet limit.");
    if (length) {
      counts[length] = counts[length]! + 1;
      width = Math.max(width, length);
    }
  }
  let remaining = 1, code = 0, total = 0;
  for (let length = 1; length <= maximum; length++) {
    remaining = remaining * 2 - counts[length]!;
    if (remaining < 0) invalid("WIM LZX Huffman tree is oversubscribed.");
    code = (code + counts[length - 1]!) * 2;
    first[length] = code;
    starts[length] = total;
    total += counts[length]!;
  }
  if (width && remaining !== 0) invalid("WIM LZX nonempty Huffman tree is incomplete.");
  const slots = starts.slice();
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!;
    if (length) {
      symbols[slots[length]!] = symbol;
      slots[length] = slots[length]! + 1;
    }
  }
  return { counts, first, starts, symbols, width };
}

function symbol(bits: Bits, tree: TreeType): number {
  let code = 0;
  for (let length = 1; length <= tree.width; length++) {
    code = code * 2 + bits.read(1);
    const index = code - tree.first[length]!;
    if (index >= 0 && index < tree.counts[length]!) return tree.symbols[tree.starts[length]! + index]!;
  }
  return invalid("WIM LZX Huffman symbol is invalid or uses an empty tree.");
}

/** Pretree deltas refer to prior block lengths, never to lengths from another WIM chunk. */
function lengths(bits: Bits, target: Uint8Array, start: number, stop: number): void {
  const values = new Uint8Array(20);
  for (let i = 0; i < values.length; i++) values[i] = bits.read(4);
  const pretree = tree(values, 15, bits.charge);
  let at = start;
  while (at < stop) {
    const value = symbol(bits, pretree);
    if (value < 17) {
      bits.charge(1);
      target[at] = (target[at]! - value + 17) % 17;
      at++;
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
      const delta = symbol(bits, pretree);
      if (delta > 16) invalid("WIM LZX nested pretree delta must be in 0 through 16.");
      length = (target[at]! - delta + 17) % 17;
    }
    if (run > stop - at) invalid("WIM LZX pretree run crosses its declared alphabet.");
    bits.charge(run);
    target.fill(length, at, at + run);
    at += run;
  }
}

/**
 * Decode into a pre-reserved output buffer. The caller supplies cumulative work
 * admission/cancellation and a block counter shared by every selected chunk.
 * Scratch trees are bounded by the fixed 32 KiB dialect, with local ceilings of
 * 1 Mi kernel steps and 256 internal blocks. Neither buffer is retained.
 */
export function decodeLzx(
  input: Uint8Array,
  target: Uint8Array,
  charge: (count: number) => void,
  block: () => void,
): void {
  if (!isBytes(input) || !isBytes(target)) throw new TypeError("WIM LZX requires native byte views.");
  const bytes = toView(input), output = toView(target);
  if (
    bytes.buffer === output.buffer && bytes.byteOffset < output.byteOffset + output.length &&
    output.byteOffset < bytes.byteOffset + bytes.length
  ) throw new TypeError("WIM LZX input and output ranges must not overlap.");
  if (!output.length || output.length > 32768 || bytes.length < 2 || bytes.length >= output.length) {
    invalid("WIM LZX chunk is outside the compressed 32 KiB profile.");
  }
  let steps = 0, blocks = 0;
  const step = (count: number): void => {
    if (count > 1048576 - steps) throw new ArchiveError("budget-exceeded", "WIM LZX kernel step ceiling exceeded.");
    charge(count);
    steps += count;
  };
  step(745);
  const mainLengths = new Uint8Array(496), lengthLengths = new Uint8Array(249);
  const recent = new Uint32Array([1, 1, 1]), bits = new Bits(bytes, step);
  let at = 0;
  while (at < output.length) {
    if (++blocks > 256) throw new ArchiveError("budget-exceeded", "WIM LZX kernel block ceiling exceeded.");
    block();
    const kind = bits.read(3), size = bits.read(1) ? 32768 : bits.read(16);
    if (!size || size > output.length - at) invalid("WIM LZX block exceeds remaining output.");
    if (kind === 3) {
      bits.align();
      const offsets = bits.raw(12), view = new DataView(offsets.buffer, offsets.byteOffset, 12);
      for (let i = 0; i < 3; i++) {
        recent[i] = view.getUint32(i * 4, true);
        if (!recent[i]) invalid("WIM LZX raw block declares a zero repeated offset.");
      }
      output.set(bits.raw(size), at);
      at += size;
      if ((size & 1) && bits.raw(1)[0] !== 0) invalid("WIM LZX odd raw block pad is not zero.");
      continue;
    }
    if (kind !== 1 && kind !== 2) invalid("WIM LZX block type is unsupported.");
    let aligned: TreeType | undefined;
    if (kind === 2) {
      const values = new Uint8Array(8);
      for (let i = 0; i < values.length; i++) values[i] = bits.read(3);
      aligned = tree(values, 7, step);
    }
    lengths(bits, mainLengths, 0, 256);
    lengths(bits, mainLengths, 256, 496);
    lengths(bits, lengthLengths, 0, 249);
    const main = tree(mainLengths, 16, step), lengthTree = tree(lengthLengths, 16, step);
    const end = at + size;
    while (at < end) {
      const value = symbol(bits, main);
      if (value < 256) {
        step(1);
        output[at++] = value;
        continue;
      }
      const slot = (value - 256) >>> 3;
      let length = value & 7;
      if (length === 7) length += symbol(bits, lengthTree);
      length += 2;
      let distance: number;
      if (slot < 3) {
        distance = recent[slot]!;
        recent[slot] = recent[0]!;
      } else {
        const extra = slot < 4 ? 0 : (slot >>> 1) - 1;
        const base = slot < 4 ? slot - 2 : (2 + (slot & 1)) * 2 ** extra - 2;
        distance = kind === 2 && slot >= 8
          ? bits.read(extra - 3) * 8 + symbol(bits, aligned!) + base
          : bits.read(extra) + base;
        recent[2] = recent[1]!;
        recent[1] = recent[0]!;
      }
      recent[0] = distance;
      if (!distance || distance > at || length > end - at) {
        invalid("WIM LZX match precedes this chunk or crosses its block.");
      }
      step(length);
      for (let i = 0; i < length; i++, at++) output[at] = output[at - distance]!;
    }
  }
  if (bits.position !== bytes.length || bits.value !== 0 || bits.count > 15) {
    invalid("WIM LZX selected writer profile requires exact zero-padded terminal extent.");
  }
  // WIM always reverses E8 using chunk-local positions and the fixed 12000000 size.
  // The final ten bytes cannot start a translated instruction; operands are skipped.
  const view = new DataView(output.buffer, output.byteOffset, output.length);
  at = 0;
  while (at < output.length - 10) {
    step(1);
    if (output[at] !== 0xe8) {
      at++;
      continue;
    }
    step(4);
    const absolute = view.getInt32(at + 1, true);
    if (absolute >= 0 && absolute < 12000000) view.setInt32(at + 1, absolute - at, true);
    else if (absolute < 0 && absolute >= -at) view.setInt32(at + 1, absolute + 12000000, true);
    at += 5;
  }
  step(0); // Preserve caller abort authority after the final filter mutation too.
}
