/**
 * Fixed-width field reads for binary archive headers.
 *
 * @module
 */
import { unsupported } from "./error.ts";

/**
 * Creates a `DataView` over exactly the bytes of `bytes`, honouring its offset and length in a larger buffer.
 *
 * Call it where a parser reads fixed-width fields: `createView(header).getUint32(4, true)`. A view built from
 * `bytes.buffer` alone would start at the buffer's first byte, not the slice's.
 */
export function createView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Gets the little-endian unsigned 64-bit field at `offset` as an exact `number`.
 *
 * Use it beside `DataView`'s own getters, which have no exact 64-bit form for `number`:
 * `const offset = getUint64(record, 48);`. Values above `Number.MAX_SAFE_INTEGER` throw `unsupported-profile`
 * instead of losing their high bits.
 */
export function getUint64(data: DataView, offset: number): number {
  const value = data.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw unsupported("Archive offset or size exceeds exact JavaScript integers.");
  }
  return Number(value);
}
