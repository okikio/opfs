/** Fixed independent original payloads and slow Castagnoli reference; no production imports. */
import { Buffer } from "node:buffer";
import { i16, i32, i64, varint } from "./wire.ts";
export const TIMESTAMP = 1700000000000n;
/** Nullable binary fields retain empty/null distinctions, and headers retain order and duplicate names. */
export interface RecordType {
  readonly timestamp: bigint;
  readonly key: Buffer<ArrayBuffer> | null;
  readonly value: Buffer<ArrayBuffer> | null;
  readonly headers: readonly { readonly name: string; readonly value: Buffer<ArrayBuffer> | null }[];
}
/** Restated original data is shared only by independent tooling, never derived from candidate output. */
export function payloads(timestamp = TIMESTAMP): readonly RecordType[] {
  return [
    {
      timestamp,
      key: null,
      value: Buffer.from(Array.from({ length: 131072 }, (_, at) => at % 256)),
      headers: [{ name: "dup", value: Buffer.from([0, 255]) }, { name: "dup", value: null }, {
        name: "dup",
        value: Buffer.alloc(0),
      }],
    },
    { timestamp: timestamp + 1n, key: Buffer.alloc(0), value: null, headers: [] },
    {
      timestamp: timestamp + 2n,
      key: Buffer.from([0, 255, 0]),
      value: Buffer.alloc(0),
      headers: [{ name: "trace", value: Buffer.from([13, 10, 0, 128]) }],
    },
  ];
}
/** Deliberately bitwise reference; Java's builtin CRC32C supplies a separate native primitive check. */
export function crc32c(raw: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of raw) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function field(raw: Buffer<ArrayBuffer> | null): Buffer<ArrayBuffer> {
  return raw === null ? varint(-1n) : Buffer.concat([varint(BigInt(raw.length)), raw]);
}
/** One uncompressed CreateTime magic-2 batch with explicitly non-idempotent sentinel IDs. */
export function batch(): { readonly bytes: Buffer<ArrayBuffer>; readonly crcInput: Buffer<ArrayBuffer> } {
  const records = payloads().map((record, index) => {
    const body = Buffer.concat([
      Buffer.from([0]),
      varint(BigInt(index)),
      varint(BigInt(index)),
      field(record.key),
      field(record.value),
      varint(BigInt(record.headers.length)),
      ...record.headers.flatMap((header) => [field(Buffer.from(header.name)), field(header.value)]),
    ]);
    return Buffer.concat([varint(BigInt(body.length)), body]);
  });
  const crcInput = Buffer.concat([
    i16(0),
    i32(2),
    i64(TIMESTAMP),
    i64(TIMESTAMP + 2n),
    i64(-1n),
    i16(-1),
    i32(-1),
    i32(3),
    ...records,
  ]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32c(crcInput));
  const tail = Buffer.concat([i32(-1), Buffer.from([2]), crc, crcInput]);
  return { bytes: Buffer.concat([i64(0n), i32(tail.length), tail]), crcInput };
}
