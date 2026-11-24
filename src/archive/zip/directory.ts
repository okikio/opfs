/**
 * Parse a ZIP central directory and the extra fields the reader trusts.
 *
 * The central directory lists every member. Its offsets become authoritative only after a read checks them against the
 * member's local header, so this module returns directory records, not readable members.
 *
 * @module
 */
import { createView, getUint64 } from "../field.ts";
import { invalid, unsupported } from "../error.ts";
import type { DirectoryRecordType, ZipAesMetadataType } from "./types.ts";

/** Directory offsets are authoritative only after local-header agreement is checked during reads. */
export function parseDirectory(
  bytes: Uint8Array,
  count: number,
  boundary: number,
  decodeName?: (bytes: Uint8Array) => string,
): DirectoryRecordType[] {
  const data = createView(bytes);
  const records: DirectoryRecordType[] = [];
  const offsets = new Set<number>();
  let position = 0;
  for (let id = 0; id < count; id++) {
    if (position > bytes.byteLength - 46 || data.getUint32(position, true) !== 0x02014b50) {
      throw invalid("Invalid ZIP directory record.");
    }
    const flags = data.getUint16(position + 8, true);
    const method = data.getUint16(position + 10, true);
    let compressedSize = data.getUint32(position + 20, true);
    let size = data.getUint32(position + 24, true);
    const nameSize = data.getUint16(position + 28, true);
    const extraSize = data.getUint16(position + 30, true);
    const commentSize = data.getUint16(position + 32, true);
    let disk = data.getUint16(position + 34, true);
    let offset = data.getUint32(position + 42, true);
    const next = position + 46 + nameSize + extraSize + commentSize;
    if (next > bytes.byteLength) throw invalid("Truncated ZIP directory record.");
    const rawName = bytes.slice(position + 46, position + 46 + nameSize);
    const extra = createView(bytes.subarray(position + 46 + nameSize, position + 46 + nameSize + extraSize));
    const values = zip64(
      extra,
      size === 0xffffffff,
      compressedSize === 0xffffffff,
      offset === 0xffffffff,
      disk === 0xffff,
    );
    size = values.size ?? size;
    compressedSize = values.compressedSize ?? compressedSize;
    offset = values.offset ?? offset;
    disk = values.disk ?? disk;
    if (disk !== 0) throw unsupported("Split ZIP members are unsupported.");
    if (offset >= boundary || compressedSize > boundary - offset) {
      throw invalid("ZIP member extent overlaps directory.");
    }
    if (offsets.has(offset)) throw invalid("Distinct ZIP entries alias the same local header.");
    offsets.add(offset);
    let name: string;
    if (flags & 0x800) {
      try {
        name = new TextDecoder("utf-8", { fatal: true }).decode(rawName);
      } catch {
        throw invalid("ZIP UTF-8 name is invalid.");
      }
    } else if (decodeName) name = decodeName(rawName.slice());
    else {
      if (rawName.some((byte) => byte > 127)) {
        throw unsupported("Non-ASCII ZIP names require an explicit legacy decoder.");
      }
      name = new TextDecoder().decode(rawName);
    }
    if (typeof name !== "string") throw new TypeError("ZIP name decoder must return a string.");
    const host = data.getUint16(position + 4, true) >>> 8;
    const unixKind = host === 3 ? (data.getUint32(position + 38, true) >>> 16) & 0xf000 : 0;
    const kind = unixKind === 0xa000
      ? "symbolic-link"
      : unixKind === 0x4000 || name.endsWith("/")
      ? "directory"
      : unixKind === 0 || unixKind === 0x8000
      ? "file"
      : "other";
    const aes = readAesExtra(extra);
    const supportedAes = aes && (aes.method === 0 || aes.method === 8) && method === 99 && (flags & 1) &&
      !(flags & 0x2048) &&
      data.getUint16(position + 6, true) >= (aes.method === 0 ? 10 : 20);
    if (aes?.version === 2 && data.getUint32(position + 16, true) !== 0) {
      throw invalid("WinZip AE-2 requires a zero CRC field.");
    }
    const entry = Object.freeze({
      id,
      name,
      size,
      compressedSize,
      method,
      encrypted: Boolean(flags & 0x2041),
      ...(aes ? { aes: Object.freeze(aes) } : {}),
      ...(!(flags & 0x2041) ? {} : {
        encryption: supportedAes
          ? "winzip-aes" as const
          : (flags & 1) && !(flags & 0x2040) && !hasExtra(extra, 0x9901) && data.getUint16(position + 6, true) >= 20 &&
              (method === 0 || method === 8)
          ? "zipcrypto" as const
          : "unsupported" as const,
      }),
      directory: kind === "directory",
      kind,
      crc32: data.getUint32(position + 16, true),
    });
    records.push({
      entry,
      name: rawName,
      flags,
      offset,
      time: data.getUint16(position + 12, true),
      needed: data.getUint16(position + 6, true),
    });
    position = next;
  }
  if (position !== bytes.byteLength) throw unsupported("Extra ZIP directory records are unsupported.");
  return records;
}

/** Validate the full bounded extra area: an early match must not hide trailing corruption or duplicate profiles. */
function findExtra(data: DataView, wanted: number): DataView | undefined {
  let at = 0;
  let found: DataView | undefined;
  while (at < data.byteLength) {
    if (data.byteLength - at < 4) throw invalid("Truncated ZIP extra field.");
    const id = data.getUint16(at, true);
    const size = data.getUint16(at + 2, true);
    if (size > data.byteLength - at - 4) throw invalid("ZIP extra field exceeds record.");
    if (id === wanted) {
      if (found) throw invalid("Duplicate ZIP encryption extra fields are ambiguous.");
      found = new DataView(data.buffer, data.byteOffset + at + 4, size);
    }
    at += 4 + size;
  }
  return found;
}

/** Exact current AES metadata only. Unknown vendor/version/extensions remain explicitly unsupported. */
export function readAesExtra(data: DataView): ZipAesMetadataType | undefined {
  const field = findExtra(data, 0x9901);
  if (!field) return undefined;
  if (field.byteLength !== 7) return undefined;
  const version = field.getUint16(0, true);
  const strength = field.getUint8(4);
  if ((version !== 1 && version !== 2) || field.getUint16(2, true) !== 0x4541 || strength < 1 || strength > 3) {
    return undefined;
  }
  return { version, strength: strength === 1 ? 128 : strength === 2 ? 192 : 256, method: field.getUint16(5, true) };
}

/** Returns whether the extra-field block `data` contains a field with header ID `wanted`, such as `0x9901` for AES. */
export function hasExtra(data: DataView, wanted: number): boolean {
  return findExtra(data, wanted) !== undefined;
}

/** ZIP64 extra values appear only for sentinel fields and in their specified order. */
export function zip64(
  data: DataView,
  size: boolean,
  compressed: boolean,
  offset: boolean,
  disk: boolean,
): { size?: number; compressedSize?: number; offset?: number; disk?: number } {
  let position = 0;
  let result: { size?: number; compressedSize?: number; offset?: number; disk?: number } | undefined;
  while (position < data.byteLength) {
    if (position > data.byteLength - 4) throw invalid("Truncated ZIP extra field.");
    const id = data.getUint16(position, true);
    const length = data.getUint16(position + 2, true);
    const end = position + 4 + length;
    if (end > data.byteLength) throw invalid("ZIP extra field exceeds record.");
    if (id === 1) {
      if (result) throw invalid("Duplicate ZIP64 extra fields are ambiguous.");
      result = {};
      let cursor = position + 4;
      for (const [needed, key] of [[size, "size"], [compressed, "compressedSize"], [offset, "offset"]] as const) {
        if (needed) {
          if (cursor > end - 8) throw invalid("ZIP64 field is missing a required value.");
          result[key] = getUint64(data, cursor);
          cursor += 8;
        }
      }
      if (disk) {
        if (cursor > end - 4) throw invalid("ZIP64 disk value is missing.");
        result.disk = data.getUint32(cursor, true);
      }
    }
    position = end;
  }
  if (!result && (size || compressed || offset || disk)) throw invalid("ZIP64 extra field is missing.");
  return result ?? {};
}
