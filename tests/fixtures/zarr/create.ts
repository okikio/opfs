/** Authored Zarr v2 raw-chunk controls against frozen independent complete-byte oracles.
 * No Zarr/NumPy runtime or candidate parser is imported or executed. @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { read, sha } from "../iso/native.ts";
const { values } = parseArgs({ options: { output: { type: "string" } } });
ok(values.output, "Supply a new --output receipt path.");
type PackedType = { base64: string; sha256: string };
type CaseType = {
  producer: string;
  profile: string;
  dtype: string;
  order: "C" | "F";
  shape: number[];
  chunks: number[];
  objects: Record<string, PackedType>;
  original: PackedType;
};
const frozenBytes = read(new URL("./independent.json", import.meta.url), 4 * 1024 * 1024),
  frozen: { fixtures: CaseType[] } = JSON.parse(frozenBytes.toString("utf8"));
equal(frozen.fixtures.length, 82);
function packed(bytes: Buffer): PackedType {
  return { base64: bytes.toString("base64"), sha256: sha(bytes) };
}
function equalPacked(bytes: Buffer, expected: PackedType): void {
  equal(sha(bytes), expected.sha256);
  deepStrictEqual(bytes, Buffer.from(expected.base64, "base64"));
}
const types = [
  "|b1",
  "|i1",
  "|u1",
  ">i2",
  "<i2",
  ">u2",
  "<u2",
  ">i4",
  "<i4",
  ">u4",
  "<u4",
  ">i8",
  "<i8",
  ">u8",
  "<u8",
  ">f4",
  "<f4",
  ">f8",
  "<f8",
];
type NumberType = number | bigint;
/** Encode exact integers and canonical quiet NaNs without a JS Number conversion of 64-bit integers. */
function encode(items: readonly NumberType[], dtype: string, canonical = false): Buffer {
  const match = /^([|<>])([biuf])([1248])$/u.exec(dtype);
  ok(match);
  const order = match[1], kind = match[2], width = Number(match[3]);
  const little = canonical || order !== ">", bytes = Buffer.alloc(items.length * width);
  for (const [index, item] of items.entries()) {
    const at = index * width;
    if (kind === "b") {
      bytes[at] = Number(item !== 0 && item !== 0n);
      continue;
    }
    if (kind === "f") {
      ok(typeof item === "number");
      if (Number.isNaN(item)) {
        if (width === 4) {
          if (little) bytes.writeUInt32LE(0x7fc00000, at);
          else bytes.writeUInt32BE(0x7fc00000, at);
        } else {if (little) bytes.writeBigUInt64LE(0x7ff8000000000000n, at);
          else bytes.writeBigUInt64BE(0x7ff8000000000000n, at);}
      } else if (width === 4) {
        if (little) bytes.writeFloatLE(item, at);
        else bytes.writeFloatBE(item, at);
      } else {if (little) bytes.writeDoubleLE(item, at);
        else bytes.writeDoubleBE(item, at);}
      continue;
    }
    if (width === 8) {
      const value = BigInt(item);
      if (kind === "i") {
        if (little) bytes.writeBigInt64LE(value, at);
        else bytes.writeBigInt64BE(value, at);
      } else {if (little) bytes.writeBigUInt64LE(value, at);
        else bytes.writeBigUInt64BE(value, at);}
    } else {
      ok(typeof item === "number");
      if (kind === "i") {
        if (little) bytes.writeIntLE(item, at, width);
        else bytes.writeIntBE(item, at, width);
      } else {if (little) bytes.writeUIntLE(item, at, width);
        else bytes.writeUIntBE(item, at, width);}
    }
  }
  return bytes;
}
function size(shape: readonly number[]): number {
  return shape.reduce((total, value) => total * value, 1);
}
/** C and F order differ in physical local strides; logical originals stay row-major. */
function coordinates(linear: number, shape: readonly number[], order: "C" | "F"): number[] {
  const result = Array<number>(shape.length).fill(0), axes = Array.from({ length: shape.length }, (_, axis) => axis);
  if (order === "C") axes.reverse();
  for (const axis of axes) {
    const width = shape[axis];
    ok(width !== undefined && width > 0);
    result[axis] = linear % width;
    linear = Math.floor(linear / width);
  }
  return result;
}
function linear(coordinate: readonly number[], shape: readonly number[]): number {
  let result = 0;
  for (const [axis, at] of coordinate.entries()) {
    const width = shape[axis];
    ok(width !== undefined);
    result = result * width + at;
  }
  return result;
}

/** Author full physical chunks, including edge fill, before comparing saved native payloads. */
function store(
  items: readonly NumberType[],
  shape: readonly number[],
  chunks: readonly number[],
  dtype: string,
  order: "C" | "F",
  separator: "." | "/",
  fill: number,
): Record<string, Buffer> {
  ok(shape.length === chunks.length && shape.length <= 2 && size(shape) <= 512 * 257);
  const metadata = {
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: null,
    filters: [],
    fill_value: Number.isNaN(fill) ? "NaN" : fill,
    order,
    dimension_separator: separator,
  };
  const objects: Record<string, Buffer> = { ".zarray": Buffer.from(JSON.stringify(metadata)) },
    grid = shape.map((width, axis) => {
      const chunk = chunks[axis];
      ok(chunk !== undefined && chunk > 0);
      return Math.ceil(width / chunk);
    });
  for (let index = 0; index < size(grid); index++) {
    const coordinate = coordinates(index, grid, "C"), body: NumberType[] = [];
    for (let local = 0; local < size(chunks); local++) {
      const relative = coordinates(local, chunks, order),
        absolute = relative.map((offset, axis) => {
          const position = coordinate[axis], chunk = chunks[axis];
          ok(position !== undefined && chunk !== undefined);
          return position * chunk + offset;
        });
      if (absolute.some((at, axis) => at >= (shape[axis] ?? 0))) body.push(fill);
      else {
        const value = items[linear(absolute, shape)];
        ok(value !== undefined);
        body.push(value);
      }
    }
    objects[coordinate.length ? coordinate.join(separator) : "0"] = encode(body, dtype);
  }
  return objects;
}
const fixtures: (CaseType & { metadataComparison: string })[] = [];
/** Compare all original logical bytes and every stored data chunk, not a self-decoded roundtrip. */
function retain(
  profile: string,
  dtype: string,
  order: "C" | "F",
  shape: number[],
  chunks: number[],
  source: NumberType[],
  fill = 0,
  missing = false,
  noncanonical = false,
): void {
  const previous = frozen.fixtures.filter((item) =>
    item.profile === profile && item.dtype === dtype && item.order === order &&
    (profile !== "numeric" || item.producer === "manual")
  );
  equal(previous.length, 1);
  const old = previous[0];
  ok(old);
  deepStrictEqual(old.shape, shape);
  deepStrictEqual(old.chunks, chunks);
  const separator = order === "F" ? "/" : ".",
    objects = store(source, shape, chunks, dtype, order, separator, fill),
    original = [...source];
  if (missing) {
    delete objects["0.0"];
    for (let row = 0; row < 3; row++) for (let column = 0; column < 4; column++) original[row * 5 + column] = fill;
  }
  if (noncanonical) objects["0"] = Buffer.from([0, 2, 255, 1]);
  const canonical = encode(original, dtype, true);
  equalPacked(canonical, old.original);
  const keys = Object.keys(objects).filter((name) => !name.startsWith(".")).sort(),
    oldKeys = Object.keys(old.objects).filter((name) => !name.startsWith(".")).sort();
  deepStrictEqual(keys, oldKeys);
  const saved: Record<string, PackedType> = {};
  for (const [key, bytes] of Object.entries(objects)) {
    if (!key.startsWith(".")) {
      const expected: PackedType | undefined = old.objects[key];
      ok(expected);
      equalPacked(bytes, expected);
    }
    saved[key] = packed(bytes);
  }
  fixtures.push({
    producer: "authored-ts-manual",
    profile,
    dtype,
    order,
    shape,
    chunks,
    objects: saved,
    original: packed(canonical),
    metadataComparison:
      "Authored v2 metadata; full frozen original and data-chunk comparisons, not a new native metadata parse",
  });
}
for (const dtype of types) {
  for (const order of ["C", "F"] as const) {
    const kind = dtype[1],
      width = Number(dtype[2]),
      items: NumberType[] = Array.from({ length: 35 }, (_, index) => kind === "b" ? Number(index % 3 === 0) : index);
    if (kind === "i") items[0] = -1;
    if ((kind === "i" || kind === "u") && width === 8) items[34] = kind === "i" ? 2n ** 63n - 1n : 2n ** 64n - 1n;
    if (kind === "f") {
      items[0] = -0;
      items[1] = NaN;
      items[2] = Infinity;
      items[3] = -Infinity;
    }
    retain("numeric", dtype, order, [7, 5], [3, 4], items);
  }
}
for (
  const [profile, shape, chunks, fill] of [
    ["scalar", [], [], 0],
    ["empty", [0, 3], [2, 2], 0],
    ["missing", [7, 5], [3, 4], -7],
    ["missing-nan", [7, 5], [3, 4], NaN],
    ["large", [512, 257], [64, 64], 0],
  ] as const
) {
  retain(
    profile,
    "<f4",
    "C",
    [...shape],
    [...chunks],
    Array.from({ length: size(shape) }, (_, index) => index),
    fill,
    profile.startsWith("missing"),
  );
}
retain("boolean-noncanonical", "|b1", "C", [4], [4], [0, 1, 1, 1], 0, false, true);
const receipt = JSON.stringify({
  runtime: process.version,
  evidenceProfile:
    "Authored raw Zarr v2 controls compared with frozen reciprocal NumPy/Zarr original and physical data-chunk bytes; no new native Zarr execution",
  independentNativeRerun: false,
  canonicalByteorder: "little",
  frozenFixtureSha256: sha(frozenBytes),
  fixtures,
});
ok(Buffer.byteLength(receipt) <= 4 * 1024 * 1024, "Zarr receipt exceeds its output bound.");
writeFileSync(values.output, receipt + "\n", { flag: "wx" });
