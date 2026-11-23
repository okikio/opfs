/** Authored small protobuf/CID/CAR encoders for explicit native interoperability controls.
 * They import no production implementation and never establish their own oracle.
 */
import { ok } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
export function uint(input: number): Buffer {
  ok(Number.isSafeInteger(input) && input >= 0);
  let value = BigInt(input);
  const bytes = [];
  while (value >= 128n) {
    bytes.push(Number(value & 127n) | 128);
    value >>= 7n;
  }
  bytes.push(Number(value));
  return Buffer.from(bytes);
}
export function field(number: number, value: number | Buffer): Buffer {
  return typeof value === "number"
    ? Buffer.concat([uint(number * 8), uint(value)])
    : Buffer.concat([uint(number * 8 + 2), uint(value.length), value]);
}
export function cid(codec: number, body: Buffer): { wire: Buffer; text: string } {
  const wire = Buffer.concat([
    Buffer.from([1]),
    uint(codec),
    Buffer.from([0x12, 0x20]),
    createHash("sha256").update(body).digest(),
  ]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, word = 0, text = "b";
  for (const byte of wire) {
    word = word << 8 | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      text += alphabet.charAt(word >>> bits & 31);
    }
  }
  if (bits) text += alphabet.charAt(word << (5 - bits) & 31);
  return { wire, text };
}
export type BlockType = { wire: Buffer; text: string; body: Buffer };
export function car(root: Buffer, blocks: readonly BlockType[]): Buffer {
  ok(root.length + 1 < 256 && blocks.length <= 32);
  const header = Buffer.concat([
    Buffer.from("a265726f6f747381d82a58", "hex"),
    Buffer.from([root.length + 1, 0]),
    root,
    Buffer.from("6776657273696f6e01", "hex"),
  ]);
  return Buffer.concat([
    uint(header.length),
    header,
    ...blocks.map(({ wire, body }) => Buffer.concat([uint(wire.length + body.length), wire, body])),
  ]);
}
/** Read only bounded native metadata fields, rejecting repeated or unsupported wires. */
export function fields(bytes: Buffer): Map<number, number | Buffer> {
  let offset = 0;
  const integer = (): number => {
    let result = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      ok(byte !== undefined);
      result |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) {
        ok(result <= BigInt(Number.MAX_SAFE_INTEGER));
        return Number(result);
      }
    }
    throw new Error("Native metadata varint exceeds uint64.");
  };
  const result = new Map<number, number | Buffer>();
  while (offset < bytes.length) {
    const tag = integer(), number = Math.floor(tag / 8), wire = tag & 7;
    ok(number > 0 && !result.has(number));
    if (wire === 0) result.set(number, integer());
    else {
      ok(wire === 2);
      const length = integer();
      ok(offset + length <= bytes.length);
      result.set(number, bytes.subarray(offset, offset + length));
      offset += length;
    }
  }
  return result;
}
