import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** One TAR entry. Names and links are metadata, never automatically host paths. */
export interface TarEntryType {
  readonly id: number;
  readonly name: string;
  readonly size: number;
  readonly kind: "file" | "directory" | "symbolic-link" | "hard-link";
  readonly link: string;
  /** Present only for indexed GNU PAX sparse 1.0. `size` remains the logical size. */
  readonly sparse?: TarSparseType;
}

/** Physical payload layout. Stored offsets are relative to the bytes after the padded map. */
export interface TarSparseType {
  readonly profile: "gnu-pax-1.0";
  /** TAR payload bytes, including the padded map and physically recorded file data. */
  readonly storedSize: number;
  readonly mapBytes: number;
  readonly extents: readonly { readonly offset: number; readonly length: number; readonly storedOffset: number }[];
}

/** Header scanning is sequential; a random-access source can skip padded payload extents.
 * Opening byte/request limits also bound aggregate work across subsequent indexed reads. */
export interface TarOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Total nonzero headers, including extensions. Default 100,000. */
  readonly maxEntries?: number;
  /** Cumulative extension payload bytes; bounds persistent and pending metadata too. Default 1 MiB. */
  readonly maxMetadataBytes?: number;
  /** Aggregate sparse extent records, including zero-length records. Default 100,000. Indexed only. */
  readonly maxSparseExtents?: number;
  /** Aggregate logical bytes declared by sparse members. Default 64 MiB. Indexed only. */
  readonly maxSparseBytes?: number;
  /** Explicitly accepts mutation risk for a source without declared snapshot stability. */
  readonly allowUnverifiedSource?: boolean;
}

export interface TarReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
}

/** TAR has header checksums, not content checksums or authentication. */
export interface TarReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "header-checksum-only";
  readonly work: ArchiveWorkType;
}

/** The source remains borrowed; opening eagerly retains only bounded entry metadata. */
export interface TarArchiveType {
  readonly entries: readonly TarEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: TarReadOptionsType): Promise<TarReadType>;
}

/** Open uncompressed ustar/PAX, GNU long metadata, and indexed GNU PAX sparse 1.0 without following links. */
export async function openTar(input: ByteSourceType, supplied: TarOpenOptionsType = {}): Promise<TarArchiveType> {
  const options = { ...supplied };
  const { size, identity, stability } = input;
  integer(size, "TAR source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown TAR source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("TAR identity must be a bounded string.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("TAR index reads require declared source stability or explicit unverified-source acceptance.");
  }
  const source: ByteSourceType = {
    size,
    read: input.read.bind(input),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  const local = createArchiveLedger(options);
  const opening = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      local.reserve(kind, count);
      opening?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
  const budget = new ArchiveBudget(source, { ...options, ledger: lifetime }, options.signal);
  const parser = new TarHeaders(options, true);
  const entries: TarEntryType[] = [];
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const entry = await parser.next(async (length) => {
      const bytes = await budget.read(offset, length);
      offset += length;
      return bytes;
    }, (length) => budget.decoded(length));
    if (!entry) break;
    const storedSize = entry.sparse?.storedSize ?? entry.size;
    const paddedSize = tarPadding(storedSize) + storedSize - (entry.sparse?.mapBytes ?? 0);
    if (!Number.isSafeInteger(paddedSize) || paddedSize > source.size - offset) {
      invalid("TAR member exceeds source extent.");
    }
    entries.push(entry);
    offsets.push(offset);
    offset += paddedSize;
  }
  options.signal?.throwIfAborted();
  return Object.freeze({
    entries: Object.freeze(entries),
    work: budget.inspect(),
    source: Object.freeze({
      ...(identity === undefined ? {} : { identity }),
      stability: stability ?? "unverified",
    }),
    async read(id: number, supplied: TarReadOptionsType = {}): Promise<TarReadType> {
      const readOptions = { ...supplied };
      integer(id, "Entry ID");
      const entry = entries[id];
      if (!entry) throw new RangeError("TAR entry ID does not exist.");
      if (entry.kind !== "file") {
        unsupported("Only regular TAR member payloads can be read; links are never followed.");
      }
      const start = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - start;
      integer(start, "Member offset");
      integer(length, "Member length");
      if (start > entry.size || length > entry.size - start) {
        throw new RangeError("Requested range exceeds TAR member.");
      }
      const signal = options.signal && readOptions.signal
        ? AbortSignal.any([options.signal, readOptions.signal])
        : options.signal ?? readOptions.signal;
      signal?.throwIfAborted();
      const additional = readOptions.ledger;
      const target: ArchiveLedgerType = {
        reserve(kind, count) {
          lifetime.reserve(kind, count);
          if (additional && additional !== opening) additional.reserve(kind, count);
        },
        inspect: () => lifetime.inspect(),
      };
      const extents = entry.sparse?.extents ?? [{ offset: 0, length: entry.size, storedOffset: 0 }];
      let sourceBytes = 0;
      let requests = 0;
      for (const extent of extents) {
        const selected = Math.min(start + length, extent.offset + extent.length) - Math.max(start, extent.offset);
        if (selected > 0) {
          sourceBytes += selected;
          requests++;
        }
      }
      // Fully known physical costs are admitted before the selected buffer. Read
      // credits record actual work without charging the same aggregate owner twice.
      let sourceCredit = sourceBytes;
      let requestCredit = requests;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          if (kind === "sourceBytes" && count <= sourceCredit) sourceCredit -= count;
          else if (kind === "requests" && count <= requestCredit) requestCredit -= count;
          else target.reserve(kind, count);
        },
        inspect: () => target.inspect(),
      };
      const readBudget = new ArchiveBudget(source, { ...readOptions, ledger }, signal);
      if (sourceBytes > readBudget.limits.maxSourceBytes || requests > readBudget.limits.maxRequests) {
        throw new ArchiveError("budget-exceeded", "TAR selected physical work exceeds policy.");
      }
      readBudget.output(length);
      readBudget.decoded(length);
      target.reserve("sourceBytes", sourceBytes);
      target.reserve("requests", requests);
      signal?.throwIfAborted();
      const bytes = new Uint8Array(length);
      for (const extent of extents) {
        const from = Math.max(start, extent.offset);
        const to = Math.min(start + length, extent.offset + extent.length);
        if (to > from) {
          bytes.set(
            await readBudget.read(offsets[id]! + extent.storedOffset + (from - extent.offset), to - from),
            from - start,
          );
        }
      }
      signal?.throwIfAborted();
      return { bytes, integrity: "header-checksum-only", work: readBudget.inspect() };
    },
  });
}

/** @internal Shared framing state for indexed and one-shot readers; not a filesystem projection. */
export class TarHeaders {
  readonly #maximum: number;
  readonly #metadataMaximum: number;
  readonly #sparse: boolean;
  readonly #extentMaximum: number;
  readonly #logicalMaximum: number;
  #extents = 0;
  #logical = 0;
  #headers = 0;
  #entries = 0;
  #metadata = 0;
  #global = new Map<string, string>();
  #local = new Map<string, string>();
  #pending = false;

  constructor(
    options: Pick<TarOpenOptionsType, "maxEntries" | "maxMetadataBytes" | "maxSparseExtents" | "maxSparseBytes"> = {},
    sparse = false,
  ) {
    this.#maximum = options.maxEntries ?? 100_000;
    this.#metadataMaximum = options.maxMetadataBytes ?? 1024 * 1024;
    // One-shot consumers must opt into actual sparse reconstruction, not merely
    // accept metadata and accidentally expose the condensed physical payload.
    this.#sparse = sparse;
    this.#extentMaximum = options.maxSparseExtents ?? 100000;
    this.#logicalMaximum = options.maxSparseBytes ?? 64 * 1024 * 1024;
    integer(this.#maximum, "Header limit");
    integer(this.#metadataMaximum, "Metadata byte limit");
    integer(this.#extentMaximum, "Sparse extent limit");
    integer(this.#logicalMaximum, "Sparse logical byte limit");
  }

  /** The caller consumes each returned payload and its padding before requesting another header. */
  async next(
    read: (length: number) => Promise<Uint8Array>,
    decoded: (length: number) => void,
  ): Promise<TarEntryType | null> {
    while (true) {
      const header = await read(512);
      if (header.every((byte) => byte === 0)) {
        const second = await read(512);
        if (second.some((byte) => byte !== 0)) invalid("TAR end marker requires two zero blocks.");
        if (this.#pending) invalid("TAR extension has no following member.");
        return null;
      }
      if (this.#headers++ >= this.#maximum) throw new ArchiveError("budget-exceeded", "TAR header limit exceeded.");
      let checksum = 0;
      for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]!;
      if (octal(header.subarray(148, 156)) !== checksum) {
        throw new ArchiveError("checksum-mismatch", "TAR header checksum failed.");
      }
      const magic = header.subarray(257, 265);
      const posix = magic.every((byte, index) => byte === [117, 115, 116, 97, 114, 0, 48, 48][index]);
      const gnu = magic.every((byte, index) => byte === [117, 115, 116, 97, 114, 32, 32, 0][index]);
      if (!posix && !gnu) unsupported("Only POSIX ustar/PAX and GNU TAR headers are supported.");
      const type = header[156];
      if (type === 120 || type === 103 || type === 76 || type === 75) {
        const rawSize = octal(header.subarray(124, 136));
        if (rawSize > this.#metadataMaximum - this.#metadata) {
          throw new ArchiveError("budget-exceeded", "TAR metadata byte limit exceeded.");
        }
        this.#metadata += rawSize;
        decoded(rawSize);
        const payload = await read(rawSize);
        await read(tarPadding(rawSize));
        if (type === 120 || type === 103) {
          const values = pax(payload, this.#sparse && type === 120);
          const target = type === 103 ? this.#global : this.#local;
          for (const [key, value] of values) {
            if (type === 103 && value === "") target.delete(key);
            else target.set(key, value);
          }
          if (type === 120) this.#pending = true;
        } else {
          if (payload.length === 0 || payload[payload.length - 1] !== 0) invalid("GNU long metadata must end in NUL.");
          const value = text(payload.subarray(0, -1));
          if (payload.subarray(0, -1).includes(0)) invalid("GNU long metadata contains an embedded NUL.");
          this.#local.set(type === 76 ? "path" : "linkpath", value);
          this.#pending = true;
        }
        continue;
      }
      const kind = type === 0 || type === 48
        ? "file"
        : type === 53
        ? "directory"
        : type === 50
        ? "symbolic-link"
        : type === 49
        ? "hard-link"
        : undefined;
      if (!kind) unsupported("TAR sparse, device, FIFO, and other special members are unsupported.");
      const values = new Map(this.#global);
      for (const [key, value] of this.#local) {
        if (value === "") values.delete(key);
        else values.set(key, value);
      }
      this.#local.clear();
      this.#pending = false;
      const charset = values.get("hdrcharset");
      if (charset && charset !== "ISO-IR 10646 2000 UTF-8") unsupported("Non-UTF-8 PAX metadata is unsupported.");
      let name = values.get("path");
      if (name === undefined) {
        const prefix = posix ? text(header.subarray(345, 500)) : "";
        const suffix = text(header.subarray(0, 100));
        name = prefix ? `${prefix}/${suffix}` : suffix;
      }
      const link = values.get("linkpath") ?? text(header.subarray(157, 257));
      const sizeText = values.get("size");
      if (sizeText !== undefined && !/^[0-9]+$/.test(sizeText)) invalid("PAX size is not an unsigned decimal integer.");
      const size = sizeText === undefined ? octal(header.subarray(124, 136)) : Number(sizeText);
      if (!Number.isSafeInteger(size)) unsupported("PAX size exceeds exact JavaScript integers.");
      if (kind !== "file" && size !== 0) unsupported("Non-file TAR payloads, including linkdata, are unsupported.");
      if (!name || name.includes("\0") || link.includes("\0")) {
        invalid("TAR member metadata contains an empty name or NUL.");
      }
      const sparseKeys = [...values.keys()].filter((key) => key.startsWith("GNU.sparse."));
      if (sparseKeys.length) {
        if (
          kind !== "file" || values.get("GNU.sparse.major") !== "1" || values.get("GNU.sparse.minor") !== "0" ||
          sparseKeys.length !== 4 || !values.has("GNU.sparse.name") || !values.has("GNU.sparse.realsize")
        ) {
          unsupported("Only indexed GNU PAX sparse 1.0 regular files are supported.");
        }
        const sparseName = values.get("GNU.sparse.name")!;
        if (!sparseName || sparseName.includes("\0")) invalid("GNU sparse name is empty or contains NUL.");
        const logical = decimal(values.get("GNU.sparse.realsize")!);
        if (logical > this.#logicalMaximum - this.#logical) {
          throw new ArchiveError("budget-exceeded", "Sparse logical bytes exceed policy.");
        }
        this.#logical += logical;
        const sparse = await this.#map(read, decoded, size, logical);
        return Object.freeze({ id: this.#entries++, name: sparseName, size: logical, kind, link, sparse });
      }
      return Object.freeze({ id: this.#entries++, name, size, kind, link });
    }
  }

  /** Consume only the sparse map's padded metadata blocks. File data follows
   * them, so the indexed caller can skip it using the declared physical size. */
  async #map(
    read: (length: number) => Promise<Uint8Array>,
    decoded: (length: number) => void,
    storedSize: number,
    logicalSize: number,
  ): Promise<TarSparseType> {
    const extents: { readonly offset: number; readonly length: number; readonly storedOffset: number }[] = [];
    let count: number | undefined;
    let offset: number | undefined;
    let line = "";
    let mapBytes = 0;
    let recorded = 0;
    let previousEnd = 0;
    while (true) {
      if (512 > storedSize - mapBytes) invalid("GNU sparse map exceeds its declared physical payload.");
      if (512 > this.#metadataMaximum - this.#metadata) {
        throw new ArchiveError("budget-exceeded", "Sparse map metadata exceeds policy.");
      }
      this.#metadata += 512;
      decoded(512);
      const block = await read(512);
      mapBytes += 512;
      for (let at = 0; at < block.length; at++) {
        const byte = block[at]!;
        if (byte !== 10) {
          if (byte < 48 || byte > 57 || line.length === 20) invalid("GNU sparse map number is invalid or too long.");
          line += String.fromCharCode(byte);
          continue;
        }
        const number = decimal(line);
        line = "";
        if (count === undefined) {
          count = number;
          if (count > this.#extentMaximum - this.#extents) {
            throw new ArchiveError("budget-exceeded", "Sparse extent count exceeds policy.");
          }
          this.#extents += count;
        } else if (offset === undefined) offset = number;
        else {
          if (
            offset < previousEnd || offset > logicalSize || number > logicalSize - offset ||
            number > storedSize - recorded
          ) {
            invalid("GNU sparse map overlaps or exceeds logical/physical bounds.");
          }
          decoded(24);
          extents.push(Object.freeze({ offset, length: number, storedOffset: recorded }));
          previousEnd = offset + number;
          recorded += number;
          offset = undefined;
        }
        if (count !== undefined && extents.length === count) {
          if (block.subarray(at + 1).some((value) => value !== 0)) invalid("GNU sparse map padding is not zero.");
          if (recorded !== storedSize - mapBytes) {
            invalid("GNU sparse recorded sizes differ from the physical payload.");
          }
          return Object.freeze({ profile: "gnu-pax-1.0", storedSize, mapBytes, extents: Object.freeze(extents) });
        }
      }
    }
  }
}

/** TAR payloads align to 512-byte blocks without unsafe ceil/multiply arithmetic. @internal */
export function tarPadding(size: number): number {
  return (512 - size % 512) % 512;
}

/** Length prefixes count UTF-8 octets, not JavaScript characters. Unknown attributes are not filesystem authority. */
function pax(bytes: Uint8Array, sparse: boolean): Map<string, string> {
  const values = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space < 0 || space - offset > 16) invalid("PAX record length is missing or too large.");
    const digits = text(bytes.subarray(offset, space));
    if (!/^[1-9][0-9]*$/.test(digits)) invalid("PAX record length is invalid.");
    const length = Number(digits);
    if (!Number.isSafeInteger(length) || length > bytes.length - offset || length < space - offset + 4) {
      invalid("PAX record exceeds its payload.");
    }
    const end = offset + length;
    if (bytes[end - 1] !== 10) invalid("PAX record must end in newline.");
    const equal = bytes.indexOf(61, space + 1);
    if (equal <= space + 1 || equal >= end - 1) invalid("PAX record requires a key and equals sign.");
    const key = utf8(bytes.subarray(space + 1, equal));
    const value = utf8(bytes.subarray(equal + 1, end - 1));
    if (key.includes("\0") || value.includes("\0")) invalid("PAX metadata contains NUL.");
    if (
      /sparse/i.test(key) &&
        (!sparse ||
          !["GNU.sparse.major", "GNU.sparse.minor", "GNU.sparse.name", "GNU.sparse.realsize"].includes(key)) ||
      key === "SCHILY.filetype" || key === "SCHILY.realsize"
    ) {
      unsupported("Sparse and special-file PAX profiles are unsupported.");
    }
    if (key.startsWith("GNU.sparse.") && values.has(key)) invalid("Duplicate GNU sparse PAX key.");
    if (key.startsWith("GNU.sparse.") && !value) invalid("GNU sparse PAX value is empty.");
    values.set(key, value);
    offset = end;
  }
  return values;
}

/** Decimal fields have no signs, whitespace or rounded Number conversions. */
function decimal(text: string): number {
  if (!/^[0-9]+$/.test(text) || text.length > 20) invalid("GNU sparse decimal field is invalid.");
  const value = BigInt(text);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("GNU sparse integer exceeds exact JavaScript indexing.");
  return Number(value);
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    unsupported("Non-UTF-8 TAR metadata is unsupported.");
  }
}

/** NUL-terminated metadata is decoded without normalizing or projecting path components. */
function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? bytes : bytes.subarray(0, end));
  } catch {
    unsupported("Non-UTF-8 ustar names require a separately supported encoding profile.");
  }
}

/** Base-256 numeric extensions are not silently interpreted as POSIX octal. */
function octal(bytes: Uint8Array): number {
  if (bytes[0]! & 128) unsupported("Base-256 TAR numeric fields are unsupported.");
  const raw = text(bytes).trim();
  if (!/^[0-7]+$/.test(raw)) invalid("TAR numeric field is not octal.");
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value)) unsupported("TAR size exceeds exact JavaScript integers.");
  return value;
}
