/** Candidate-independent bounded integers and field framing for the literal fixture, not the public Kafka client. */
import { Buffer } from "node:buffer";
import { lstatSync, readFileSync } from "node:fs";
import { check } from "../acquire.ts";
export const CAP = 4 * 1024 * 1024;
/** Read original regular files only, bounding allocation and refusing a changed extent. */
export function read(path: string): Buffer<ArrayBuffer> {
  const stat = lstatSync(path);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= CAP + 4, "Original output type/extent.");
  const raw = readFileSync(path);
  check(raw.length === stat.size, "Original output changed extent.");
  return raw;
}
/** A cursor owns no resources; every slice is admitted before its position changes. */
export class Reader {
  readonly data: Buffer<ArrayBuffer>;
  at = 0;
  constructor(data: Buffer<ArrayBuffer>) {
    check(data.length <= CAP + 4, "Native reader byte ceiling.");
    this.data = data;
  }
  take(count: number): Buffer<ArrayBuffer> {
    check(Number.isSafeInteger(count) && count >= 0 && count <= this.data.length - this.at, "Truncated native field.");
    const result = this.data.subarray(this.at, this.at + count);
    this.at += count;
    return result;
  }
  byte(): number {
    return this.take(1).readUInt8();
  }
  short(): number {
    return this.take(2).readInt16BE();
  }
  int(): number {
    return this.take(4).readInt32BE();
  }
  uint(): number {
    return this.take(4).readUInt32BE();
  }
  long(): bigint {
    return this.take(8).readBigInt64BE();
  }
  boolean(): boolean {
    const value = this.byte();
    check(value === 0 || value === 1, "Native boolean.");
    return value === 1;
  }
  count(limit = 1024): number {
    const value = this.int();
    check(value >= 0 && value <= limit, "Native count.");
    return value;
  }
  text(maximum = 249, wide = false): string {
    const size = wide ? this.int() : this.short();
    check(size >= 0 && size <= maximum, "Native text extent.");
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(size));
  }
  blob(maximum: number): Buffer<ArrayBuffer> | null {
    const count = this.int();
    if (count === -1) return null;
    check(count >= 0 && count <= maximum, "Native blob extent.");
    return this.take(count);
  }
  /** Signed zigzag int64; offset and timestamp fields remain bigint. */
  varint(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.byte();
      check(shift !== 63n || byte <= 1, "Native varint overflow.");
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return (value >> 1n) ^ -(value & 1n);
    }
    throw new Error("Native varint extent.");
  }
  variableBlob(): Buffer<ArrayBuffer> | null {
    const count = this.varint();
    if (count === -1n) return null;
    check(count >= 0n && count <= 1048576n, "Native record blob extent.");
    return this.take(Number(count));
  }
  done(): void {
    check(this.at === this.data.length, "Native trailing bytes.");
  }
}
/** Fixed signed network-order scalars; Buffer enforces each native range. */
export function i16(value: number): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value);
  return bytes;
}
export function i32(value: number): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}
export function i64(value: bigint): Buffer<ArrayBuffer> {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(value);
  return bytes;
}
/** Classic Kafka text uses int16 lengths; oracle manifest text uses int32 lengths. */
export function text(value: string, wide = false): Buffer<ArrayBuffer> {
  const bytes = Buffer.from(value);
  check(bytes.length <= 32767, "Native text byte ceiling.");
  return Buffer.concat([wide ? i32(bytes.length) : i16(bytes.length), bytes]);
}
/** Literal reference encoding, independent of any production record encoder. */
export function varint(value: bigint): Buffer<ArrayBuffer> {
  check(value >= -(1n << 63n) && value < (1n << 63n), "Varint range.");
  let number = value >= 0n ? value * 2n : -value * 2n - 1n;
  const output: number[] = [];
  while (number >= 128n) {
    output.push(Number(number & 127n) | 128);
    number >>= 7n;
  }
  output.push(Number(number));
  return Buffer.from(output);
}
