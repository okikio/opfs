/**
 * Coder, folder, entry and option types for the 7-Zip reader.
 *
 * @module
 */
import type { LzmaLimitsType } from "../lzma.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "../budget.ts";

/** Method and properties are inert hex metadata; no codec is loaded or invoked. */
export interface SevenCoderType {
  readonly method: string;
  readonly properties: string;
}

/** Physical packed extent and its optional packed-byte CRC, never a decoded checksum. */
export interface SevenPackType {
  readonly id: number;
  readonly offset: number;
  readonly size: number;
  readonly crc?: number;
}

/** A folder is one coder graph, not a pathname directory. Only validated linear graphs are indexed. */
export interface SevenFolderType {
  readonly id: number;
  readonly coders: readonly SevenCoderType[];
  readonly size: number;
  readonly packId: number;
  readonly substreams: number;
  readonly solid: boolean;
  readonly encrypted: boolean | "unknown";
  readonly readable: boolean;
  readonly crc?: number;
}

/** Archive-order record; names remain untrusted and duplicate names retain distinct IDs. */
export interface SevenEntryType {
  readonly id: number;
  readonly name: string;
  readonly kind: "file" | "directory" | "symbolic-link" | "special" | "anti";
  readonly size: number;
  readonly readable: boolean;
  readonly folderId?: number;
  readonly folderOffset?: number;
  readonly crc?: number;
  /** A single-substream folder can supply its CRC instead of an independent file digest. */
  readonly crcSource?: "substream" | "folder";
  readonly attributes?: number;
  /** Raw Windows FILETIME units: 100 ns since 1601-01-01 UTC. Not Unix milliseconds. */
  readonly mtime?: bigint;
}

/** Codec allocation/CPU limits apply independently to each header/member decode; archive ledgers aggregate bytes. */
export type SevenLzmaOptionsType = Pick<
  LzmaLimitsType,
  "maxDictionaryBytes" | "maxMemoryBytes" | "maxDecisions" | "maxSteps" | "maxChunks" | "inputChunkBytes" | "yield"
>;

/** Finite index admission. No decoder, registry or source lifetime is acquired. */
export interface SevenOpenOptionsType extends ArchiveLimitsType {
  /** Defaults match the bounded LZMA engine; opening policy is inherited by member reads. */
  readonly lzma?: SevenLzmaOptionsType;
  readonly signal?: AbortSignal;
  /** Signature/next-header bytes plus admitted string copies. Default 8 MiB; not a JS heap bound. */
  readonly maxHeaderBytes?: number;
  /** Maximum materialized file records. Default 100,000. */
  readonly maxEntries?: number;
  /** Maximum coder graphs. Default 4096. */
  readonly maxFolders?: number;
  /** Aggregate coders across folders. Default 4096. */
  readonly maxCoders?: number;
  /** Aggregate packed and unpacked substream records. Default 100,000. */
  readonly maxStreams?: number;
  /** Aggregate length-delimited property records. Default 100,000. */
  readonly maxProperties?: number;
  /** UTF-16LE bytes per name including NUL. Default 64 KiB. */
  readonly maxNameBytes?: number;
  /** Explicitly accept a source with no stability declaration. Default false; identity is insufficient. */
  readonly allowUnverifiedSource?: boolean;
}

/** Selected output range with independent work limits; verification can scan the whole file. */
export interface SevenReadOptionsType extends ArchiveLimitsType {
  /** Override inherited codec limits for this decode, without replacing aggregate byte ownership. */
  readonly lzma?: SevenLzmaOptionsType;
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default true; compressed reads drain and validate the complete selected member, including present CRCs. */
  readonly verify?: boolean;
}

/** Checks retain packed-byte versus decoded-byte scopes; CRC is never authentication. */
export interface SevenCheckType {
  readonly scope: "pack" | "folder" | "substream";
  readonly crc: number;
  readonly status: "crc32-verified" | "pending";
}

/** Owned selected bytes and explicit checksum evidence; CRC is not authentication. */
export interface SevenReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "crc32-verified" | "pending" | "none";
  readonly checks: readonly SevenCheckType[];
  /** Present for a decoded compressed member; a prefix has no complete terminal evidence. */
  readonly decoding?: "complete" | "prefix";
  readonly work: ArchiveWorkType;
}

/** Immutable index over a borrowed replayable source. No file is extracted or source closed. */
export interface SevenArchiveType {
  readonly entries: readonly SevenEntryType[];
  readonly folders: readonly SevenFolderType[];
  readonly packs: readonly SevenPackType[];
  /** Header CRC evidence is mandatory and distinct from payload checks or authentication. */
  readonly headers: {
    readonly start: "crc32-verified";
    readonly next: "crc32-verified";
    /** Present only after decoding an encoded header; these checks describe metadata, not file payloads. */
    readonly decoded?: {
      readonly method: string;
      readonly integrity: "crc32-verified";
      readonly checks: readonly SevenCheckType[];
    };
  };
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  /** Read a regular supported single-substream/empty file by ID; absent CRCs report none, unchecked present CRCs pending. */
  read(id: number, options?: SevenReadOptionsType): Promise<SevenReadType>;
}
