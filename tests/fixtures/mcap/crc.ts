/** Authored MCAP NONE scope framing with independent Node/zlib CRC-32, not native-reader validation. */
import { Buffer } from "node:buffer";
import { crc32 } from "node:zlib";
import { check } from "../acquire.ts";
/** Half-open covered byte range and its separate little-endian checksum field. */
export interface ScopeType {
  readonly kind: "data" | "chunk" | "attachment" | "summary";
  readonly start: number;
  readonly end: number;
  readonly checksum: number;
  readonly expected: number;
}
/** Locate every enabled writer checksum without importing the production parser or native CRC code. */
export function scopes(raw: Buffer<ArrayBuffer>): readonly ScopeType[] {
  const magic = Buffer.from([137, 77, 67, 65, 80, 48, 13, 10]);
  check(
    raw.length >= 45 && raw.length <= 256 * 1024 && raw.subarray(0, 8).equals(magic) && raw.subarray(-8).equals(magic),
    "MCAP fixed magic/fixture extent.",
  );
  function u64(at: number): number {
    check(at >= 0 && at + 8 <= raw.length, "MCAP scope integer extent.");
    const value = raw.readBigUInt64LE(at);
    check(value <= BigInt(raw.length), "MCAP scope offset/length ceiling.");
    return Number(value);
  }
  const result: ScopeType[] = [], footer = raw.length - 37;
  let at = 8, records = 0, dataEnds = 0;
  while (at < footer) {
    check(++records <= 256 && at + 9 <= footer, "MCAP scope record inventory.");
    const opcode = raw[at], body = at + 9, end = body + u64(at + 1);
    check(end <= footer && end > at, "MCAP scope record extent.");
    // MCAP opcode 6 is Chunk; opcode 8 is ChunkIndex with uint64 timestamps.
    if (opcode === 6) {
      check(body + 40 <= end && raw.readUInt32LE(body + 28) === 0, "Only native NONE chunk scope admitted.");
      const payload = body + 40, size = u64(body + 32);
      check(size === u64(body + 16) && payload + size === end, "NONE chunk exact extent.");
      result.push({ kind: "chunk", start: payload, end, checksum: body + 24, expected: raw.readUInt32LE(body + 24) });
    } else if (opcode === 9) {
      check(end - body >= 36, "Attachment scope minimum extent.");
      result.push({
        kind: "attachment",
        start: body,
        end: end - 4,
        checksum: end - 4,
        expected: raw.readUInt32LE(end - 4),
      });
    } else if (opcode === 15) {
      check(end - body === 4 && ++dataEnds === 1, "Unique DataEnd scope.");
      result.push({ kind: "data", start: 0, end: at, checksum: body, expected: raw.readUInt32LE(body) });
    }
    at = end;
  }
  check(at === footer && raw[footer] === 2 && u64(footer + 1) === 20 && dataEnds === 1, "Exact footer placement.");
  const start = u64(footer + 9), offsets = u64(footer + 17);
  check(start === 0 || (start >= 8 && start <= footer), "Summary scope offset.");
  check(offsets === 0 || (start !== 0 && offsets >= start && offsets <= footer), "Summary-offset scope extent.");
  result.push({
    kind: "summary",
    start: start || footer,
    end: footer + 25,
    checksum: footer + 25,
    expected: raw.readUInt32LE(footer + 25),
  });
  return result;
}
/** Validate all native-writer scopes and refuse a changed checksum and covered byte in every scope separately. */
export function verify(
  raw: Buffer<ArrayBuffer>,
): { readonly scopes: readonly ScopeType[]; readonly controls: readonly unknown[] } {
  check(crc32(Buffer.from("123456789")) === 0xcbf43926, "Native zlib CRC-32 known check value.");
  const all = scopes(raw), controls: unknown[] = [];
  for (const scope of all) {
    const actual = crc32(raw.subarray(scope.start, scope.end));
    check(actual === scope.expected, "Independent zlib " + scope.kind + " checksum differs from native writer.");
    const changedChecksum = Buffer.from(raw);
    changedChecksum[scope.checksum] = changedChecksum[scope.checksum]! ^ 1;
    check(
      crc32(changedChecksum.subarray(scope.start, scope.end)) !== changedChecksum.readUInt32LE(scope.checksum),
      "Changed checksum was not refused.",
    );
    check(scope.end > scope.start, "Empty covered scope cannot supply a byte-corruption control.");
    const changedByte = Buffer.from(raw);
    changedByte[scope.start] = changedByte[scope.start]! ^ 1;
    check(
      crc32(changedByte.subarray(scope.start, scope.end)) !== scope.expected,
      "Changed covered byte was not refused.",
    );
    controls.push({
      kind: scope.kind,
      checksumOffset: scope.checksum,
      coveredByteOffset: scope.start,
      changedChecksumRefused: true,
      changedCoveredByteRefused: true,
      owner: "Authored scope walker + Node/zlib, not native C++ reader",
    });
  }
  return { scopes: all, controls };
}
