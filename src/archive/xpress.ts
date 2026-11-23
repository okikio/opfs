/** Internal MS-XCA XPRESS-Huffman kernel for ordinary 32 KiB WIM chunks. @module */
import { isBytes, toView } from "../bytes.ts";
import { invalid } from "./record.ts";

/** The writer reserves two little-endian coding words ahead of interleaved length bytes. */
class Bits {
  position = 256;
  count = 0;
  value = 0;
  readonly bytes: Uint8Array;
  readonly charge: (count: number) => void;
  constructor(bytes: Uint8Array, charge: (count: number) => void) {
    this.bytes = bytes;
    this.charge = charge;
  }
  ensure(count: number): void {
    while (this.count < count) {
      if (this.position + 2 > this.bytes.length) invalid("WIM XPRESS coding word is truncated.");
      this.value = this.value * 65536 + this.bytes[this.position]! + this.bytes[this.position + 1]! * 256;
      this.count += 16;
      this.position += 2;
    }
  }
  take(count: number): number {
    if (count > this.count) invalid("WIM XPRESS coding bits are unavailable.");
    this.charge(count);
    this.count -= count;
    const divisor = 2 ** this.count;
    const value = Math.floor(this.value / divisor);
    this.value %= divisor;
    return value;
  }
  byte(): number {
    this.charge(8);
    if (this.position === this.bytes.length) invalid("WIM XPRESS match length is truncated.");
    return this.bytes[this.position++]!;
  }
}

/**
 * Decode into an already reserved output buffer. Neither input nor output is retained.
 *
 * This selected writer profile requires an end symbol, zero alignment and one zero
 * coding word. That is deliberately stricter than size-only native decoders. The
 * caller owns cumulative CPU admission and cancellation through charge; the local
 * ceiling also bounds malformed table work independently of caller policy.
 */
export function decodeXpress(input: Uint8Array, target: Uint8Array, charge: (count: number) => void): void {
  if (!isBytes(input) || !isBytes(target)) throw new TypeError("XPRESS requires native byte views.");
  const bytes = toView(input), output = toView(target);
  if (!output.length || output.length > 32768 || bytes.length < 260 || bytes.length >= output.length) {
    invalid("WIM XPRESS chunk is outside the compressed 32 KiB profile.");
  }
  let steps = 0;
  const step = (count: number): void => {
    if (count > 1048576 - steps) invalid("WIM XPRESS chunk exceeds the finite kernel work ceiling.");
    charge(count);
    steps += count;
  };
  step(512);
  // Flat canonical tables use at most 512 symbols, not 2^15 lookup entries.
  const counts = new Uint16Array(16), first = new Uint16Array(16), starts = new Uint16Array(16);
  const symbols = new Uint16Array(512), lengths = new Uint8Array(512);
  for (let symbol = 0; symbol < 512; symbol++) {
    const length = (bytes[symbol >>> 1]! >>> ((symbol & 1) * 4)) & 15;
    lengths[symbol] = length;
    if (length) counts[length] = counts[length]! + 1;
  }
  let remaining = 1, code = 0, total = 0;
  for (let width = 1; width <= 15; width++) {
    remaining = remaining * 2 - counts[width]!;
    if (remaining < 0) invalid("WIM XPRESS Huffman table is oversubscribed.");
    code = (code + counts[width - 1]!) * 2;
    first[width] = code;
    starts[width] = total;
    total += counts[width]!;
  }
  if (remaining !== 0) invalid("WIM XPRESS Huffman table is incomplete.");
  const slots = starts.slice();
  for (let symbol = 0; symbol < 512; symbol++) {
    const length = lengths[symbol]!;
    if (length) {
      symbols[slots[length]!] = symbol;
      slots[length] = slots[length]! + 1;
    }
  }
  const bits = new Bits(bytes, step);
  const symbol = (): number => {
    bits.ensure(16);
    let code = 0;
    for (let width = 1; width <= 15; width++) {
      code = code * 2 + bits.take(1);
      const index = code - first[width]!;
      if (index >= 0 && index < counts[width]!) return symbols[starts[width]! + index]!;
    }
    return invalid("WIM XPRESS Huffman symbol is invalid.");
  };
  bits.ensure(32);
  let at = 0;
  while (at < output.length) {
    const value = symbol();
    bits.ensure(16);
    if (value < 256) {
      step(1);
      output[at++] = value;
      continue;
    }
    let length = value & 15;
    const width = (value >>> 4) & 15;
    if (length === 15) {
      const extra = bits.byte();
      length += extra;
      if (extra === 255) {
        length = bits.byte() + bits.byte() * 256;
        if (length < 15) invalid("WIM XPRESS extended match length is invalid for this chunk profile.");
      }
    }
    length += 3;
    const distance = 2 ** width + bits.take(width);
    bits.ensure(16);
    if (distance > at || length > output.length - at) invalid("WIM XPRESS match exceeds available output.");
    step(length);
    // Overlapping matches intentionally read newly emitted bytes; copyWithin is incorrect here.
    for (let i = 0; i < length; i++, at++) output[at] = output[at - distance]!;
  }
  if (symbol() !== 256) invalid("WIM XPRESS selected profile requires a terminal symbol 256.");
  bits.ensure(16);
  if (bits.position !== bytes.length || bits.value !== 0 || bits.count < 16 || bits.count > 31) {
    invalid("WIM XPRESS selected profile requires exact zero-padded writer termination.");
  }
}
