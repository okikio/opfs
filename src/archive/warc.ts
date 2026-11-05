import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** An ordered field with its original name and unfolded, whitespace-trimmed value. */
export interface WarcFieldType {
  readonly name: string;
  readonly value: string;
}

/** Physical stored record identity is its ordinal, never its potentially duplicate WARC ID. */
export interface WarcEntryType {
  readonly id: number;
  readonly version: "1.0" | "1.1";
  readonly recordId: string;
  readonly type: string;
  readonly date: string;
  readonly size: number;
  readonly fields: readonly WarcFieldType[];
  /** Revisit, segmented and unknown types remain inspectable but cannot be read. */
  readonly readable: boolean;
  /** The capture may omit bytes from its original resource even when framing is valid. */
  readonly truncated: string | undefined;
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
  readonly integrity: "none";
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
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: WarcReadOptionsType): Promise<WarcReadType>;
  verifyBlock(id: number, options: WarcVerifyOptionsType): Promise<WarcVerificationType>;
}

/** Core 1.0/1.1 singleton fields; unknown extension fields have no invented repetition policy. */
const singletons = new Set([
  "warc-record-id",
  "content-length",
  "warc-date",
  "warc-type",
  "content-type",
  "warc-block-digest",
  "warc-payload-digest",
  "warc-ip-address",
  "warc-refers-to",
  "warc-refers-to-target-uri",
  "warc-refers-to-date",
  "warc-target-uri",
  "warc-truncated",
  "warc-warcinfo-id",
  "warc-filename",
  "warc-profile",
  "warc-identified-payload-type",
  "warc-segment-origin-id",
  "warc-segment-number",
  "warc-segment-total-length",
]);
const readableTypes = new Set(["warcinfo", "response", "resource", "request", "metadata", "conversion"]);
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Index uncompressed WARC1.0/1.1 by exact byte lengths, without interpreting HTTP or following URLs.
 * Gzip, ARC, logical segment assembly and revisit resolution are separate unsupported profiles.
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
    unsupported("WARC indexing requires declared source stability or explicit unverified-source acceptance.");
  }
  const budget = new ArchiveBudget(source, options, options.signal);
  const limits = {
    maxEntries: options.maxEntries ?? 10_000,
    maxHeaderBytes: options.maxHeaderBytes ?? 64 * 1024,
    maxLineBytes: options.maxLineBytes ?? 8 * 1024,
    maxFields: options.maxFields ?? 128,
    maxMetadataBytes: options.maxMetadataBytes ?? 4 * 1024 * 1024,
  };
  for (const [name, value] of Object.entries(limits)) integer(value, name);
  if (source.size === 0) invalid("WARC requires at least one record.");
  const magic = await budget.read(0, Math.min(10, source.size));
  if (magic[0] === 31 && magic[1] === 139) unsupported("Gzip WARC requires a separate bounded member index.");
  if (new TextDecoder().decode(magic).startsWith("filedesc:")) {
    unsupported("ARC requires a separate descriptor/framing reader.");
  }
  const entries: WarcEntryType[] = [];
  const offsets: number[] = [];
  let offset = 0;
  let metadata = 0;
  while (offset < source.size) {
    cap(entries.length + 1, limits.maxEntries, "WARC record count");
    // Lookahead is bounded and charged even when it includes stored block bytes.
    const lines = new WarcLines(
      source.size,
      offset,
      budget,
      Math.min(limits.maxHeaderBytes, limits.maxMetadataBytes - metadata),
      limits.maxLineBytes,
    );
    const versionLine = await lines.next();
    if (versionLine !== "WARC/1.0" && versionLine !== "WARC/1.1") {
      unsupported("Expected uncompressed WARC1.0/1.1; ARC, gzip and other wrappers are unsupported.");
    }
    const fields: { name: string; value: string }[] = [];
    const seen = new Set<string>();
    while (true) {
      const line = await lines.next();
      if (!line) break;
      if (/^[ \t]/.test(line)) {
        const previous = fields[fields.length - 1];
        if (!previous) invalid("WARC continuation has no preceding field.");
        previous.value += ` ${line.replace(/^[ \t]+|[ \t]+$/g, "")}`;
        continue;
      }
      cap(fields.length + 1, limits.maxFields, "WARC field count");
      const colon = line.indexOf(":");
      const name = line.slice(0, colon);
      if (colon < 1 || !token.test(name)) invalid("Invalid WARC field name.");
      const key = name.toLowerCase();
      if (singletons.has(key) && seen.has(key)) invalid("Duplicate singleton WARC field.");
      seen.add(key);
      fields.push({ name, value: line.slice(colon + 1).replace(/^[ \t]+|[ \t]+$/g, "") });
    }
    // Folding can introduce outer LWS when the first value line was empty.
    for (const field of fields) field.value = field.value.replace(/^[ \t]+|[ \t]+$/g, "");
    metadata += lines.offset - offset;
    cap(metadata, limits.maxMetadataBytes, "WARC retained metadata");
    const value = (name: string): string | undefined =>
      fields.find((field) => field.name.toLowerCase() === name)?.value;
    const recordId = value("warc-record-id");
    const type = value("warc-type");
    const date = value("warc-date");
    const length = value("content-length");
    if (!recordId || !/^<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+>$/.test(recordId)) {
      invalid("Invalid or missing WARC record ID.");
    }
    if (!type || !token.test(type) || !date) invalid("Missing WARC type or date.");
    if (length === undefined || !/^\d+$/.test(length)) invalid("Invalid or missing WARC Content-Length.");
    const size = Number(length);
    if (!Number.isSafeInteger(size) || size > source.size - lines.offset - 4) {
      invalid("WARC block exceeds source extent.");
    }
    const separator = await budget.read(lines.offset + size, 4);
    if (separator[0] !== 13 || separator[1] !== 10 || separator[2] !== 13 || separator[3] !== 10) {
      invalid("WARC block requires its exact CRLFCRLF separator.");
    }
    const segmented = fields.some((field) => field.name.toLowerCase().startsWith("warc-segment-"));
    entries.push(Object.freeze({
      id: entries.length,
      version: versionLine === "WARC/1.0" ? "1.0" : "1.1",
      recordId,
      type,
      date,
      size,
      fields: Object.freeze(fields.map((field) => Object.freeze(field))),
      readable: readableTypes.has(type) && !segmented,
      truncated: value("warc-truncated"),
    }));
    offsets.push(lines.offset);
    offset = lines.offset + size + 4;
  }
  function entryAt(id: number): WarcEntryType {
    integer(id, "Record ordinal");
    const entry = entries[id];
    if (!entry) throw new RangeError("WARC record ordinal does not exist.");
    if (!entry.readable) unsupported("WARC revisit, segmented and unknown logical content is metadata-only.");
    return entry;
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    work: budget.inspect(),
    source: Object.freeze({
      ...(source.identity === undefined ? {} : { identity: source.identity }),
      stability: source.stability ?? "unverified",
    }),
    async read(id: number, readOptions: WarcReadOptionsType = {}): Promise<WarcReadType> {
      const entry = entryAt(id);
      const start = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - start;
      integer(start, "Block offset");
      integer(length, "Block length");
      if (start > entry.size || length > entry.size - start) {
        throw new RangeError("Requested range exceeds WARC block.");
      }
      const work = new ArchiveBudget(source, readOptions, readOptions.signal);
      work.output(length);
      work.decoded(length);
      const bytes = await work.read(offsets[id]! + start, length);
      return { bytes, integrity: "none", work: work.inspect() };
    },
    async verifyBlock(id: number, verifyOptions: WarcVerifyOptionsType): Promise<WarcVerificationType> {
      const entry = entryAt(id);
      const maximum = verifyOptions.maxVerifyBytes ?? 1024 * 1024;
      integer(maximum, "Verification byte limit");
      if (maximum > 16 * 1024 * 1024) throw new RangeError("Verification ceiling cannot exceed 16 MiB.");
      cap(entry.size, maximum, "WARC whole-block verification");
      const labelled = entry.fields.find((field) => field.name.toLowerCase() === "warc-block-digest")?.value;
      const match = /^(sha1|sha256):([A-Z2-7]+)$/.exec(labelled ?? "");
      if (
        !match || match[2]!.length !== (match[1] === "sha1" ? 32 : 52) ||
        (match[1] === "sha256" && !/[AQ]$/.test(match[2]!))
      ) {
        unsupported("Block verification requires canonical unpadded uppercase Base32 SHA1 or SHA256.");
      }
      const algorithm = match[1] === "sha1" ? "SHA-1" : "SHA-256";
      const work = new ArchiveBudget(source, verifyOptions, verifyOptions.signal);
      // No payload is returned: verifier allocation belongs to decoded work, not output.
      work.decoded(entry.size);
      const bytes = await work.read(offsets[id]!, entry.size);
      const digest = new Uint8Array(await verifyOptions.subtle.digest(algorithm, new Uint8Array(bytes).buffer));
      verifyOptions.signal?.throwIfAborted();
      if (base32(digest) !== match[2]) {
        throw new ArchiveError("checksum-mismatch", "WARC stored-block digest mismatch.");
      }
      return { integrity: "stored-block-digest", algorithm, work: work.inspect() };
    },
  });
}

/** Bounded per-record lookahead; Content-Length later skips the block rather than scanning delimiters inside it. */
class WarcLines {
  offset: number;
  readonly #start: number;
  readonly #size: number;
  readonly #budget: ArchiveBudget;
  readonly #headerMaximum: number;
  readonly #lineMaximum: number;
  #chunk: Uint8Array = new Uint8Array();
  #index = 0;

  constructor(size: number, offset: number, budget: ArchiveBudget, headerMaximum: number, lineMaximum: number) {
    this.offset = this.#start = offset;
    this.#size = size;
    this.#budget = budget;
    this.#headerMaximum = headerMaximum;
    this.#lineMaximum = lineMaximum;
  }

  async #byte(): Promise<number> {
    cap(this.offset - this.#start + 1, this.#headerMaximum, "WARC header bytes");
    if (this.offset >= this.#size) invalid("Truncated WARC header.");
    if (this.#index === this.#chunk.length) {
      this.#chunk = await this.#budget.read(
        this.offset,
        Math.min(1024, this.#size - this.offset, this.#headerMaximum - (this.offset - this.#start)),
      );
      this.#index = 0;
    }
    this.offset++;
    this.#budget.decoded(1);
    return this.#chunk[this.#index++]!;
  }

  async next(): Promise<string> {
    const bytes: number[] = [];
    while (true) {
      const byte = await this.#byte();
      if (byte === 13) {
        if (await this.#byte() !== 10) invalid("WARC header requires CRLF lines.");
        try {
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
        } catch {
          invalid("WARC header contains invalid UTF8.");
        }
      }
      if ((byte < 32 && byte !== 9) || byte === 127) invalid("WARC header contains a control byte.");
      cap(bytes.length + 1, this.#lineMaximum, "WARC line bytes");
      bytes.push(byte);
    }
  }
}

function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}

/** RFC4648 Base32 with no padding; SHA256 admission separately requires four zero trailing bits. */
function base32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let accumulator = 0;
  let bits = 0;
  let result = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits) result += alphabet[(accumulator << (5 - bits)) & 31];
  return result;
}
