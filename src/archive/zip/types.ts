/** The ZIP reader's public data shapes and its private directory record. @module */
import type { ArchiveLimitsType, ArchiveWorkType } from "../budget.ts";
import type { ZipAesOptionsType } from "./cipher.ts";
import type { ZipBzipOptionsType } from "./bzip.ts";
import type { ZipLzmaOptionsType } from "./lzma.ts";

/** A stable directory identity. Duplicate names remain separate entries. */
export interface ZipEntryType {
  /** Index in the central directory; pass it to `read()` and `plan()`. */
  readonly id: number;
  /** Decoded member name. A name is metadata, never automatically a host path. */
  readonly name: string;
  /** Uncompressed byte length from the central directory. */
  readonly size: number;
  /** Stored byte length, including any encryption header and trailer. */
  readonly compressedSize: number;
  /** ZIP compression method number: 0 STORED, 8 DEFLATE, 12 BZip2, 14 LZMA, 99 WinZip AES. */
  readonly method: number;
  /** True when the general-purpose encryption flag is set. */
  readonly encrypted: boolean;
  /** Exact inspected encryption profile; reading still requires explicit password/capability admission. */
  readonly encryption?: "zipcrypto" | "winzip-aes" | "unsupported";
  /** WinZip AES extra-field values, present only for `encryption: "winzip-aes"`. */
  readonly aes?: ZipAesMetadataType;
  /** True when `kind` is `"directory"`: a name ending in `/` or a Unix directory mode. */
  readonly directory: boolean;
  /** Entry kind from the name and the external attributes. Links are reported, never followed. */
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  /** CRC-32 of the uncompressed member, as recorded. AE-2 members record 0. */
  readonly crc32: number;
}

/** Inspected WinZip AES extra-field values. Ciphertext authentication does not authenticate this metadata. */
export interface ZipAesMetadataType {
  /** AE-1 keeps the plaintext CRC; AE-2 records zero and relies on the HMAC alone. */
  readonly version: 1 | 2;
  /** AES key size in bits. */
  readonly strength: 128 | 192 | 256;
  /** Compression method of the plaintext inside the ciphertext. */
  readonly method: number;
}

/** Opening limits also bound cumulative work for this directory and every later member read. */
export interface ZipOpenOptionsType extends ArchiveLimitsType {
  /** Cancels opening and every later read of this archive. */
  readonly signal?: AbortSignal;
  /** Maximum central directory size read and retained. */
  readonly maxDirectoryBytes?: number;
  /** Maximum central directory entries admitted. */
  readonly maxEntries?: number;
  /** Explicitly accepts mutation risk when an injected source declares no snapshot stability. */
  readonly allowUnverifiedSource?: boolean;
  /** Used only for non-UTF-8 names; default accepts ASCII and refuses ambiguous legacy bytes. */
  readonly decodeName?: (bytes: Uint8Array) => string;
}

/** A codec factory is called per read and must provide an independently owned raw-DEFLATE transform. */
export type ZipInflateType = () => TransformStream<Uint8Array, Uint8Array>;

/** A decoded interval; per-read limits can narrow, but cannot raise, the remaining opening allowance. */
export interface ZipReadOptionsType extends ArchiveLimitsType {
  /** Cancels this read. The opening signal still applies. */
  readonly signal?: AbortSignal;
  /** First uncompressed byte to return. Defaults to 0. */
  readonly offset?: number;
  /** Uncompressed bytes to return. Defaults to the rest of the member. */
  readonly length?: number;
  /**
   * When true, completes the available member CRC check before returning a partial interval.
   * Defaults to false for partial reads; complete reads check CRC when provided.
   * Verification can read or decode the whole member despite a small output.
   * Format-required ciphertext authentication still applies independently.
   */
  readonly verify?: boolean;
  /** Raw-DEFLATE transform factory for method 8. Defaults to the platform's `DecompressionStream`. */
  readonly inflate?: ZipInflateType;
  /** Optional bounded BZip2 kernel policy for unencrypted compression method 12. */
  readonly bzip?: ZipBzipOptionsType;
  /** Optional bounded raw-LZMA1 policy for unencrypted method 14 with its EOS flag set. */
  readonly lzma?: ZipLzmaOptionsType;
  /** Explicit password bytes. Copied before source I/O; no password text encoding is inferred. */
  readonly password?: Uint8Array;
  /** Maximum password byte length. Default 1024. No text encoding is inferred. */
  readonly maxPasswordBytes?: number;
  /** Explicit native capability and finite limits for WinZip AES STORED and DEFLATE reads. */
  readonly aes?: ZipAesOptionsType;
}

/** CRC verification detects accidental corruption, not malicious modification or sender identity. */
export interface ZipReadType {
  /** The requested uncompressed bytes. */
  readonly bytes: Uint8Array;
  /**
   * `checksum-verified` after a complete member was checked against its CRC; `checksum-pending` for a partial read
   * that did not check it; `not-provided` for a WinZip AE-2 member, which records no CRC.
   */
  readonly integrity: "checksum-pending" | "checksum-verified" | "not-provided";
  /** Work charged by this read. */
  readonly work: ArchiveWorkType;
  /** Codec framing/check evidence is separate from ZIP CRC over the complete plaintext member. */
  readonly codec?: {
    readonly kind: "bzip2";
    readonly integrity: "checksum-pending" | "checksum-verified";
    readonly verifiedBlocks: number;
    readonly steps: number;
    readonly memoryBytes: number;
  } | {
    readonly kind: "lzma";
    readonly integrity: "none";
    readonly termination: "pending" | "end-marker";
    readonly dictionaryBytes: number;
    readonly decisions: number;
    readonly steps: number;
  };
  /** Authentication covers ciphertext only, never names, ZIP metadata, a sender or the whole archive. */
  readonly encryption?: { readonly kind: "zipcrypto"; readonly authentication: "none" } | {
    readonly kind: "winzip-aes";
    readonly authentication: "ciphertext-verified";
  };
}

/** Deterministic admission. Local-header lengths and codec availability remain execution-time facts. */
export interface ZipPlanType {
  /** False when the read would be refused; `reason` says why. */
  readonly supported: boolean;
  /** Why `supported` is false. */
  readonly reason?: "encrypted-member" | "compression-method" | "budget-exceeded";
  /**
   * `direct-range` reads only the requested stored bytes; `decode-from-start` decodes from the member's first byte;
   * `authenticated-range` authenticates the whole ciphertext, then decrypts only the needed AES blocks.
   */
  readonly access: "direct-range" | "decode-from-start" | "authenticated-range";
  /** Bytes the read returns. */
  readonly outputBytes: number;
  /** Minimum plaintext work from metadata. Codec chunks, transforms and verification passes can require more. */
  readonly decodedBytes: number;
  /** Minimum source bytes read, excluding the local header. */
  readonly sourceBytes: number;
  /** The local header's length is only known after it is read. */
  readonly headerBytes: "unknown";
  /** Whole-member check the read performs, if any. */
  readonly verification: "none" | "full-member-crc" | "full-member-decode";
  /** Present for WinZip AES: the whole ciphertext is authenticated before any plaintext is returned. */
  readonly authentication?: "full-member-hmac";
  /** Native AES block calls the read needs. */
  readonly cryptoBlocks?: number;
}

/**
 * An opened directory borrows its source and captures its descriptor and read method before I/O.
 * Opening limits, ledger and abort signal remain authoritative for every read.
 * It owns no provider or background work; changing underlying bytes invalidates its offsets.
 */
export interface ZipArchiveType {
  /** Central directory entries in archive order. */
  readonly entries: readonly ZipEntryType[];
  /** Work charged while opening. */
  readonly work: ArchiveWorkType;
  /** The borrowed source's identity and declared stability, captured at open. */
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  /** Predicts one read's access, work and refusal without any source I/O. */
  plan(id: number, options?: ZipReadOptionsType): ZipPlanType;
  /** Reads one member, or the `offset`/`length` interval of it, under the opening and per-read limits. */
  read(id: number, options?: ZipReadOptionsType): Promise<ZipReadType>;
}

/**
 * One central-directory record plus the local-header facts the reader needs.
 *
 * Owned by the ZIP reader: `openZip` keeps these private so callers cannot change local-header evidence through
 * the public `ZipEntryType` they receive.
 */
export interface DirectoryRecordType {
  /** The entry callers receive. */
  readonly entry: ZipEntryType;
  /** Raw name bytes, compared with the local header's name before a read. */
  readonly name: Uint8Array;
  /** General-purpose bit flags. */
  readonly flags: number;
  /** Byte offset of the local header. */
  readonly offset: number;
  /** DOS last-modified time field. */
  readonly time: number;
  /** Version needed to extract. */
  readonly needed: number;
}
