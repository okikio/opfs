/**
 * Index WARC 1.0 and 1.1 files, plain or `.warc.gz`, and read stored blocks.
 *
 * | Module      | Owns                                                       |
 * | ----------- | ---------------------------------------------------------- |
 * | `mod.ts`    | `openWarc`, the index and block reads                      |
 * | `header.ts` | record header parsing shared by both profiles              |
 * | `gzip.ts`   | gzip member boundaries and decoding for `.warc.gz`         |
 * | `write.ts`  | `createWarcStream`, the writer (`archive/warc/write`)      |
 *
 * @module
 */
import type { ByteSourceType } from "../../source.ts";
import { ArchiveBudget, assertAtMost, assertInteger } from "../budget.ts";
import { ArchiveError, invalid, unsupported } from "../error.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "../budget.ts";
import { base32, type HeaderLimitsType, type HeaderType, isSeparator, parseHeader } from "./header.ts";
import type { WarcFieldType } from "./header.ts";
import { inflate, isGzip, scanMember } from "./gzip.ts";
export { ArchiveError } from "../error.ts";
export { createArchiveLedger } from "../budget.ts";
export type { ArchiveErrorCodeType } from "../error.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../budget.ts";
export type { WarcFieldType } from "./header.ts";

/** How the records are stored in the source. */
export type WarcCompressionType = "none" | "gzip";

/** Physical stored record identity is its ordinal, never its potentially duplicate WARC ID. */
export interface WarcEntryType {
  readonly id: number;
  readonly version: "1.0" | "1.1";
  readonly recordId: string;
  readonly type: string;
  readonly date: string;
  /** Stored block length in bytes, from `Content-Length`. */
  readonly size: number;
  readonly fields: readonly WarcFieldType[];
  /** Revisit, segmented and unknown types remain inspectable but cannot be read. */
  readonly readable: boolean;
  /** The capture may omit bytes from its original resource even when framing is valid. */
  readonly truncated: string | undefined;
  /**
   * Where the record starts in the source. For `.warc.gz` this is the start of
   * its gzip member. CDXJ indexes call this `offset`.
   */
  readonly offset: number;
  /**
   * Source bytes the record uses: header, block and separator, or the whole
   * gzip member. CDXJ indexes call this `length`.
   */
  readonly length: number;
}

/** Finite metadata admission, independent of stored payload size. */
export interface WarcOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Maximum physical records. Default 10,000. */
  readonly maxEntries?: number;
  /** Maximum bytes in one header, including version and CRLFs. Default 64 KiB. */
  readonly maxHeaderBytes?: number;
  /** Maximum bytes in one physical line, excluding CRLF. Default 8 KiB. */
  readonly maxLineBytes?: number;
  /** Maximum fields in one record, excluding continuation lines. Default 128. */
  readonly maxFields?: number;
  /** Maximum cumulative header bytes retained as metadata. Default 4 MiB. */
  readonly maxMetadataBytes?: number;
}

/** A range of the stored block, which can include an entire embedded HTTP message. */
export interface WarcReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
}

/** Digesting is an explicit whole-block operation with no implicit global crypto acquisition. */
export interface WarcVerifyOptionsType extends ArchiveLimitsType {
  readonly subtle: Pick<SubtleCrypto, "digest">;
  readonly signal?: AbortSignal;
  /** Whole-block materialization ceiling, default 1 MiB, hard maximum 16 MiB. */
  readonly maxVerifyBytes?: number;
}

/** Stored bytes carry no content integrity evidence from framing alone. */
export interface WarcReadType {
  readonly bytes: Uint8Array;
  /**
   * `none` for a plain file. `gzip-member` for `.warc.gz`: the member's
   * CRC-32 was checked while decoding, which detects accidental corruption.
   */
  readonly integrity: "none" | "gzip-member";
  readonly work: ArchiveWorkType;
}

/** A matching stored-block digest detects corruption; it does not authenticate its author. */
export interface WarcVerificationType {
  readonly integrity: "stored-block-digest";
  readonly algorithm: "SHA-1" | "SHA-256";
  readonly work: ArchiveWorkType;
}

/** A borrowed immutable/provider/caller-stable source and a bounded eager physical index. */
export interface WarcArchiveType {
  readonly entries: readonly WarcEntryType[];
  /** `gzip` for a `.warc.gz` file with one record per member. */
  readonly compression: WarcCompressionType;
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  /**
   * Reads entry `id` into memory, within the archive limits and `options`.
   * @param id Entry ID from the archive index.
   * @param options Limits and cancellation for this read.
   */
  read(id: number, options?: WarcReadOptionsType): Promise<WarcReadType>;
  /**
   * Checks the block of record `id` against its `WARC-Block-Digest`.
   * @param id Record ID from the index.
   * @param options Limits, cancellation and the hash functions to use.
   */
  verifyBlock(id: number, options: WarcVerifyOptionsType): Promise<WarcVerificationType>;
}

const readableTypes = new Set(["warcinfo", "response", "resource", "request", "metadata", "conversion"]);

/** Index state for one record, private to the reader. */
interface SlotType {
  /** Plain: first block byte in the source. Gzip: first block byte in the decoded member. */
  readonly block: number;
}

/** Limits after defaults. */
interface LimitsType extends HeaderLimitsType {
  readonly maxEntries: number;
  readonly maxMetadataBytes: number;
}

/**
 * Index a WARC 1.0 or 1.1 file by exact byte lengths, without interpreting HTTP or following URLs.
 *
 * Plain files and `.warc.gz` files with one record per gzip member are both
 * supported; the first bytes decide which. A `.warc.gz` index decodes every
 * member once, so `maxDecodedBytes` must cover the uncompressed file. Gzip
 * decoding uses the host's `DecompressionStream`.
 *
 * ARC, logical segment assembly, revisit resolution and a file compressed as
 * one gzip member remain unsupported.
 *
 * @example List the responses in a `.warc.gz` file.
 * ```ts
 * import { createBlobSource } from "@okikio/opfs/source";
 * import { openWarc } from "@okikio/opfs/archive/warc";
 *
 * const archive = await openWarc(createBlobSource(file), { maxDecodedBytes: 512 * 1024 * 1024 });
 * for (const entry of archive.entries) {
 *   if (entry.type === "response") console.log(entry.offset, entry.length, entry.fields);
 * }
 * ```
 */
export async function openWarc(input: ByteSourceType, options: WarcOpenOptionsType = {}): Promise<WarcArchiveType> {
  // Retain the admitted source contract, not a caller's mutable descriptor object.
  const source: ByteSourceType = {
    size: input.size,
    ...(input.identity === undefined ? {} : { identity: input.identity }),
    ...(input.stability === undefined ? {} : { stability: input.stability }),
    read: input.read.bind(input),
  };
  if (!source.stability && !options.allowUnverifiedSource) {
    throw unsupported("WARC indexing requires declared source stability or explicit unverified-source acceptance.");
  }
  const budget = new ArchiveBudget(source, options, options.signal);
  const limits: LimitsType = {
    maxEntries: options.maxEntries ?? 10_000,
    maxHeaderBytes: options.maxHeaderBytes ?? 64 * 1024,
    maxLineBytes: options.maxLineBytes ?? 8 * 1024,
    maxFields: options.maxFields ?? 128,
    maxMetadataBytes: options.maxMetadataBytes ?? 4 * 1024 * 1024,
  };
  for (const [name, value] of Object.entries(limits)) assertInteger(value, name);
  if (source.size === 0) throw invalid("WARC requires at least one record.");
  const magic = await budget.read(0, Math.min(10, source.size));
  if (new TextDecoder().decode(magic).startsWith("filedesc:")) {
    throw unsupported("ARC requires a separate descriptor/framing reader.");
  }
  const compression: WarcCompressionType = isGzip(magic) ? "gzip" : "none";
  const entries: WarcEntryType[] = [];
  const slots: SlotType[] = [];
  let offset = 0;
  let metadata = 0;
  while (offset < source.size) {
    assertAtMost(entries.length + 1, limits.maxEntries, "WARC record count");
    const headerLimits = {
      ...limits,
      maxHeaderBytes: Math.min(limits.maxHeaderBytes, limits.maxMetadataBytes - metadata),
    };
    let header: HeaderType;
    let length: number;
    if (compression === "none") {
      // Lookahead is bounded and charged even when it includes stored block bytes.
      header = await parseHeader(
        source.size,
        offset,
        (at, count) => budget.read(at, count),
        headerLimits,
        (count) => budget.decoded(count),
      );
      if (header.size > source.size - header.end - 4) throw invalid("WARC block exceeds source extent.");
      if (!isSeparator(await budget.read(header.end + header.size, 4))) {
        throw invalid("WARC block requires its exact CRLFCRLF separator.");
      }
      length = header.end + header.size + 4 - offset;
      slots.push({ block: header.end });
    } else {
      const found = await scanMember(budget, source.size, offset, headerLimits.maxHeaderBytes);
      if (found === undefined) throw invalid("WARC gzip member is truncated or corrupt.");
      const { end, member } = found;
      // The decoded prefix holds at most maxHeaderBytes. A header that needs
      // more fails the byte limit before it reaches the end of the prefix.
      header = await parseHeader(
        member.bytes.length,
        0,
        async (at, count) => member.bytes.subarray(at, at + count),
        headerLimits,
      );
      const used = header.end + header.size + 4;
      if (used > member.size || (used === member.size && !isSeparator(member.tail))) {
        throw invalid("WARC block requires its exact CRLFCRLF separator.");
      }
      if (used < member.size) {
        throw unsupported(
          "A gzip member holds more than one WARC record. Random access needs one record per member; decompress the file first.",
        );
      }
      length = end - offset;
      slots.push({ block: header.end });
    }
    metadata += header.end - (compression === "none" ? offset : 0);
    assertAtMost(metadata, limits.maxMetadataBytes, "WARC retained metadata");
    const segmented = header.fields.some((field) => field.name.toLowerCase().startsWith("warc-segment-"));
    entries.push(Object.freeze({
      id: entries.length,
      version: header.version,
      recordId: header.recordId,
      type: header.type,
      date: header.date,
      size: header.size,
      fields: header.fields,
      readable: readableTypes.has(header.type) && !segmented,
      truncated: header.fields.find((field) => field.name.toLowerCase() === "warc-truncated")?.value,
      offset,
      length,
    }));
    offset += length;
  }
  function entryAt(id: number): WarcEntryType {
    assertInteger(id, "Record ordinal");
    const entry = entries[id];
    if (!entry) throw new RangeError("WARC record ordinal does not exist.");
    if (!entry.readable) throw unsupported("WARC revisit, segmented and unknown logical content is metadata-only.");
    return entry;
  }
  /** Reads `length` block bytes at `start` through one budget. */
  async function readBlock(
    work: ArchiveBudget,
    entry: WarcEntryType,
    start: number,
    length: number,
  ): Promise<Uint8Array> {
    const block = slots[entry.id]!.block;
    if (compression === "none") return await work.read(block + start, length);
    const member = await inflate(work, entry.offset, entry.offset + entry.length, block + start, length);
    // The index already accepted this member; a failure now means the source changed.
    if (member === undefined || member.bytes.length !== length) {
      throw invalid("WARC gzip member changed after it was indexed.");
    }
    return member.bytes;
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    compression,
    work: budget.inspect(),
    source: Object.freeze({
      ...(source.identity === undefined ? {} : { identity: source.identity }),
      stability: source.stability ?? "unverified",
    }),
    async read(id: number, readOptions: WarcReadOptionsType = {}): Promise<WarcReadType> {
      const entry = entryAt(id);
      const start = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - start;
      assertInteger(start, "Block offset");
      assertInteger(length, "Block length");
      if (start > entry.size || length > entry.size - start) {
        throw new RangeError("Requested range exceeds WARC block.");
      }
      const work = new ArchiveBudget(source, readOptions, readOptions.signal);
      work.output(length);
      // A plain read decodes only the requested bytes. A gzip read decodes the
      // member, which `inflate` charges as it goes.
      if (compression === "none") work.decoded(length);
      const bytes = await readBlock(work, entry, start, length);
      return { bytes, integrity: compression === "none" ? "none" : "gzip-member", work: work.inspect() };
    },
    async verifyBlock(id: number, verifyOptions: WarcVerifyOptionsType): Promise<WarcVerificationType> {
      const entry = entryAt(id);
      const maximum = verifyOptions.maxVerifyBytes ?? 1024 * 1024;
      assertInteger(maximum, "Verification byte limit");
      if (maximum > 16 * 1024 * 1024) throw new RangeError("Verification ceiling cannot exceed 16 MiB.");
      assertAtMost(entry.size, maximum, "WARC whole-block verification");
      const labelled = entry.fields.find((field) => field.name.toLowerCase() === "warc-block-digest")?.value;
      const match = /^(sha1|sha256):([A-Z2-7]+)$/.exec(labelled ?? "");
      if (
        !match || match[2]!.length !== (match[1] === "sha1" ? 32 : 52) ||
        (match[1] === "sha256" && !/[AQ]$/.test(match[2]!))
      ) {
        throw unsupported("Block verification requires canonical unpadded uppercase Base32 SHA1 or SHA256.");
      }
      const algorithm = match[1] === "sha1" ? "SHA-1" : "SHA-256";
      const work = new ArchiveBudget(source, verifyOptions, verifyOptions.signal);
      // No payload is returned: verifier allocation belongs to decoded work, not output.
      if (compression === "none") work.decoded(entry.size);
      const bytes = await readBlock(work, entry, 0, entry.size);
      const digest = new Uint8Array(await verifyOptions.subtle.digest(algorithm, new Uint8Array(bytes).buffer));
      verifyOptions.signal?.throwIfAborted();
      if (base32(digest) !== match[2]) {
        throw new ArchiveError("checksum-mismatch", "WARC stored-block digest mismatch.");
      }
      return { integrity: "stored-block-digest", algorithm, work: work.inspect() };
    },
  });
}
