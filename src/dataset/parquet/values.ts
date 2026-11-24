/**
 * Decodes Parquet definition levels and plain-encoded values.
 *
 * @module
 */
import { Compact, Meter } from "./compact.ts";
import type { ParquetValuesType } from "./types.ts";
import { invalid, unsupported } from "../../archive/error.ts";

/** Decode one-bit definition levels without allocating a page-sized mask.
 *
 * Bit-packed runs round their final group to eight entries. Only the final
 * run may contain up to seven ignored slots; their unused bits are not data.
 */
export function levels(
  bytes: Uint8Array,
  count: number,
  visit: (row: number, valid: boolean) => void,
  meter: Meter,
): number {
  const cursor = new Compact(bytes, meter);
  let row = 0, present = 0;
  while (row < count) {
    meter.step();
    const header = Number(cursor.uint());
    if (header < 2) throw invalid("Parquet definition run is empty.");
    const packed = (header & 1) !== 0;
    const length = packed ? (header >>> 1) * 8 : header >>> 1;
    if (length > 0x7fffffff) throw invalid("Parquet definition run exceeds signed int32.");
    if (length > count - row && (!packed || length - (count - row) > 7)) {
      throw invalid("Parquet definition run exceeds page values.");
    }
    if (packed) {
      const payload = cursor.take(length / 8);
      const end = Math.min(length, count - row);
      for (let i = 0; i < end; i++) {
        meter.step();
        const valid = (payload[i >>> 3]! & (1 << (i & 7))) !== 0;
        visit(row++, valid);
        if (valid) present++;
      }
    } else {
      const value = cursor.byte();
      if (value > 1) throw invalid("Parquet definition level exceeds flat optional depth.");
      for (let i = 0; i < length; i++) {
        meter.step();
        visit(row++, value === 1);
      }
      if (value === 1) present += length;
    }
  }
  if (cursor.at !== bytes.length) throw invalid("Parquet definition levels contain trailing runs.");
  return present;
}

/** Return the physical output width; BOOLEAN's packed input still produces one byte per row. */
export function width(physical: number): number {
  return physical === 0 ? 1 : physical === 1 || physical === 4 ? 4 : physical === 2 || physical === 5 ? 8 : 0;
}

export function values(physical: number, count: number): ParquetValuesType {
  if (physical === 0) return new Uint8Array(count);
  if (physical === 1) return new Int32Array(count);
  if (physical === 2) return new BigInt64Array(count);
  if (physical === 4) return new Float32Array(count);
  if (physical === 5) return new Float64Array(count);
  throw unsupported("Parquet physical type is outside the numeric profile.");
}
