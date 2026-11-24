/**
 * Member boundaries and decoding for `.warc.gz` files.
 *
 * A `.warc.gz` file is a series of gzip members, normally one record each
 * (WARC 1.1, annex D). Gzip does not store a member's compressed length, so
 * the boundary is found by decoding. This module uses the host's native
 * `DecompressionStream("gzip")` and one rule from the Compression Streams
 * standard: the decoder throws a `TypeError` on a truncated member and on
 * bytes after the member's end. So the extent `[start, end)` is one complete
 * member exactly when the decoder accepts it.
 *
 * To find `end`, the reader tries each later offset that starts with the
 * gzip magic `1f 8b 08`, in order, and keeps the first extent the decoder
 * accepts. An earlier candidate is always a truncated prefix, which the
 * decoder rejects, and the CRC-32 and length trailer reject any other
 * accidental match. The magic bytes can also occur inside compressed data;
 * each such false candidate costs one extra partial decode.
 *
 * @module
 */
import type { ArchiveBudget } from "../budget.ts";

/** Bytes read per source request while scanning or decoding. */
const CHUNK = 64 * 1024;

/** The smallest gzip member: 10-byte header, 2-byte empty DEFLATE block, 8-byte trailer. */
export const MIN_MEMBER = 20;

/** Returns whether the bytes start with the gzip magic and the DEFLATE method. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b && bytes[2] === 0x08;
}

/**
 * Returns the first offset at or after `from` that starts with `1f 8b 08`,
 * or `size` when there is none.
 *
 * Reads overlap by 2 bytes so a magic split across two requests is found.
 */
export async function findMember(budget: ArchiveBudget, size: number, from: number): Promise<number> {
  let offset = from;
  while (offset + 3 <= size) {
    const bytes = await budget.read(offset, Math.min(CHUNK, size - offset));
    for (let at = 0; at + 3 <= bytes.length; at++) {
      if (isGzip(bytes.subarray(at))) return offset + at;
    }
    if (offset + bytes.length >= size) break;
    offset += bytes.length - 2;
  }
  return size;
}

/** Decoded facts from one member. */
export interface InflateType {
  /** Decoded bytes in `[from, from + take)`, or fewer when the member is shorter. */
  readonly bytes: Uint8Array;
  /** Total decoded length of the member. */
  readonly size: number;
  /** The last 4 decoded bytes, used to check the record separator. */
  readonly tail: Uint8Array;
}

/**
 * Decodes `[start, end)` as exactly one gzip member.
 *
 * Returns the decoded bytes in `[from, from + take)` plus the member's decoded
 * length. Returns `undefined` when the extent is not one complete member:
 * truncated, followed by extra bytes, or corrupt. Source, budget and abort
 * failures are thrown unchanged, so a budget stop is never mistaken for a
 * wrong boundary.
 *
 * Memory stays at one chunk plus `take` bytes. Every decoded byte is charged to
 * the budget, including bytes outside the requested range.
 */
export async function inflate(
  budget: ArchiveBudget,
  start: number,
  end: number,
  from: number,
  take: number,
): Promise<InflateType | undefined> {
  let failure: { readonly reason: unknown } | undefined;
  let offset = start;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (offset >= end) return controller.close();
      try {
        const bytes = await budget.read(offset, Math.min(CHUNK, end - offset));
        offset += bytes.length;
        // Native codecs refuse views over a SharedArrayBuffer, so copy those.
        controller.enqueue(
          bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes),
        );
      } catch (reason) {
        // Keep the original error. The decoder would otherwise report it as its own.
        failure = { reason };
        controller.error(reason);
      }
    },
  });
  const codec: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>> = new DecompressionStream("gzip");
  const reader = source.pipeThrough(codec).getReader();
  const result = new Uint8Array(take);
  let filled = 0;
  let size = 0;
  const tail = new Uint8Array(4);
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (reason) {
        if (failure !== undefined) throw failure.reason;
        if (reason instanceof TypeError) return undefined;
        throw reason;
      }
      if (chunk.done) break;
      const bytes = chunk.value;
      budget.decoded(bytes.length);
      // Copy the part of this chunk that falls in [from, from + take).
      const low = Math.max(from, size);
      const high = Math.min(from + take, size + bytes.length);
      if (high > low) {
        result.set(bytes.subarray(low - size, high - size), low - from);
        filled = high - from;
      }
      // Keep a rolling copy of the last 4 decoded bytes.
      if (bytes.length >= 4) tail.set(bytes.subarray(bytes.length - 4));
      else {
        tail.copyWithin(0, bytes.length);
        tail.set(bytes, 4 - bytes.length);
      }
      size += bytes.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { bytes: result.subarray(0, filled), size, tail };
}

/**
 * Returns the end of the member that starts at `start`.
 *
 * Tries each candidate from {@link findMember} in order and returns the first
 * one that {@link inflate} accepts, with its decoded facts. Returns
 * `undefined` when no extent up to `size` is a complete member.
 */
export async function scanMember(
  budget: ArchiveBudget,
  size: number,
  start: number,
  take: number,
): Promise<{ readonly end: number; readonly member: InflateType } | undefined> {
  let from = start + MIN_MEMBER;
  while (from <= size) {
    const end = from >= size ? size : await findMember(budget, size, from);
    const member = await inflate(budget, start, end, 0, take);
    if (member !== undefined) return { end, member };
    if (end >= size) return undefined;
    from = end + 1;
  }
  return undefined;
}
