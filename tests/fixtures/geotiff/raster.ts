/** Authored classic-TIFF fixture bytes and physical sample-bit checks, independent of the production reader. */
import { Buffer } from "node:buffer";
import { check, digest } from "../acquire.ts";
/** Fixed input geometry, scalar representation and writer ownership for one reproducible file. */
export interface ProfileType {
  readonly name: string;
  readonly kind: "u8" | "u16" | "i16" | "u32" | "i32" | "f32" | "f64";
  readonly tiled: boolean;
  readonly big: boolean;
  readonly channels: number;
  readonly overview?: boolean;
  readonly authored?: boolean;
}
/** Nine GDAL writer cases plus two explicitly authored replacement writer cases. */
export const profiles: readonly ProfileType[] = [
  { name: "u16-strips-le", kind: "u16", tiled: false, big: false, channels: 1 },
  { name: "u16-tiles-be", kind: "u16", tiled: true, big: true, channels: 1 },
  { name: "rgb-u8-tiles", kind: "u8", tiled: true, big: false, channels: 3 },
  { name: "i16-strips", kind: "i16", tiled: false, big: false, channels: 1 },
  { name: "u32-strips", kind: "u32", tiled: false, big: true, channels: 1 },
  { name: "i32-strips", kind: "i32", tiled: false, big: false, channels: 1 },
  { name: "f32-tiles", kind: "f32", tiled: true, big: false, channels: 1 },
  { name: "f64-strips-be", kind: "f64", tiled: false, big: true, channels: 1 },
  { name: "u16-main-chain-overview", kind: "u16", tiled: false, big: false, channels: 1, overview: true },
  { name: "authored-tiles", kind: "u16", tiled: true, big: true, channels: 1, authored: true },
  { name: "authored-strips", kind: "u16", tiled: false, big: true, channels: 1, authored: true },
];
/** Scalar byte width and TIFF sample-format identifier for the fixed authored sample profiles. */
export function layout(kind: ProfileType["kind"]): { bytes: number; format: number } {
  return {
    bytes: kind === "u8" ? 1 : kind.endsWith("16") ? 2 : kind.endsWith("32") ? 4 : 8,
    format: kind.startsWith("f") ? 3 : kind.startsWith("i") ? 2 : 1,
  };
}
/** Keep original floating-point bits, including a chosen NaN payload, separate from semantic JSON values. */
export function original(profile: ProfileType, page = 0): Buffer<ArrayBuffer> {
  const size = layout(profile.kind).bytes,
    count = (page ? 10 * 9 : 19 * 17) * profile.channels,
    output = Buffer.alloc(count * size);
  for (let i = 0; i < count; i++) {
    const value = profile.overview
      ? 77
      : profile.kind.startsWith("i")
      ? i - 200
      : profile.kind.startsWith("f")
      ? i / 4
      : i;
    const at = i * size;
    switch (profile.kind) {
      case "u8":
        output.writeUInt8(value & 255, at);
        break;
      case "u16":
        output.writeUInt16LE(value, at);
        break;
      case "i16":
        output.writeInt16LE(value, at);
        break;
      case "u32":
        output.writeUInt32LE(value, at);
        break;
      case "i32":
        output.writeInt32LE(value, at);
        break;
      case "f32":
        output.writeFloatLE(value, at);
        break;
      case "f64":
        output.writeDoubleLE(value, at);
        break;
    }
  }
  if (profile.kind === "f32") {
    [0x80000000, 0x7fc01234, 0x7f800000, 0xff800000].forEach((bits, i) => output.writeUInt32LE(bits, i * 4));
  }
  if (profile.kind === "f64") {
    [0x8000000000000000n, 0x7ff8000000001234n, 0x7ff0000000000000n, 0xfff0000000000000n].forEach((bits, i) =>
      output.writeBigUInt64LE(bits, i * 8)
    );
  }
  return output;
}
/** Preserve special floating-point distinctions in JSON without converting the retained bit oracle. */
export function values(raw: Buffer<ArrayBuffer>, kind: ProfileType["kind"]): readonly (number | string)[] {
  const size = layout(kind).bytes, output: (number | string)[] = [];
  for (let at = 0; at < raw.length; at += size) {
    const value = kind === "u8"
      ? raw.readUInt8(at)
      : kind === "u16"
      ? raw.readUInt16LE(at)
      : kind === "i16"
      ? raw.readInt16LE(at)
      : kind === "u32"
      ? raw.readUInt32LE(at)
      : kind === "i32"
      ? raw.readInt32LE(at)
      : kind === "f32"
      ? raw.readFloatLE(at)
      : raw.readDoubleLE(at);
    output.push(
      Number.isNaN(value)
        ? "nan"
        : value === Infinity
        ? "+infinity"
        : value === -Infinity
        ? "-infinity"
        : Object.is(value, -0)
        ? "-zero"
        : value,
    );
  }
  return output;
}
/** A receipt for exact bytes; it never re-encodes a floating-point NaN. */
export function blob(raw: Uint8Array): { bytes: number; sha256: string; base64: string } {
  return { bytes: raw.byteLength, sha256: digest(raw), base64: Buffer.from(raw).toString("base64") };
}
/** Normalize whole scalar words, including tile padding, without interpreting their floating-point values. */
export function little(raw: Buffer<ArrayBuffer>, size: number, big: boolean): Buffer<ArrayBuffer> {
  const output = Buffer.from(raw);
  check(output.length % size === 0, "Partial sample word.");
  if (big) { for (let at = 0; at < output.length; at += size) output.subarray(at, at + size).reverse(); }
  return output;
}
/** One physical TIFF tag, retaining the stored bytes separately from decoded metadata values. */
export interface FieldType {
  readonly type: number;
  readonly count: number;
  readonly offset: number;
  readonly raw: ReturnType<typeof blob>;
  readonly values: readonly number[] | null;
}
/** A complete stored block, including padded edge words; `little` changes byte order only. */
export interface BlockType {
  readonly offset: number;
  readonly length: number;
  readonly raw: ReturnType<typeof blob>;
  readonly little: Buffer<ArrayBuffer>;
}
/** One bounded main-chain IFD and its reconstructed logical raster, excluding tile padding. */
export interface PageType {
  readonly ifdOffset: number;
  readonly width: number;
  readonly height: number;
  readonly samples: number;
  readonly bits: number;
  readonly sampleFormat: number;
  readonly tiled: boolean;
  readonly blockWidth: number;
  readonly blockHeight: number;
  readonly fields: Readonly<Record<string, FieldType>>;
  readonly blocks: readonly BlockType[];
  readonly raster: Buffer<ArrayBuffer>;
  readonly big: boolean;
}
/** Inspect only bounded classic TIFF NONE/contiguous fixture files and reconstruct every logical sample word. */
export function physical(raw: Buffer<ArrayBuffer>): readonly PageType[] {
  check(raw.length >= 8 && raw.length <= 1024 * 1024, "Classic TIFF fixture extent.");
  const big = raw.subarray(0, 2).toString() === "MM";
  check(big || raw.subarray(0, 2).toString() === "II", "TIFF byte-order marker.");
  function u16(at: number): number {
    return big ? raw.readUInt16BE(at) : raw.readUInt16LE(at);
  }
  function u32(at: number): number {
    return big ? raw.readUInt32BE(at) : raw.readUInt32LE(at);
  }
  check(u16(2) === 42, "Classic TIFF version.");
  let next = u32(4);
  const pages: PageType[] = [], seen = new Set<number>(), units = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  while (next !== 0) {
    check(!seen.has(next) && pages.length < 16 && next + 2 <= raw.length, "IFD cycle/count/extent.");
    seen.add(next);
    const count = u16(next), fields: Record<string, FieldType> = {};
    check(count > 0 && count <= 1024 && next + 2 + count * 12 + 4 <= raw.length, "IFD field inventory/extent.");
    let previous = -1;
    for (let i = 0; i < count; i++) {
      const at = next + 2 + i * 12, tag = u16(at), type = u16(at + 2), n = u32(at + 4), unit = units[type];
      check(tag > previous && unit && n <= Math.floor(raw.length / unit), "Sorted unique TIFF tags and field extent.");
      previous = tag;
      const size = n * unit, offset = size <= 4 ? at + 8 : u32(at + 8);
      check(offset + size <= raw.length, "TIFF field payload extent.");
      const bytes = raw.subarray(offset, offset + size), decoded: number[] = [];
      if ([1, 3, 4, 8, 9, 11, 12].includes(type)) {
        for (let j = 0; j < n; j++) {
          const p = j * unit;
          decoded.push(
            type === 1
              ? bytes.readUInt8(p)
              : type === 3
              ? big ? bytes.readUInt16BE(p) : bytes.readUInt16LE(p)
              : type === 4
              ? big ? bytes.readUInt32BE(p) : bytes.readUInt32LE(p)
              : type === 8
              ? big ? bytes.readInt16BE(p) : bytes.readInt16LE(p)
              : type === 9
              ? big ? bytes.readInt32BE(p) : bytes.readInt32LE(p)
              : type === 11
              ? big ? bytes.readFloatBE(p) : bytes.readFloatLE(p)
              : big
              ? bytes.readDoubleBE(p)
              : bytes.readDoubleLE(p),
          );
        }
      }
      fields[String(tag)] = {
        type,
        count: n,
        offset,
        raw: blob(bytes),
        values: [1, 3, 4, 8, 9, 11, 12].includes(type) ? decoded : null,
      };
    }
    const one = function (tag: number, fallback?: number): number {
      const value = fields[String(tag)]?.values?.[0] ?? fallback;
      check(value !== undefined, "Required TIFF scalar tag.");
      return value;
    };
    const width = one(256),
      height = one(257),
      samples = one(277, 1),
      bits = one(258),
      format = one(339, 1),
      tiled = Boolean(fields[324]);
    check(
      one(259, 1) === 1 && one(284, 1) === 1 && width > 0 && width <= 256 && height > 0 && height <= 256 &&
        samples > 0 && samples <= 4 && [8, 16, 32, 64].includes(bits),
      "Fixture NONE contiguous raster profile.",
    );
    const size = bits / 8,
      bw = tiled ? one(322) : width,
      bh = tiled ? one(323) : one(278, height),
      across = Math.ceil(width / bw);
    check(bw > 0 && bh > 0 && bw <= 256 && bh <= 256, "Fixture block geometry.");
    const offsets = fields[tiled ? "324" : "273"]?.values, lengths = fields[tiled ? "325" : "279"]?.values;
    check(
      offsets && lengths && offsets.length === lengths.length && offsets.length === across * Math.ceil(height / bh),
      "Exact physical block inventory.",
    );
    const raster = Buffer.alloc(width * height * samples * size), blocks: BlockType[] = [];
    offsets.forEach((offset, i) => {
      const length = lengths[i]!,
        x = (i % across) * bw,
        y = Math.floor(i / across) * bh,
        rows = tiled ? bh : Math.min(bh, height - y);
      check(offset + length <= raw.length && length === rows * bw * samples * size, "Raw block full extent.");
      const bytes = raw.subarray(offset, offset + length), normalized = little(bytes, size, big);
      for (let row = 0; row < Math.min(rows, height - y); row++) {
        normalized.copy(
          raster,
          ((y + row) * width + x) * samples * size,
          row * bw * samples * size,
          (row * bw + Math.min(bw, width - x)) * samples * size,
        );
      }
      blocks.push({ offset, length, raw: blob(bytes), little: normalized });
    });
    pages.push({
      ifdOffset: next,
      width,
      height,
      samples,
      bits,
      sampleFormat: format,
      tiled,
      blockWidth: bw,
      blockHeight: bh,
      fields,
      blocks,
      raster,
      big,
    });
    next = u32(next + 2 + count * 12);
  }
  return pages;
}
/** Small independent authored writer for the two unresolved-GeoKey cases, replacing the historical tifffile author. */
export function authored(tiled: boolean): Buffer<ArrayBuffer> {
  const profile = profiles.find((value) => value.authored && value.tiled === tiled)!;
  const source = original(profile),
    bw = tiled ? 16 : 19,
    bh = tiled ? 16 : 2,
    across = Math.ceil(19 / bw),
    blocks: Buffer<ArrayBuffer>[] = [];
  for (let y = 0; y < 17; y += bh) {
    for (let x = 0; x < 19; x += bw) {
      const rows = tiled ? bh : Math.min(bh, 17 - y), block = Buffer.alloc(rows * bw * 2);
      for (let row = 0; row < Math.min(rows, 17 - y); row++) {
        for (let col = 0; col < Math.min(bw, 19 - x); col++) {
          block.writeUInt16BE(source.readUInt16LE(((y + row) * 19 + x + col) * 2), (row * bw + col) * 2);
        }
      }
      blocks.push(block);
    }
  }
  check(blocks.length === across * Math.ceil(17 / bh), "Authored block inventory.");
  const offsets = blocks.map(() => 0), lengths = blocks.map((block) => block.length);
  const entries: { tag: number; type: number; values: number[]; offset?: number }[] = [
    { tag: 256, type: 4, values: [19] },
    { tag: 257, type: 4, values: [17] },
    { tag: 258, type: 3, values: [16] },
    { tag: 259, type: 3, values: [1] },
    { tag: 262, type: 3, values: [1] },
    { tag: 277, type: 3, values: [1] },
    { tag: 284, type: 3, values: [1] },
    { tag: 339, type: 3, values: [1] },
    { tag: tiled ? 324 : 273, type: 4, values: offsets },
    { tag: tiled ? 325 : 279, type: 4, values: lengths },
    { tag: 33550, type: 12, values: [0.5, 0.5, 0] },
    { tag: 33922, type: 12, values: [0, 0, 0, 100, 50, 0] },
    { tag: 34735, type: 3, values: [1, 1, 1, 3, 1024, 0, 1, 1, 1025, 0, 1, 1, 3072, 0, 1, 32767] },
    ...(tiled
      ? [{ tag: 322, type: 4, values: [bw] }, { tag: 323, type: 4, values: [bh] }]
      : [{ tag: 278, type: 4, values: [bh] }]),
  ].sort((a, b) => a.tag - b.tag);
  let at = 8 + 2 + entries.length * 12 + 4;
  for (const entry of entries) {
    const size = entry.values.length * (entry.type === 3 ? 2 : entry.type === 4 ? 4 : 8);
    if (size > 4) {
      entry.offset = at;
      at += size;
    }
  }
  blocks.forEach((block, i) => {
    offsets[i] = at;
    at += block.length;
  });
  const output = Buffer.alloc(at);
  output.write("MM");
  output.writeUInt16BE(42, 2);
  output.writeUInt32BE(8, 4);
  output.writeUInt16BE(entries.length, 8);
  entries.forEach((entry, i) => {
    const p = 10 + i * 12;
    output.writeUInt16BE(entry.tag, p);
    output.writeUInt16BE(entry.type, p + 2);
    output.writeUInt32BE(entry.values.length, p + 4);
    if (entry.offset !== undefined) output.writeUInt32BE(entry.offset, p + 8);
    entry.values.forEach((value, j) => {
      const unit = entry.type === 3 ? 2 : entry.type === 4 ? 4 : 8, target = (entry.offset ?? p + 8) + j * unit;
      if (entry.type === 3) output.writeUInt16BE(value, target);
      else if (entry.type === 4) output.writeUInt32BE(value, target);
      else output.writeDoubleBE(value, target);
    });
  });
  blocks.forEach((block, i) => block.copy(output, offsets[i]));
  return output;
}
