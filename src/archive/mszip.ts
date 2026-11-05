/** Internal bounded RFC 1951 decoder for CAB MSZIP blocks. No host codec or dictionary globals. @module */
import { invalid } from "./record.ts";

/** Bit positions refer to the original packed block, so final-byte consumption is exact. */
class Bits {
  position = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  read(count: number): number {
    if (count > this.bytes.length * 8 - this.position) invalid("MSZIP DEFLATE bits are truncated.");
    let value = 0;
    for (let bit = 0; bit < count; bit++, this.position++) {
      value |= ((this.bytes[this.position >>> 3]! >>> (this.position & 7)) & 1) << bit;
    }
    return value;
  }
  align(): void {
    this.position = Math.ceil(this.position / 8) * 8;
  }
}

interface TreeType {
  readonly codes: ReadonlyMap<number, number>;
  readonly width: number;
}

/** Canonical trees use <= 288 symbols; incomplete trees are legal only for one length/distance symbol. */
function tree(lengths: readonly number[], alphabet: "codes" | "literal" | "distance"): TreeType {
  const counts = new Uint16Array(16);
  let width = 0;
  for (const length of lengths) {
    if (length < 0 || length > 15) invalid("MSZIP Huffman length is invalid.");
    if (length) {
      counts[length] = counts[length]! + 1;
      width = Math.max(width, length);
    }
  }
  if (width === 0) {
    if (alphabet !== "distance") invalid("MSZIP Huffman tree is empty.");
    return { codes: new Map(), width: 0 };
  }
  let left = 1;
  for (let length = 1; length <= 15; length++) {
    left = left * 2 - counts[length]!;
    if (left < 0) invalid("MSZIP Huffman tree is oversubscribed.");
  }
  if (left !== 0 && (alphabet === "codes" || width !== 1)) invalid("MSZIP Huffman tree is incomplete.");
  const next = new Uint16Array(16);
  let code = 0;
  for (let length = 1; length <= 15; length++) {
    code = (code + counts[length - 1]!) * 2;
    next[length] = code;
  }
  const codes = new Map<number, number>();
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]!;
    if (length) {
      codes.set(2 ** length + next[length]!, symbol);
      next[length] = next[length]! + 1;
    }
  }
  return { codes, width };
}

/** Huffman bits arrive most-significant-code-bit first despite integer fields being little-endian bits. */
function symbol(bits: Bits, tree: TreeType): number {
  let code = 0;
  for (let length = 1; length <= tree.width; length++) {
    code = code * 2 + bits.read(1);
    const value = tree.codes.get(2 ** length + code);
    if (value !== undefined) return value;
  }
  return invalid("MSZIP Huffman code is absent from its tree.");
}

/** Repeat codes span both alphabets, but cannot invent a previous length or exceed their combined extent. */
function dynamic(bits: Bits): readonly [TreeType, TreeType] {
  const literalCount = bits.read(5) + 257;
  const distanceCount = bits.read(5) + 1;
  const codeCount = bits.read(4) + 4;
  if (literalCount > 286) invalid("MSZIP dynamic literal alphabet exceeds RFC 1951.");
  const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  const codes = Array<number>(19).fill(0);
  for (let i = 0; i < codeCount; i++) codes[order[i]!] = bits.read(3);
  const codeTree = tree(codes, "codes");
  const lengths: number[] = [];
  const count = literalCount + distanceCount;
  while (lengths.length < count) {
    const value = symbol(bits, codeTree);
    if (value < 16) {
      lengths.push(value);
      continue;
    }
    if (value === 16 && lengths.length === 0) invalid("MSZIP repeat has no preceding code length.");
    const repeat = bits.read(value === 16 ? 2 : value === 17 ? 3 : 7) + (value === 18 ? 11 : 3);
    if (repeat > count - lengths.length) invalid("MSZIP code-length repeat exceeds its alphabets.");
    const repeated = value === 16 ? lengths[lengths.length - 1]! : 0;
    for (let i = 0; i < repeat; i++) lengths.push(repeated);
  }
  if (lengths[256] === 0) invalid("MSZIP literal tree has no end-of-block code.");
  return [tree(lengths.slice(0, literalCount), "literal"), tree(lengths.slice(literalCount), "distance")];
}

/** Decode one complete CK-prefixed unit, borrowing prior folder history and returning only new bytes.
 * The caller reserves source/decoded/output work before this bounded allocation. No partial output escapes errors.
 */
export function readMszip(
  packed: Uint8Array,
  size: number,
  history: Uint8Array,
  signal?: AbortSignal,
  admitBlock?: () => void,
): Uint8Array {
  signal?.throwIfAborted();
  if (packed.length < 3 || packed.length > 32780 || packed[0] !== 0x43 || packed[1] !== 0x4b) {
    invalid("MSZIP block requires CK and at most 32780 packed bytes.");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > 32768 || history.length > 32768) {
    invalid("MSZIP decoded block/history exceeds 32 KiB.");
  }
  const bits = new Bits(packed.subarray(2));
  const output = new Uint8Array(size);
  let at = 0;
  let final = 0;
  // Fixed tables are local to this operation, not an eager import-time registry.
  let fixed: readonly [TreeType, TreeType] | undefined;
  const lengths = [
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    11,
    13,
    15,
    17,
    19,
    23,
    27,
    31,
    35,
    43,
    51,
    59,
    67,
    83,
    99,
    115,
    131,
    163,
    195,
    227,
    258,
  ];
  const lengthBits = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  const distances = [
    1,
    2,
    3,
    4,
    5,
    7,
    9,
    13,
    17,
    25,
    33,
    49,
    65,
    97,
    129,
    193,
    257,
    385,
    513,
    769,
    1025,
    1537,
    2049,
    3073,
    4097,
    6145,
    8193,
    12289,
    16385,
    24577,
  ];
  do {
    signal?.throwIfAborted();
    // The CAB operation owns one cumulative CPU policy across all prerequisite CFDATA units.
    // Admission precedes even empty blocks and dynamic table construction.
    admitBlock?.();
    final = bits.read(1);
    const kind = bits.read(2);
    if (kind === 3) invalid("MSZIP reserved DEFLATE block type.");
    if (kind === 0) {
      bits.align();
      const count = bits.read(16);
      if ((count ^ bits.read(16)) !== 65535) invalid("MSZIP stored-block length complement failed.");
      if (count > size - at) invalid("MSZIP block exceeds declared decoded size.");
      for (let i = 0; i < count; i++) output[at++] = bits.read(8);
      continue;
    }
    if (kind === 1 && !fixed) {
      fixed = [
        tree(Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8), "literal"),
        tree(Array<number>(32).fill(5), "distance"),
      ];
    }
    const [literalTree, distanceTree] = kind === 1 ? fixed! : dynamic(bits);
    while (true) {
      const value = symbol(bits, literalTree);
      if (value === 256) break;
      if (value < 256) {
        if (at === size) invalid("MSZIP literal exceeds declared decoded size.");
        output[at++] = value;
      } else {
        if (value > 285) invalid("MSZIP reserved length symbol.");
        const index = value - 257;
        const count = lengths[index]! + bits.read(lengthBits[index]!);
        const distanceCode = symbol(bits, distanceTree);
        if (distanceCode > 29) invalid("MSZIP reserved distance symbol.");
        const distance = distances[distanceCode]! + bits.read(distanceCode < 4 ? 0 : (distanceCode >>> 1) - 1);
        if (distance > history.length + at) invalid("MSZIP match precedes available folder history.");
        if (count > size - at) invalid("MSZIP match exceeds declared decoded size.");
        for (let i = 0; i < count; i++, at++) {
          const from = at - distance;
          output[at] = from < 0 ? history[history.length + from]! : output[from]!;
        }
      }
    }
  } while (!final);
  if (at !== size || Math.ceil(bits.position / 8) !== bits.bytes.length) {
    invalid("MSZIP decoded size or final packed extent does not match CFDATA.");
  }
  signal?.throwIfAborted();
  return output;
}
