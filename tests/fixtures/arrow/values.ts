/** Authored originals remain independent of Arrow, DuckDB and the candidate readers. */
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { read, sha } from "./files.ts";

export const WIDTHS = { b: 1, y: 1, s: 2, i: 4, q: 8, f: 4, d: 8 } as const;
export type KeyType = keyof typeof WIDTHS;
export type ValueType = boolean | number | bigint | null;
export const SEEDS: Readonly<Record<KeyType, readonly ValueType[]>> = {
  b: [false, true, true, false],
  y: [-128, -1, 0, 127],
  s: [-32768, -1, 0, 32767],
  i: [-2147483648, -1, 0, 2147483647],
  q: [-9223372036854775808n, -9007199254740993n, 0n, 9223372036854775807n],
  f: [-0, Infinity, NaN, -3.5],
  d: [-0, -Infinity, NaN, 1.25],
};
export interface ColumnType {
  readonly key: KeyType;
  readonly values: readonly ValueType[];
  readonly physical: Buffer;
  readonly validity: Buffer;
}
export function column(key: KeyType, values: readonly ValueType[]): ColumnType {
  const physical = Buffer.alloc(values.length * WIDTHS[key]), validity = Buffer.alloc(values.length);
  values.forEach((value, index) => {
    if (value === null) return;
    validity[index] = 1;
    const at = index * WIDTHS[key];
    switch (key) {
      case "b":
        physical.writeUInt8(value ? 1 : 0, at);
        break;
      case "y":
        physical.writeInt8(value as number, at);
        break;
      case "s":
        physical.writeInt16LE(value as number, at);
        break;
      case "i":
        physical.writeInt32LE(value as number, at);
        break;
      case "q":
        physical.writeBigInt64LE(value as bigint, at);
        break;
      case "f":
        physical.writeFloatLE(value as number, at);
        break;
      case "d":
        physical.writeDoubleLE(value as number, at);
        break;
    }
  });
  return { key, values, physical, validity };
}
export function originals(keys: readonly KeyType[], rows: number, missing: (row: number) => boolean): ColumnType[] {
  return keys.map((key) =>
    column(key, Array.from({ length: rows }, (_, index) => missing(index) ? null : SEEDS[key][index % 4]!))
  );
}
export function save(folder: string, columns: readonly ColumnType[]): void {
  for (const item of columns) {
    writeFileSync(join(folder, `${item.key}.bin`), item.physical, { flag: "wx" });
    writeFileSync(join(folder, `${item.key}.validity`), item.validity, { flag: "wx" });
  }
}
/** Null masks and integers are byte-exact; floating NaN payload bits are deliberately not a contract. */
export function compare(folder: string, columns: readonly ColumnType[]): void {
  for (const item of columns) {
    deepStrictEqual(read(join(folder, `${item.key}.validity`)), item.validity);
    const physical = read(join(folder, `${item.key}.bin`));
    equal(physical.length, item.physical.length);
    if (item.key !== "f" && item.key !== "d") deepStrictEqual(physical, item.physical);
    else {item.values.forEach((value, index) => {
        const actual = item.key === "f" ? physical.readFloatLE(index * 4) : physical.readDoubleLE(index * 8);
        const expected = value === null ? 0 : value;
        ok(typeof expected === "number");
        ok(
          Number.isNaN(expected) ? Number.isNaN(actual) : Object.is(actual, expected),
          "Native float value or signed zero differs from the original.",
        );
      });}
  }
}
export function blob(body: Buffer): { bytes: number; sha256: string; base64: string } {
  return { bytes: body.length, sha256: sha(body), base64: body.toString("base64") };
}
export function retained(columns: readonly ColumnType[]): unknown[] {
  return columns.map(({ key, physical, validity }) => ({
    name: key,
    physicalLittleEndian: blob(physical),
    validity: blob(validity),
  }));
}
export function text(value: ValueType): string {
  if (value === null) return "null";
  if (typeof value !== "number") return String(value);
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  return Object.is(value, -0) ? "-0" : String(value);
}
