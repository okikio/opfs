/** Plan one ZIP member read: its byte ranges, decoder and limits, before any source or decoder is acquired. @module */
import { integer, invalid, limitsOf } from "../record.ts";
import type { DirectoryRecordType, ZipPlanType, ZipReadOptionsType } from "./types.ts";

/** Planning never acquires a source, decoder or runtime capability. */
export function planRead(record: DirectoryRecordType, options: ZipReadOptionsType): ZipPlanType {
  const entry = record.entry;
  limitsOf(options);
  const offset = options.offset ?? 0;
  const length = options.length ?? entry.size - offset;
  integer(offset, "Decoded offset");
  integer(length, "Decoded length");
  if (offset > entry.size || length > entry.size - offset) throw new RangeError("Requested range exceeds ZIP member.");
  const complete = Boolean(options.verify) || (offset === 0 && length === entry.size);
  if (entry.encryption === "winzip-aes" && entry.aes && options.password !== undefined && options.aes) {
    const maximum = options.aes.maxCiphertextBytes ?? 8 * 1024 * 1024;
    const maxBlocks = options.aes.maxBlocks ?? 8192;
    integer(maximum, "AES ciphertext limit");
    integer(maxBlocks, "AES block limit");
    if (maximum > 8 * 1024 * 1024 || maxBlocks > 8192) {
      throw new RangeError("WinZip AES implementation ceilings are 8 MiB ciphertext and 8192 native AES blocks.");
    }
    const ciphertext = entry.compressedSize - entry.aes.strength / 16 - 12;
    if (ciphertext < 0 || (entry.aes.method === 0 && ciphertext !== entry.size)) {
      invalid("WinZip AES ciphertext framing disagrees with member sizes.");
    }
    const deflate = entry.aes.method === 8;
    const crc = entry.aes.version === 1 && complete;
    const begin = crc ? 0 : Math.floor(offset / 16) * 16;
    const end = crc ? entry.size : length ? Math.min(entry.size, Math.ceil((offset + length) / 16) * 16) : begin;
    const decrypt = deflate ? (complete || length ? ciphertext : 0) : end - begin;
    const blocks = Math.ceil(decrypt / 16);
    const decoded = ciphertext * 2 + decrypt + (deflate ? complete ? entry.size : length ? offset + length : 0 : 0);
    const reason =
      ciphertext > maximum || blocks > maxBlocks || length > (options.maxOutputBytes ?? 16 * 1024 * 1024) ||
        decoded > (options.maxDecodedBytes ?? 64 * 1024 * 1024) ||
        entry.compressedSize > (options.maxSourceBytes ?? 64 * 1024 * 1024)
        ? "budget-exceeded" as const
        : undefined;
    return {
      supported: !reason,
      ...(reason ? { reason } : {}),
      access: deflate ? "decode-from-start" : "authenticated-range",
      outputBytes: length,
      decodedBytes: decoded,
      sourceBytes: entry.compressedSize,
      headerBytes: "unknown",
      verification: crc ? "full-member-crc" : deflate && complete ? "full-member-decode" : "none",
      authentication: "full-member-hmac",
      cryptoBlocks: blocks,
    };
  }
  const legacy = entry.encrypted && entry.encryption === "zipcrypto" && options.password !== undefined;
  const plaintext = complete ? entry.size : entry.method === 0 && !legacy ? length : offset + length;
  const decoded = legacy ? plaintext + (entry.method === 0 ? 12 : entry.compressedSize) : plaintext;
  const source = legacy && entry.method === 0
    ? plaintext + 12
    : entry.method === 0
    ? (complete ? entry.size : length)
    : entry.compressedSize;
  const reason = entry.encrypted && !legacy
    ? "encrypted-member"
    : entry.method !== 0 && entry.method !== 8 && !(entry.method === 12 && record.needed >= 46) &&
        !(entry.method === 14 && record.needed >= 63 && (record.flags & 2))
    ? "compression-method"
    : length > (options.maxOutputBytes ?? 16 * 1024 * 1024) ||
        decoded > (options.maxDecodedBytes ?? 64 * 1024 * 1024) || source > (options.maxSourceBytes ?? 64 * 1024 * 1024)
    ? "budget-exceeded"
    : undefined;
  return {
    supported: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
    access: entry.method === 0 && !legacy ? "direct-range" : "decode-from-start",
    outputBytes: length,
    decodedBytes: decoded,
    sourceBytes: source,
    headerBytes: "unknown",
    verification: complete ? "full-member-crc" : "none",
  };
}
