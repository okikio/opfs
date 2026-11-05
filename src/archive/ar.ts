/** Bounded normal GNU/SVR4 and BSD ar indexing with exact member ranges. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Physical archive-order identity. Metadata records are not interpreted as linker structures. */
export interface ArEntryType {
  readonly id: number;
  readonly name: string;
  readonly kind: "file" | "name-table" | "symbol-table";
  readonly format: "short" | "gnu" | "bsd";
  readonly headerOffset: number;
  /** Payload begins after any BSD inline filename bytes. */
  readonly offset: number;
  readonly size: number;
  /** Serialized body size includes the BSD name; alignment padding is separate. */
  readonly storedSize: number;
  /** Unix seconds. Blank metadata fields remain absent, not fabricated zeroes. */
  readonly mtime?: number;
  readonly uid?: number;
  readonly gid?: number;
  readonly mode?: number;
}
/** Index admission bounds. All member headers, including special records, count. */
export interface ArOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default 100,000. */
  readonly maxEntries?: number;
  /** Encoded bytes in one name, including BSD trailing NUL alignment. Default 64 KiB. */
  readonly maxNameBytes?: number;
  /** Aggregate logical UTF-8 bytes of admitted names, including table and references. Default 1 MiB. */
  readonly maxNamesBytes?: number;
  /** Maximum GNU // table body. Default 1 MiB. One table is admitted before ordinary files. */
  readonly maxTableBytes?: number;
  /** Default false. Identity alone is not evidence of source stability. */
  readonly allowUnverifiedSource?: boolean;
}
/** Exact selected output; this archive format supplies no payload checksum. */
export interface ArReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
}
/** Owned bytes and actual per-read logical work. No format checksum or authentication is implied. */
export interface ArReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "none";
  readonly work: ArchiveWorkType;
}
/** Aggregate limits apply across reads from one returned source. Cancellation stays caller-owned. */
export interface ArMemberOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** Immutable index borrowing a captured source snapshot; no host paths are accessed. */
export interface ArArchiveType {
  readonly entries: readonly ArEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: ArReadOptionsType): Promise<ArReadType>;
  /** Borrow an exact member extent for nested readers. Names never become source identities or host paths. */
  member(id: number, options?: ArMemberOptionsType): ByteSourceType;
}

/** Reject valid-prefix parsing, negative values and precision loss before using an extent. */
function numberOf(bytes: Uint8Array, base: number, optional = false): number | undefined {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 32) end--;
  if (end === 0) {
    if (optional) return undefined;
    invalid("ar member size or name reference is missing.");
  }
  let value = 0n;
  for (const byte of bytes.subarray(0, end)) {
    const digit = byte - 48;
    if (digit < 0 || digit >= base) invalid("ar numeric field contains invalid digits or padding.");
    value = value * BigInt(base) + BigInt(digit);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("ar integer exceeds exact JavaScript indexing.");
  return Number(value);
}

/** Materialized names have a separate admission owner from source-byte work. */
class Names {
  readonly one: number;
  readonly total: number;
  #used = 0;
  constructor(options: ArOpenOptionsType) {
    this.one = options.maxNameBytes ?? 65536;
    this.total = options.maxNamesBytes ?? 1024 * 1024;
    integer(this.one, "maxNameBytes");
    integer(this.total, "maxNamesBytes");
  }
  admit(size: number): void {
    if (size > this.one || size > this.total - this.#used) {
      throw new ArchiveError("budget-exceeded", "ar name admission limit exceeded.");
    }
    this.#used += size;
  }
  decode(bytes: Uint8Array): string {
    this.admit(bytes.length);
    if (bytes.length === 0 || bytes.some((byte) => byte === 0 || byte === 10 || byte === 13)) {
      invalid("ar name is empty or contains a forbidden separator byte.");
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return unsupported("ar names require valid UTF-8 for this profile.");
    }
  }
}

/** Fixed-field padding is ASCII space; unlike trim(), this never erases name bytes from other encodings. */
function trim(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 32) end--;
  return bytes.subarray(0, end);
}

/** The symbol payload is deliberately opaque; only its physical extent and conventional marker are indexed. */
function kindOf(name: string): ArEntryType["kind"] {
  if (name === "//") return "name-table";
  if (["/", "/SYM64/", "__.SYMDEF", "__.SYMDEF SORTED", "__.SYMDEF_64", "__.SYMDEF_64 SORTED"].includes(name)) {
    return "symbol-table";
  }
  return "file";
}

/** Open one normal physical ar file. Thin/external references are refused before reading any referenced paths. */
export async function openAr(source: ByteSourceType, options: ArOpenOptionsType = {}): Promise<ArArchiveType> {
  const { size, identity, stability } = source;
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("ar requires source stability or explicit unverified-source acceptance.");
  }
  const snapshot: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: source.read.bind(source),
  };
  const budget = new ArchiveBudget(snapshot, options, options.signal);
  const maxEntries = options.maxEntries ?? 100000;
  const maxTableBytes = options.maxTableBytes ?? 1024 * 1024;
  integer(maxEntries, "maxEntries");
  integer(maxTableBytes, "maxTableBytes");
  const names = new Names(options);
  const magic = await budget.read(0, 8);
  budget.decoded(8);
  const signature = String.fromCharCode(...magic);
  if (signature === "!<thin>\n") unsupported("Thin ar archives refer to external files and are unsupported.");
  if (signature !== "!<arch>\n") invalid("Normal ar signature must begin at offset zero.");
  const entries: ArEntryType[] = [];
  let at = 8;
  let table: Map<number, { name: string; bytes: number }> | undefined;
  let ordinary = false;
  while (at < size) {
    options.signal?.throwIfAborted();
    if (entries.length >= maxEntries) throw new ArchiveError("budget-exceeded", "ar entry admission limit exceeded.");
    if (size - at < 60) invalid("ar member header is truncated or trailing bytes remain.");
    const header = await budget.read(at, 60);
    budget.decoded(60);
    if (header[58] !== 96 || header[59] !== 10) invalid("ar member header requires backtick and linefeed terminator.");
    const storedSize = numberOf(header.subarray(48, 58), 10)!;
    const body = at + 60;
    if (storedSize > size - body) invalid("ar member extends past the source snapshot.");
    const end = body + storedSize;
    if (storedSize % 2) {
      if (end === size) invalid("ar odd member requires a final linefeed padding byte.");
      const padding = await budget.read(end, 1);
      budget.decoded(1);
      if (padding[0] !== 10) invalid("ar alignment padding is not a linefeed.");
    }
    const raw = trim(header.subarray(0, 16));
    const marker = String.fromCharCode(...raw);
    let name: string;
    let offset = body;
    let memberSize = storedSize;
    let format: ArEntryType["format"] = "short";
    if (marker === "//") {
      if (table || ordinary) unsupported("ar supports one GNU name table before ordinary members.");
      if (storedSize > maxTableBytes) {
        throw new ArchiveError("budget-exceeded", "ar GNU name table admission limit exceeded.");
      }
      const bytes = await budget.read(body, storedSize);
      budget.decoded(storedSize);
      table = new Map();
      for (let start = 0; start < bytes.length;) {
        // GNU/LLVM writers count one final LF alignment byte inside the table body size.
        if (start === bytes.length - 1 && bytes[start] === 10) break;
        let until = start;
        while (until < bytes.length && bytes[until] !== 10) until++;
        if (until === bytes.length || until === start || bytes[until - 1] !== 47) {
          invalid("ar GNU name table requires slash-linefeed records.");
        }
        if (table.size >= maxEntries) {
          throw new ArchiveError("budget-exceeded", "ar GNU name record admission limit exceeded.");
        }
        const encoded = bytes.subarray(start, until - 1);
        table.set(start, { name: names.decode(encoded), bytes: encoded.length });
        start = until + 1;
      }
      name = "//";
      names.admit(2);
      format = "gnu";
    } else if (marker.startsWith("#1/")) {
      format = "bsd";
      const length = numberOf(raw.subarray(3), 10)!;
      if (length > storedSize) invalid("ar BSD name exceeds its stored member body.");
      if (length > names.one) throw new ArchiveError("budget-exceeded", "ar BSD encoded name limit exceeded.");
      const encoded = await budget.read(body, length);
      budget.decoded(length);
      let end = encoded.length;
      while (end > 0 && encoded[end - 1] === 0) end--;
      names.admit(length - end);
      name = names.decode(encoded.subarray(0, end));
      offset += length;
      memberSize -= length;
    } else if (marker === "/" || marker === "/SYM64/") {
      name = marker;
      names.admit(raw.length);
      format = "gnu";
    } else if (marker.startsWith("/")) {
      format = "gnu";
      const reference = numberOf(raw.subarray(1), 10)!;
      const found = table?.get(reference);
      if (!found) invalid("ar GNU name reference does not point to an admitted record start.");
      names.admit(found.bytes);
      name = found.name;
    } else {
      const encoded = raw[raw.length - 1] === 47 ? raw.subarray(0, -1) : raw;
      name = names.decode(encoded);
    }
    const kind = kindOf(name);
    if (kind === "file") ordinary = true;
    // Symbol/name table fields may be blank; ordinary file metadata uses the same explicit absent representation.
    const mtime = numberOf(header.subarray(16, 28), 10, true);
    const uid = numberOf(header.subarray(28, 34), 10, true);
    const gid = numberOf(header.subarray(34, 40), 10, true);
    const mode = numberOf(header.subarray(40, 48), 8, true);
    entries.push(
      Object.freeze({
        id: entries.length,
        name,
        kind,
        format,
        headerOffset: at,
        offset,
        size: memberSize,
        storedSize,
        ...(mtime === undefined ? {} : { mtime }),
        ...(uid === undefined ? {} : { uid }),
        ...(gid === undefined ? {} : { gid }),
        ...(mode === undefined ? {} : { mode }),
      }),
    );
    at = end + storedSize % 2;
  }

  const entryOf = (id: number): ArEntryType => {
    integer(id, "Entry ID");
    const entry = entries[id];
    if (!entry) throw new RangeError("ar entry ID does not exist.");
    if (entry.kind !== "file") unsupported("ar linker/name metadata is opaque and cannot be read as an ordinary file.");
    return entry;
  };
  const read = async (id: number, readOptions: ArReadOptionsType = {}): Promise<ArReadType> => {
    const entry = entryOf(id);
    const offset = readOptions.offset ?? 0;
    const length = readOptions.length ?? entry.size - offset;
    integer(offset, "Member offset");
    integer(length, "Member length");
    if (offset > entry.size || length > entry.size - offset) {
      throw new RangeError("ar member read exceeds its payload.");
    }
    const work = new ArchiveBudget(snapshot, readOptions, readOptions.signal);
    if (length > work.limits.maxSourceBytes || Math.ceil(length / 65536) > work.limits.maxRequests) {
      throw new ArchiveError("budget-exceeded", "ar selected range exceeds source work limits.");
    }
    work.output(length);
    work.decoded(length);
    readOptions.signal?.throwIfAborted();
    const bytes = new Uint8Array(length);
    for (let at = 0; at < length;) {
      const count = Math.min(65536, length - at);
      bytes.set(await work.read(entry.offset + offset + at, count), at);
      at += count;
    }
    return { bytes, integrity: "none", work: work.inspect() };
  };
  return Object.freeze({
    entries: Object.freeze(entries),
    work: budget.inspect(),
    source: Object.freeze({ ...(identity === undefined ? {} : { identity }), stability: stability ?? "unverified" }),
    read,
    member(id: number, memberOptions: ArMemberOptionsType = {}): ByteSourceType {
      const entry = entryOf(id);
      const { signal, ...limits } = memberOptions;
      const ledger = limits.ledger ?? createArchiveLedger(limits);
      return Object.freeze({
        size: entry.size,
        ...(identity === undefined
          ? {}
          : { identity: JSON.stringify(["opfs/ar", identity, entry.offset, entry.size]) }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
          const active = signal && options.signal
            ? AbortSignal.any([signal, options.signal])
            : signal ?? options.signal;
          return (await read(id, {
            ...limits,
            ledger,
            offset,
            length,
            ...(active === undefined ? {} : { signal: active }),
          })).bytes;
        },
      });
    },
  });
}
