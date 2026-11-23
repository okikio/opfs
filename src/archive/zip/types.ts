/** The ZIP reader's public data shapes and its private directory record. @module */
import type { ArchiveLimitsType, ArchiveWorkType } from "../record.ts";
import type { ZipAesOptionsType } from "./cipher.ts";
import type { ZipBzipOptionsType } from "./bzip.ts";
import type { ZipLzmaOptionsType } from "./lzma.ts";

/** A stable directory identity. Duplicate names remain separate entries. */
export interface ZipEntryType {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly compressedSize: number;
  readonly method: number;
  readonly encrypted: boolean;
  /** Exact inspected encryption profile; reading still requires explicit password/capability admission. */
  readonly encryption?: "zipcrypto" | "winzip-aes" | "unsupported";
  readonly aes?: ZipAesMetadataType;
  readonly directory: boolean;
  readonly kind: "file" | "directory" | "symbolic-link" | "other";
  readonly crc32: number;
}

/** Inspected WinZip AES extra-field values. Ciphertext authentication does not authenticate this metadata. */
export interface ZipAesMetadataType {
  readonly version: 1 | 2;
  readonly strength: 128 | 192 | 256;
  readonly method: number;
}

/** Opening limits also bound cumulative work for this directory and every later member read. */
export interface ZipOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly maxDirectoryBytes?: number;
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
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /**
   * When true, completes the available member CRC check before returning a partial interval.
   * Defaults to false for partial reads; complete reads check CRC when provided.
   * Verification can read or decode the whole member despite a small output.
   * Format-required ciphertext authentication still applies independently.
   */
  readonly verify?: boolean;
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
  readonly bytes: Uint8Array;
  readonly integrity: "checksum-pending" | "checksum-verified" | "not-provided";
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
  readonly supported: boolean;
  readonly reason?: "encrypted-member" | "compression-method" | "budget-exceeded";
  readonly access: "direct-range" | "decode-from-start" | "authenticated-range";
  readonly outputBytes: number;
  /** Minimum plaintext work from metadata. Codec chunks, transforms and verification passes can require more. */
  readonly decodedBytes: number;
  readonly sourceBytes: number;
  readonly headerBytes: "unknown";
  readonly verification: "none" | "full-member-crc" | "full-member-decode";
  readonly authentication?: "full-member-hmac";
  readonly cryptoBlocks?: number;
}

/**
 * An opened directory borrows its source and captures its descriptor and read method before I/O.
 * Opening limits, ledger and abort signal remain authoritative for every read.
 * It owns no provider or background work; changing underlying bytes invalidates its offsets.
 */
export interface ZipArchiveType {
  readonly entries: readonly ZipEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  plan(id: number, options?: ZipReadOptionsType): ZipPlanType;
  read(id: number, options?: ZipReadOptionsType): Promise<ZipReadType>;
}

/**
 * One central-directory record plus the local-header facts the reader needs.
 *
 * Internal to the ZIP reader: `openZip` keeps these private so callers cannot change local-header evidence through
 * the public `ZipEntryType` they receive.
 */
export interface DirectoryRecordType {
  readonly entry: ZipEntryType;
  readonly name: Uint8Array;
  readonly flags: number;
  readonly offset: number;
  readonly time: number;
  readonly needed: number;
}
