/** Authored LAS 1.2 manual controls checked byte-for-byte against frozen reciprocal evidence.
 * No laspy/NumPy or candidate parser is run. Historical native corpus stays unchanged. @module
 */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { parseArgs } from "node:util";
import { read, sha } from "../iso/native.ts";
import { writeFileSync } from "node:fs";
const { values } = parseArgs({ options: { output: { type: "string" } } });
ok(values.output, "Supply a new --output receipt path.");
type PackedType = { base64: string; sha256: string };
type CaseType = {
  producer: string;
  format: number;
  count: number;
  extra: boolean;
  file: PackedType;
  records: PackedType;
  subset: PackedType;
  columns: Record<string, PackedType>;
};
const frozenBytes = read(new URL("./independent.json", import.meta.url), 16 * 1024 * 1024),
  frozen: { fixtures: CaseType[] } = JSON.parse(frozenBytes.toString("utf8"));
equal(frozen.fixtures.length, 32);
function packed(bytes: Buffer): PackedType {
  return { base64: bytes.toString("base64"), sha256: sha(bytes) };
}
function equalPacked(bytes: Buffer, expected: PackedType): void {
  equal(sha(bytes), expected.sha256);
  deepStrictEqual(bytes, Buffer.from(expected.base64, "base64"));
}
/** Fixed columns are authored before any record is serialized or frozen file is compared. */
function columns(format: number, count: number): Map<string, { width: number; bytes: Buffer; values: number[] }> {
  const result = new Map<string, { width: number; bytes: Buffer; values: number[] }>();
  const add = (name: string, width: number, signed: boolean, value: (index: number) => number, float = false): void => {
    const bytes = Buffer.alloc(count * width), values = Array.from({ length: count }, (_, index) => value(index));
    for (const [index, item] of values.entries()) {
      if (float) bytes.writeDoubleLE(item, index * width);
      else if (signed) bytes.writeIntLE(item, index * width, width);
      else bytes.writeUIntLE(item, index * width, width);
    }
    result.set(name, { width, bytes, values });
  };
  add("X", 4, true, (i) => i === 0 ? -2147483648 : i * 37 - 500);
  add("Y", 4, true, (i) => i === count - 1 ? 2147483647 : i * -13 + 901);
  add("Z", 4, true, (i) => i % 100 - 50);
  add("intensity", 2, false, (i) => i * 1777 % 65536);
  add("return_number", 1, false, (i) => i % 5 + 1);
  add("number_of_returns", 1, false, () => 5);
  add("scan_direction_flag", 1, false, (i) => i % 2);
  add("edge_of_flight_line", 1, false, (i) => Number(i % 3 === 0));
  add("classification", 1, false, (i) => i % 32);
  add("synthetic", 1, false, (i) => i % 2);
  add("key_point", 1, false, (i) => Number(i % 3 === 0));
  add("withheld", 1, false, (i) => Number(i % 7 === 0));
  const angles = [-90, -1, 0, 1, 90];
  add("scan_angle_rank", 1, true, (i) => {
    const value = angles[i % 5];
    ok(value !== undefined);
    return value;
  });
  add("user_data", 1, false, (i) => i % 256);
  add("point_source_id", 2, false, (i) => i * 31 % 65536);
  if (format === 1 || format === 3) add("gps_time", 8, false, (i) => i * 0.5 + 123456, true);
  if (format === 2 || format === 3) {
    for (const [name, step] of [["red", 111], ["green", 222], ["blue", 333]] as const) {
      add(name, 2, false, (i) => i * step % 65536);
    }
  }
  for (
    const [name, source, scale, offset] of [["x", "X", 0.01, 1000], ["y", "Y", 0.125, -2000], [
      "z",
      "Z",
      2,
      42,
    ]] as const
  ) {
    const original = result.get(source);
    ok(original);
    add(name, 8, true, (i) => {
      const value = original.values[i];
      ok(value !== undefined);
      return value * scale + offset;
    }, true);
  }
  return result;
}
const fixtures: CaseType[] = [];
for (let format = 0; format < 4; format++) {
  for (const [count, extra] of [[0, false], [37, false], [37, true], [12000, false]] as const) {
    const matches = frozen.fixtures.filter((item) =>
      item.producer === "struct" && item.format === format && item.count === count && item.extra === extra
    );
    equal(matches.length, 1);
    const previous = matches[0];
    ok(previous);
    const original = columns(format, count), baseWidth = [20, 28, 26, 34][format];
    ok(baseWidth);
    const width = baseWidth + Number(extra), extension = extra ? Buffer.from("manual-opaque-header") : Buffer.alloc(0);
    const header = Buffer.alloc(227 + extension.length), vlr = Buffer.alloc(86);
    header.write("LASF");
    header.writeUInt16LE(format % 2, 6);
    header[24] = 1;
    header[25] = 2;
    header.write("OTHER", 26);
    header.write("OPFS fixture struct writer", 58);
    header.writeUInt16LE(header.length, 94);
    header.writeUInt32LE(header.length + vlr.length, 96);
    header.writeUInt32LE(1, 100);
    header[104] = format;
    header.writeUInt16LE(width, 105);
    header.writeUInt32LE(count, 107);
    const returns = original.get("return_number");
    ok(returns);
    for (let r = 0; r < 5; r++) {
      header.writeUInt32LE(
        returns.values.filter((value) => value === r + 1).length,
        111 + r * 4,
      );
    }
    for (
      const [axis, [name, scale, offset]] of ([["x", 0.01, 1000], ["y", 0.125, -2000], ["z", 2, 42]] as const).entries()
    ) {
      header.writeDoubleLE(scale, 131 + axis * 8);
      header.writeDoubleLE(offset, 155 + axis * 8);
      const values = original.get(name)?.values;
      ok(values);
      header.writeDoubleLE(count ? Math.max(...values) : 0, 179 + axis * 16);
      header.writeDoubleLE(count ? Math.min(...values) : 0, 187 + axis * 16);
    }
    extension.copy(header, 227);
    vlr.write("OPFS_test", 2);
    vlr.writeUInt16LE(65000, 18);
    vlr.writeUInt16LE(32, 20);
    vlr.write("inert authored bytes", 22);
    for (let index = 0; index < 32; index++) vlr[54 + index] = index;
    const records = Buffer.alloc(count * width),
      value = (name: string, i: number): number => {
        const result = original.get(name)?.values[i];
        ok(result !== undefined);
        return result;
      };
    for (let i = 0; i < count; i++) {
      const at = i * width;
      records.writeInt32LE(value("X", i), at);
      records.writeInt32LE(value("Y", i), at + 4);
      records.writeInt32LE(value("Z", i), at + 8);
      records.writeUInt16LE(value("intensity", i), at + 12);
      records[at + 14] = value("return_number", i) | value("number_of_returns", i) << 3 |
        value("scan_direction_flag", i) << 6 | value("edge_of_flight_line", i) << 7;
      records[at + 15] = value("classification", i) | value("synthetic", i) << 5 | value("key_point", i) << 6 |
        value("withheld", i) << 7;
      records.writeInt8(value("scan_angle_rank", i), at + 16);
      records[at + 17] = value("user_data", i);
      records.writeUInt16LE(value("point_source_id", i), at + 18);
      let tail = at + 20;
      if (format === 1 || format === 3) {
        records.writeDoubleLE(value("gps_time", i), tail);
        tail += 8;
      }
      if (format === 2 || format === 3) {
        for (const name of ["red", "green", "blue"]) {
          records.writeUInt16LE(value(name, i), tail);
          tail += 2;
        }
      }
      if (extra) records[tail] = i % 256;
    }
    const file = Buffer.concat([header, vlr, records]),
      begin = Math.min(3, count),
      end = Math.min(begin + 7, count),
      subset = records.subarray(begin * width, end * width);
    equalPacked(file, previous.file);
    equalPacked(records, previous.records);
    equalPacked(subset, previous.subset);
    deepStrictEqual([...original.keys()].sort(), Object.keys(previous.columns).sort());
    const fields: Record<string, PackedType> = {};
    for (const [name, column] of original) {
      const prior: PackedType | undefined = previous.columns[name];
      ok(prior);
      equalPacked(column.bytes, prior);
      fields[name] = packed(column.bytes);
    }
    fixtures.push({
      producer: "authored-ts-manual",
      format,
      count,
      extra,
      file: packed(file),
      records: packed(records),
      subset: packed(subset),
      columns: fields,
    });
  }
}
const receipt = JSON.stringify({
  runtime: process.version,
  evidenceProfile:
    "Authored LAS1.2 manual controls; all files/records/subsets/columns compared with frozen independently consumed struct-writer corpus; no new laspy execution",
  independentNativeRerun: false,
  frozenFixtureSha256: sha(frozenBytes),
  fixtures,
});
ok(Buffer.byteLength(receipt) <= 16 * 1024 * 1024, "LAS receipt exceeds its output bound.");
writeFileSync(values.output, receipt + "\n", { flag: "wx" });
