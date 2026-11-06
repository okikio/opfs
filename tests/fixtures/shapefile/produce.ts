/** Authored 2D Shapefile/DBF controls compared with frozen PyShp bytes; no native SDK execution. @module */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { read, sha } from "../iso/native.ts";
type ShapeType = { xy: number[][]; parts: number[] };
type PackedType = { data: string; bytes: number; sha256: string };
type FixtureType = {
  name: string;
  shapeType: number;
  originals: ShapeType[];
  attributes: { label: string; integer: string; flag: boolean | null }[];
  components: Record<string, PackedType>;
  authoredDeletion: { data: string; sha256: string } | null;
};
const { values } = parseArgs({ options: { output: { type: "string" } } });
ok(values.output, "Supply a fresh --output receipt path.");
const frozenBytes = read(new URL("./independent.json", import.meta.url), 1024 * 1024),
  frozen: { fixtures: FixtureType[] } = JSON.parse(frozenBytes.toString("utf8"));
equal(frozen.fixtures.length, 5);
const shapes: [string, number, ShapeType[]][] = [
  ["point", 1, [{ xy: [[-0, 3.25]], parts: [] }, { xy: [[-7.5, -2]], parts: [] }, { xy: [], parts: [] }]],
  ["polyline", 3, [{ xy: [[0, 0], [2, 2], [3, -1], [4, 0], [5, 1]], parts: [0, 2] }, {
    xy: [[-5, 1], [-2, 2]],
    parts: [0],
  }, { xy: [], parts: [] }]],
  ["polygon", 5, [
    { xy: [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0], [2, 2], [8, 2], [8, 8], [2, 8], [2, 2]], parts: [0, 5] },
    { xy: [[-5, 0], [-4, 1], [-3, 0], [-5, 0]], parts: [0] },
    { xy: [], parts: [] },
  ]],
  ["multipoint", 8, [{ xy: [[1, 2], [-3, 4], [5, -6]], parts: [] }, { xy: [[0, 0]], parts: [] }, {
    xy: [],
    parts: [],
  }]],
  ["empty", 1, []],
];
const rows = [{ label: "e\u0301\ufeffnative", integer: "9007199254740993", flag: true }, {
  label: "second",
  integer: "-123",
  flag: false,
}, { label: "null row", integer: "0", flag: null }];
/** Coordinate extrema retain IEEE-754 negative zero; zero padding belongs only to empty bounds. */
function bounds(points: number[][]): Buffer {
  const result = Buffer.alloc(32);
  if (points.length) {
    for (let axis = 0; axis < 2; axis++) {
      const column = points.map((xy) => {
        const value = xy[axis];
        ok(value !== undefined);
        return value;
      });
      result.writeDoubleLE(Math.min(...column), axis * 8);
      result.writeDoubleLE(Math.max(...column), 16 + axis * 8);
    }
  }
  return result;
}
/** The historical DBF date is fixed, so a new run does not depend on its wall clock. */
function dbf(count: number): Buffer {
  const result = Buffer.alloc(129 + count * 66);
  result.set([3, 126, 11, 5]);
  result.writeUInt32LE(count, 4);
  result.writeUInt16LE(129, 8);
  result.writeUInt16LE(66, 10);
  for (
    const [index, [name, type, width]] of ([["label", "C", 40], ["exact", "N", 24], ["flag", "L", 1]] as const)
      .entries()
  ) {
    const at = 32 + index * 32;
    result.write(name, at);
    result.write(type, at + 11);
    result[at + 16] = width;
  }
  result[128] = 13;
  for (let i = 0; i < count; i++) {
    const row = rows[i];
    ok(row);
    const at = 129 + i * 66;
    result.fill(32, at, at + 66);
    Buffer.from(row.label).copy(result, at + 1);
    result.write(BigInt(row.integer).toString().padStart(24, " "), at + 41);
    result[at + 65] = row.flag === null ? 32 : row.flag ? 84 : 70;
  }
  return result;
}
function packed(bytes: Buffer): PackedType {
  return { data: bytes.toString("base64"), bytes: bytes.length, sha256: sha(bytes) };
}
const fixtures: {
  name: string;
  shapeType: number;
  components: Record<string, PackedType>;
  deletion: PackedType | null;
}[] = [];
for (const [name, type, originals] of shapes) {
  const previous = frozen.fixtures.find((item) => item.name === name);
  ok(previous);
  equal(previous.shapeType, type);
  // JSON serialization normalizes signed zero on both human-readable views.
  // Complete component comparisons below still require the original IEEE-754 sign bit.
  equal(JSON.stringify(originals), JSON.stringify(previous.originals));
  deepStrictEqual(rows.slice(0, originals.length), previous.attributes);
  const records: Buffer[] = [], index = Buffer.alloc(100 + originals.length * 8);
  let offset = 100;
  for (const [ordinal, shape] of originals.entries()) {
    const length = shape.xy.length === 0
      ? 4
      : type === 1
      ? 20
      : (type === 8 ? 40 : 44 + shape.parts.length * 4) + shape.xy.length * 16;
    const body = Buffer.alloc(length);
    body.writeInt32LE(shape.xy.length ? type : 0);
    if (shape.xy.length) {
      let at = 4;
      if (type !== 1) {
        bounds(shape.xy).copy(body, 4);
        if (type === 8) {
          body.writeInt32LE(shape.xy.length, 36);
          at = 40;
        } else {
          body.writeInt32LE(shape.parts.length, 36);
          body.writeInt32LE(shape.xy.length, 40);
          shape.parts.forEach((part, i) => body.writeInt32LE(part, 44 + i * 4));
          at = 44 + shape.parts.length * 4;
        }
      }
      for (const xy of shape.xy) {
        for (const value of xy) {
          body.writeDoubleLE(value, at);
          at += 8;
        }
      }
      equal(at, length);
    }
    const header = Buffer.alloc(8);
    header.writeInt32BE(ordinal + 1);
    header.writeInt32BE(length / 2, 4);
    records.push(header, body);
    index.writeInt32BE(offset / 2, 100 + ordinal * 8);
    index.writeInt32BE(length / 2, 104 + ordinal * 8);
    offset += 8 + length;
  }
  const geometry = Buffer.concat([Buffer.alloc(100), ...records]);
  for (const bytes of [geometry, index]) {
    bytes.writeInt32BE(9994);
    bytes.writeInt32BE(bytes.length / 2, 24);
    bytes.writeInt32LE(1000, 28);
    bytes.writeInt32LE(type, 32);
    bounds(originals.flatMap((shape) => shape.xy)).copy(bytes, 36);
  }
  const attributes = dbf(originals.length), components: Record<string, PackedType> = {};
  for (const [key, bytes] of [["shp", geometry], ["shx", index], ["dbf", attributes]] as const) {
    const prior: PackedType | undefined = previous.components[key];
    ok(prior);
    equal(bytes.length, prior.bytes);
    equal(sha(bytes), prior.sha256);
    deepStrictEqual(bytes, Buffer.from(prior.data, "base64"));
    components[key] = packed(bytes);
  }
  let deletion: PackedType | null = null;
  if (originals.length) {
    const bytes = Buffer.from(attributes);
    bytes[129 + 66] = 42;
    ok(previous.authoredDeletion);
    deepStrictEqual(bytes, Buffer.from(previous.authoredDeletion.data, "base64"));
    equal(sha(bytes), previous.authoredDeletion.sha256);
    deletion = packed(bytes);
  } else equal(previous.authoredDeletion, null);
  fixtures.push({ name, shapeType: type, components, deletion });
}
const receipt = JSON.stringify({
  evidenceProfile:
    "Authored component serialization compared with complete frozen PyShp output; no new native writer/reader execution",
  independentNativeRerun: false,
  runtime: process.version,
  frozenFixtureSha256: sha(frozenBytes),
  fixtures,
});
ok(Buffer.byteLength(receipt) < 1024 * 1024);
writeFileSync(values.output, receipt + "\n", { flag: "wx" });
