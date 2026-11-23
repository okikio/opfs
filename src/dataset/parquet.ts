/** Bounded physical numeric Parquet previews over a borrowed stable byte source. @module */
import type { ByteSourceType } from "../source.ts";
import {
  ArchiveBudget,
  ArchiveError,
  crc32,
  createArchiveLedger,
  integer,
  invalid,
  unsupported,
  view,
} from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Opening authority remains active for every later read. All caps are finite admission limits. */
export interface ParquetOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 8 MiB of serialized footer bytes, admitted before its owned copy. */
  readonly maxFooterBytes?: number;
  /** Default: 64 KiB of lookahead per page header. Repeated lookahead counts as source work. */
  readonly maxPageHeaderBytes?: number;
  /** Default: 8 MiB for each selected, uncompressed page body. */
  readonly maxPageBytes?: number;
  /** Default: 1,024 flat leaf columns. Nested/repeated schemas are refused. */
  readonly maxColumns?: number;
  /** Default: 4,096 row groups in the footer. */
  readonly maxRowGroups?: number;
  /** Default: 1,048,576 Compact fields, collection elements and varint bytes per operation. */
  readonly maxCompactValues?: number;
  /** Default: 32 nested Compact structs/containers, including skipped unknown fields. */
  readonly maxDepth?: number;
  /** Default: 65,536 bytes per Compact binary/string field, including skipped fields. */
  readonly maxStringBytes?: number;
  /** Default: 8 MiB of retained strings and conservative index/page descriptor allowances. */
  readonly maxRetainedMetadataBytes?: number;
  /** Default: 65,536 page headers scanned across the selected column's intersecting row groups. */
  readonly maxPages?: number;
  /** Default: 1,048,576 rows returned by one read; this does not limit file row count. */
  readonly maxRows?: number;
  /** Default: false. An identity alone is not stable replay evidence. */
  readonly allowUnverifiedSource?: boolean;
}

/** Row ranges are zero-based; omitted length means the remaining rows, subject to output limits. */
export interface ParquetReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  /** Composes with the opening signal; it cannot revoke the opening owner's cancellation. */
  readonly signal?: AbortSignal;
}

/** Physical values, including identity signed INT32/INT64 annotations. Other logical conversions are refused. */
export interface ParquetColumnType {
  readonly id: number;
  readonly name: string;
  readonly physical: number;
  readonly optional: boolean;
  readonly readable: boolean;
  readonly reason?: string;
}

/** Footer row counts are validated against each other, not proof that unread pages contain those rows. */
export interface ParquetRowGroupType {
  readonly id: number;
  readonly offset: number;
  readonly rows: number;
}

/** A CRC covers only this stored page body. Headers, footer and publisher identity are unauthenticated.
 * `not-read` means the body was not fully acquired or CRC checked; bounded
 * header lookahead can still fetch a prefix of that body's physical bytes.
 */
export interface ParquetPageEvidenceType {
  readonly rowGroup: number;
  /** Physical byte offset of the page header. The body CRC excludes that header. */
  readonly offset: number;
  readonly rows: number;
  readonly selected: boolean;
  readonly checksum: "crc32-verified" | "not-provided" | "not-read";
}

/** INT64 uses bigint; BOOLEAN uses 0/1 bytes. Null slots are zero and require the separate validity mask. */
export type ParquetValuesType = Uint8Array | Int32Array | BigInt64Array | Float32Array | Float64Array;

/** Owned output. IEEE values are preserved, without a NaN payload bit-identity guarantee. */
export interface ParquetReadType {
  readonly values: ParquetValuesType;
  readonly validity: Uint8Array;
  readonly pages: readonly ParquetPageEvidenceType[];
  readonly integrity: "selected-pages";
  readonly work: ArchiveWorkType;
}

/** No source ownership is transferred and no file paths, codecs, queries or mounts are opened. */
export interface ParquetDatasetType {
  readonly rows: number;
  readonly columns: readonly ParquetColumnType[];
  readonly rowGroups: readonly ParquetRowGroupType[];
  readonly integrity: "metadata-unverified";
  readonly work: ArchiveWorkType;
  read(column: number, options?: ParquetReadOptionsType): Promise<ParquetReadType>;
}

interface PolicyType {
  footer: number;
  header: number;
  page: number;
  columns: number;
  groups: number;
  compact: number;
  depth: number;
  string: number;
  retained: number;
  pages: number;
  rows: number;
}

/** This private EOF distinguishes bounded lookahead from malformed non-EOF grammar. */
class NeedMore extends Error {}

/** Operation-owned counters also bound skipped metadata and repeated header parsing. */
class Meter {
  #compact = 0;
  #retained = 0;
  readonly policy: PolicyType;
  readonly signal: AbortSignal | undefined;
  constructor(policy: PolicyType, signal?: AbortSignal) {
    this.policy = policy;
    this.signal = signal;
  }
  step(count = 1): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.compact - this.#compact) limit("Compact work");
    this.#compact += count;
  }
  retain(count: number): void {
    if (count > this.policy.retained - this.#retained) limit("Retained metadata");
    this.#retained += count;
  }
}

function limit(label: string): never {
  throw new ArchiveError("budget-exceeded", `Parquet ${label} limit exceeded.`);
}

/** Sizes and offsets are nonnegative exact integers. Signed values remain bigint until admitted. */
function exact(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(`Parquet ${label} is outside exact nonnegative integers.`);
  }
  return Number(value);
}

/** Struct callbacks retain only fields this profile needs; unknown fields still receive complete bounded validation. */
class Compact {
  readonly bytes: Uint8Array;
  readonly meter: Meter;
  at = 0;
  #depth = 0;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.bytes = bytes;
    this.meter = meter;
  }
  byte(): number {
    if (this.at === this.bytes.length) throw new NeedMore();
    return this.bytes[this.at++]!;
  }
  take(length: number): Uint8Array {
    if (length > this.bytes.length - this.at) throw new NeedMore();
    const bytes = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return bytes;
  }
  uint(bits = 32): bigint {
    let value = 0n;
    for (let shift = 0; shift < bits; shift += 7) {
      this.meter.step();
      const byte = this.byte();
      value |= BigInt(byte & 127) << BigInt(shift);
      if (value >= 1n << BigInt(bits)) invalid("Parquet Compact integer exceeds its declared width.");
      if (byte < 128) return value;
    }
    invalid("Parquet Compact varint has no terminator within its width.");
  }
  signed(bits: number): bigint {
    const value = this.uint(bits);
    return (value >> 1n) ^ -(value & 1n);
  }
  type(actual: number, expected: number): void {
    if (actual !== expected) invalid("Parquet Compact field type mismatch.");
  }
  number(type: number, bits = 32): number {
    this.type(type, bits === 64 ? 6 : bits === 16 ? 4 : 5);
    return exact(this.signed(bits), "integer field");
  }
  bool(type: number): boolean {
    if (type !== 1 && type !== 2) invalid("Parquet Compact boolean field type mismatch.");
    return type === 1;
  }
  text(type: number, retain = true): string {
    this.type(type, 8);
    const length = Number(this.uint());
    if (length > 0x7fffffff) invalid("Parquet Compact binary length exceeds signed int32.");
    if (length > this.meter.policy.string) limit("String byte");
    if (retain) this.meter.retain(length * 2);
    const bytes = this.take(length);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid("Parquet metadata string is not UTF-8.");
    }
  }
  nest<T>(body: () => T): T {
    if (++this.#depth > this.meter.policy.depth) limit("Compact depth");
    try {
      return body();
    } finally {
      this.#depth--;
    }
  }
  fields(known: Readonly<Record<number, (type: number) => void>>, observe?: () => void): void {
    this.nest(() => {
      let previous = 0;
      const seen = new Set<number>();
      for (;;) {
        this.meter.step();
        const header = this.byte();
        if (header === 0) return;
        const type = header & 15;
        if (type === 0 || type > 13) invalid("Parquet Compact field type is invalid.");
        const delta = header >>> 4;
        const id = delta === 0 ? Number(this.signed(16)) : previous + delta;
        if (id < -32768 || id > 32767 || seen.has(id)) invalid("Parquet Compact field ID is invalid or repeated.");
        this.meter.retain(16);
        seen.add(id);
        observe?.();
        previous = id;
        const read = Object.hasOwn(known, id) ? known[id] : undefined;
        if (read) read(type);
        else this.skip(type, true);
      }
    });
  }
  list<T>(type: number, element: number, maximum: number, read: () => T): T[] {
    this.type(type, 9);
    return this.nest(() => {
      const header = this.byte(), tag = header & 15;
      const count = header >>> 4 === 15 ? Number(this.uint()) : header >>> 4;
      if (count > 0x7fffffff) invalid("Parquet Compact list size exceeds signed int32.");
      if (tag !== element) invalid("Parquet Compact list element type mismatch.");
      if (count > maximum) limit("Collection count");
      this.meter.step(count);
      const output: T[] = [];
      for (let i = 0; i < count; i++) output.push(read());
      return output;
    });
  }
  /** Unknown values are skipped without constructing attacker-selected object graphs. */
  skip(type: number, field = false): void {
    this.meter.step();
    if (type === 1 || type === 2) {
      if (!field) {
        const value = this.byte();
        if (value !== 1 && value !== 2) invalid("Parquet Compact collection boolean is invalid.");
      }
    } else if (type === 3) this.take(1);
    else if (type >= 4 && type <= 6) this.signed(type === 4 ? 16 : type === 5 ? 32 : 64);
    else if (type === 7) this.take(8);
    else if (type === 8) {
      const count = Number(this.uint());
      if (count > 0x7fffffff) invalid("Parquet Compact binary length exceeds signed int32.");
      if (count > this.meter.policy.string) limit("String byte");
      this.take(count);
    } else if (type === 9 || type === 10) {
      this.nest(() => {
        const header = this.byte(), element = header & 15;
        const count = header >>> 4 === 15 ? Number(this.uint()) : header >>> 4;
        if (count > 0x7fffffff || element < 1 || element > 13) {
          invalid("Parquet Compact unknown collection is invalid.");
        }
        this.meter.step(count);
        for (let i = 0; i < count; i++) this.skip(element);
      });
    } else if (type === 11) {
      this.nest(() => {
        const count = Number(this.uint());
        if (count > 0x7fffffff) invalid("Parquet Compact map size exceeds signed int32.");
        this.meter.step(count * 2);
        if (count !== 0) {
          const header = this.byte(), key = header >>> 4, value = header & 15;
          if (key < 1 || key > 13 || value < 1 || value > 13) invalid("Parquet Compact map type is invalid.");
          for (let i = 0; i < count; i++) {
            this.skip(key);
            this.skip(value);
          }
        }
      });
    } else if (type === 12) this.fields({});
    else if (type === 13) this.take(16);
    else invalid("Parquet Compact value type is invalid.");
  }
}

interface SchemaType {
  name: string;
  physical?: number;
  typeLength?: number;
  repetition?: number;
  children?: number;
  annotated: boolean;
}
interface ChunkType {
  physical: number;
  path: string[];
  codec: number;
  encodings: number[];
  values: number;
  uncompressed: number;
  stored: number;
  data: number;
  dictionary?: number;
  start: number;
  end: number;
}
interface GroupType {
  rows: number;
  chunks: ChunkType[];
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) invalid(`Parquet required ${name} field is absent.`);
  return value;
}

/** Only identity integer annotations change readability; other union arms remain bounded opaque metadata. */
function logical(cursor: Compact): { width: number; signed: boolean } | undefined {
  let count = 0;
  let result: { width: number; signed: boolean } | undefined;
  cursor.fields({
    10: (type) => {
      cursor.type(type, 12);
      let width: number | undefined, signed: boolean | undefined;
      cursor.fields({
        1: (type) => {
          cursor.type(type, 3);
          width = cursor.byte();
        },
        2: (type) => {
          signed = cursor.bool(type);
        },
      });
      const bits = required(width, "integer annotation bitWidth");
      if (![8, 16, 32, 64].includes(bits)) invalid("Parquet integer annotation width is invalid.");
      result = { width: bits, signed: required(signed, "integer annotation isSigned") };
    },
  }, () => {
    count++;
  });
  if (count !== 1) invalid("Parquet LogicalType union must contain exactly one member.");
  return result;
}

function schema(cursor: Compact): SchemaType {
  cursor.meter.retain(128);
  let name: string | undefined, physical: number | undefined, typeLength: number | undefined;
  let repetition: number | undefined, children: number | undefined;
  let annotated = false, hasLogical = false;
  let converted: number | undefined, integerType: { width: number; signed: boolean } | undefined;
  cursor.fields({
    1: (t) => {
      physical = cursor.number(t);
    },
    2: (t) => {
      typeLength = cursor.number(t);
    },
    3: (t) => {
      repetition = cursor.number(t);
    },
    4: (t) => {
      name = cursor.text(t);
    },
    5: (t) => {
      children = cursor.number(t);
    },
    6: (t) => {
      converted = cursor.number(t);
    },
    7: (t) => {
      cursor.type(t, 5);
      cursor.signed(32);
      annotated = true;
    },
    8: (t) => {
      cursor.number(t);
      annotated = true;
    },
    9: (t) => {
      cursor.type(t, 5);
      cursor.signed(32);
    },
    10: (t) => {
      cursor.type(t, 12);
      hasLogical = true;
      integerType = logical(cursor);
    },
  });
  const legacyInteger = converted !== undefined && converted >= 11 && converted <= 18
    ? { width: [8, 16, 32, 64][(converted - 11) % 4]!, signed: converted >= 15 }
    : undefined;
  const legacyWidth = converted === 17 ? 32 : converted === 18 ? 64 : undefined;
  if (
    legacyInteger && integerType &&
    (legacyInteger.width !== integerType.width || legacyInteger.signed !== integerType.signed)
  ) {
    invalid("Parquet integer annotations disagree.");
  }
  if (converted !== undefined && legacyWidth === undefined) annotated = true;
  if (
    hasLogical && (!integerType || !integerType.signed ||
      (integerType.width !== 32 && integerType.width !== 64))
  ) annotated = true;
  const identityWidth = integerType?.width ?? legacyWidth;
  if (identityWidth !== undefined && physical !== (identityWidth === 64 ? 2 : 1)) annotated = true;
  return {
    name: required(name, "schema name"),
    ...(physical === undefined ? {} : { physical }),
    ...(typeLength === undefined ? {} : { typeLength }),
    ...(repetition === undefined ? {} : { repetition }),
    ...(children === undefined ? {} : { children }),
    annotated,
  };
}

function chunk(cursor: Compact): ChunkType {
  cursor.meter.retain(192);
  let metadata: ChunkType | undefined;
  let fileOffset: number | undefined;
  cursor.fields({
    1: (t) => {
      if (cursor.text(t) !== "") unsupported("Parquet external column files are unsupported.");
    },
    2: (t) => {
      fileOffset = cursor.number(t, 64);
    },
    3: (t) => {
      cursor.type(t, 12);
      let physical: number | undefined,
        path: string[] | undefined,
        codec: number | undefined,
        encodings: number[] | undefined;
      let values: number | undefined,
        uncompressed: number | undefined,
        stored: number | undefined,
        data: number | undefined;
      let dictionary: number | undefined;
      cursor.fields({
        1: (t) => {
          physical = cursor.number(t);
        },
        2: (t) => {
          encodings = cursor.list(t, 5, 64, () => cursor.number(5));
        },
        3: (t) => {
          path = cursor.list(t, 8, 1, () => cursor.text(8));
        },
        4: (t) => {
          codec = cursor.number(t);
        },
        5: (t) => {
          values = cursor.number(t, 64);
        },
        6: (t) => {
          uncompressed = cursor.number(t, 64);
        },
        7: (t) => {
          stored = cursor.number(t, 64);
        },
        9: (t) => {
          data = cursor.number(t, 64);
        },
        11: (t) => {
          dictionary = cursor.number(t, 64);
        },
      });
      const offset = required(data, "data page offset"),
        start = dictionary === undefined ? offset : Math.min(offset, dictionary);
      metadata = {
        physical: required(physical, "column type"),
        path: required(path, "column path"),
        codec: required(codec, "column codec"),
        encodings: required(encodings, "column encodings"),
        values: required(values, "column value count"),
        uncompressed: required(uncompressed, "uncompressed chunk size"),
        stored: required(stored, "stored chunk size"),
        data: offset,
        ...(dictionary === undefined ? {} : { dictionary }),
        start,
        end: exact(BigInt(start) + BigInt(required(stored, "stored chunk size")), "chunk end"),
      };
    },
    8: () => unsupported("Parquet encrypted column metadata is unsupported."),
    9: () => unsupported("Parquet encrypted columns are unsupported."),
  });
  required(fileOffset, "column file offset");
  return required(metadata, "inline column metadata");
}

function group(cursor: Compact, maximum: number): GroupType {
  cursor.meter.retain(64);
  let rows: number | undefined, chunks: ChunkType[] | undefined, total: number | undefined;
  cursor.fields({
    1: (t) => {
      chunks = cursor.list(t, 12, maximum, () => chunk(cursor));
    },
    2: (t) => {
      total = cursor.number(t, 64);
    },
    3: (t) => {
      rows = cursor.number(t, 64);
    },
  });
  const columns = required(chunks, "row group columns");
  const expected = columns.reduce((sum, column) => sum + BigInt(column.uncompressed), 0n);
  if (BigInt(required(total, "row group byte size")) !== expected) {
    invalid("Parquet row group byte size disagrees with its columns.");
  }
  return { rows: required(rows, "row group rows"), chunks: columns };
}

interface PageType {
  version: 1 | 2;
  offset: number;
  header: number;
  stored: number;
  decoded: number;
  rows: number;
  encoding: number;
  definition: number;
  repetition: number;
  nulls?: number;
  crc?: number;
}

/** One data page header; no unsupported page is silently treated as rows. */
function page(cursor: Compact, offset: number): PageType {
  let type: number | undefined, stored: number | undefined, decoded: number | undefined, crc: number | undefined;
  let v1: Omit<PageType, "offset" | "header" | "stored" | "decoded"> | undefined;
  let v2: typeof v1;
  cursor.fields({
    1: (t) => {
      type = cursor.number(t);
    },
    2: (t) => {
      decoded = cursor.number(t);
    },
    3: (t) => {
      stored = cursor.number(t);
    },
    4: (t) => {
      cursor.type(t, 5);
      crc = Number(BigInt.asUintN(32, cursor.signed(32)));
    },
    5: (t) => {
      cursor.type(t, 12);
      let rows: number | undefined,
        encoding: number | undefined,
        definition: number | undefined,
        repetition: number | undefined;
      cursor.fields({
        1: (t) => {
          rows = cursor.number(t);
        },
        2: (t) => {
          encoding = cursor.number(t);
        },
        3: (t) => {
          definition = cursor.number(t);
        },
        4: (t) => {
          repetition = cursor.number(t);
        },
      });
      v1 = {
        version: 1,
        rows: required(rows, "page value count"),
        encoding: required(encoding, "page encoding"),
        definition: required(definition, "definition encoding"),
        repetition: required(repetition, "repetition encoding"),
      };
    },
    6: () => unsupported("Parquet index pages are unsupported in the selected column."),
    7: () => unsupported("Parquet dictionary pages are unsupported in the selected column."),
    8: (t) => {
      cursor.type(t, 12);
      let count: number | undefined, rows: number | undefined, nulls: number | undefined, encoding: number | undefined;
      let definition: number | undefined, repetition: number | undefined;
      cursor.fields({
        1: (t) => {
          count = cursor.number(t);
        },
        2: (t) => {
          nulls = cursor.number(t);
        },
        3: (t) => {
          rows = cursor.number(t);
        },
        4: (t) => {
          encoding = cursor.number(t);
        },
        5: (t) => {
          definition = cursor.number(t);
        },
        6: (t) => {
          repetition = cursor.number(t);
        },
        7: (t) => {
          cursor.bool(t);
        },
      });
      const size = required(rows, "v2 page rows");
      if (required(count, "v2 page value count") !== size) invalid("Parquet flat page row/value counts disagree.");
      v2 = {
        version: 2,
        rows: size,
        encoding: required(encoding, "v2 encoding"),
        nulls: required(nulls, "v2 null count"),
        definition: required(definition, "v2 definition length"),
        repetition: required(repetition, "v2 repetition length"),
      };
      if (v2.nulls! > size) invalid("Parquet v2 null count exceeds rows.");
    },
  });
  const kind = required(type, "page type");
  if (kind !== 0 && kind !== 3) unsupported("Parquet selected column has an unsupported page type.");
  if ((kind === 0 && (!v1 || v2)) || (kind === 3 && (!v2 || v1))) {
    invalid("Parquet page-specific headers contradict its type.");
  }
  return {
    ...required(kind === 0 ? v1 : v2, "data page header"),
    offset,
    header: cursor.at,
    stored: required(stored, "stored page size"),
    decoded: required(decoded, "uncompressed page size"),
    ...(crc === undefined ? {} : { crc }),
  };
}

/** Decode one-bit definition levels without allocating a page-sized mask.
 *
 * Bit-packed runs round their final group to eight entries. Only the final
 * run may contain up to seven ignored slots; their unused bits are not data.
 */
function levels(bytes: Uint8Array, count: number, visit: (row: number, valid: boolean) => void, meter: Meter): number {
  const cursor = new Compact(bytes, meter);
  let row = 0, present = 0;
  while (row < count) {
    meter.step();
    const header = Number(cursor.uint());
    if (header < 2) invalid("Parquet definition run is empty.");
    const packed = (header & 1) !== 0;
    const length = packed ? (header >>> 1) * 8 : header >>> 1;
    if (length > 0x7fffffff) invalid("Parquet definition run exceeds signed int32.");
    if (length > count - row && (!packed || length - (count - row) > 7)) {
      invalid("Parquet definition run exceeds page values.");
    }
    if (packed) {
      const payload = cursor.take(length / 8);
      const end = Math.min(length, count - row);
      for (let i = 0; i < end; i++) {
        meter.step();
        const valid = (payload[i >>> 3]! & (1 << (i & 7))) !== 0;
        visit(row++, valid);
        if (valid) present++;
      }
    } else {
      const value = cursor.byte();
      if (value > 1) invalid("Parquet definition level exceeds flat optional depth.");
      for (let i = 0; i < length; i++) {
        meter.step();
        visit(row++, value === 1);
      }
      if (value === 1) present += length;
    }
  }
  if (cursor.at !== bytes.length) invalid("Parquet definition levels contain trailing runs.");
  return present;
}

/** Return the physical output width; BOOLEAN's packed input still produces one byte per row. */
function width(physical: number): number {
  return physical === 0 ? 1 : physical === 1 || physical === 4 ? 4 : physical === 2 || physical === 5 ? 8 : 0;
}

function values(physical: number, count: number): ParquetValuesType {
  if (physical === 0) return new Uint8Array(count);
  if (physical === 1) return new Int32Array(count);
  if (physical === 2) return new BigInt64Array(count);
  if (physical === 4) return new Float32Array(count);
  if (physical === 5) return new Float64Array(count);
  unsupported("Parquet physical type is outside the numeric profile.");
}

/** Open bounded metadata, then preview selected physical numeric values.
 *
 * File metadata is unverified input even when selected page bodies have CRCs.
 * The caller keeps source ownership and must provide stable replay evidence.
 */
export async function openParquet(
  input: ByteSourceType,
  supplied: ParquetOpenOptionsType = {},
): Promise<ParquetDatasetType> {
  const options = { ...supplied };
  if (options.allowUnverifiedSource !== undefined && typeof options.allowUnverifiedSource !== "boolean") {
    throw new TypeError("Parquet unverified-source policy must be boolean.");
  }
  const { size, identity, stability } = input;
  integer(size, "Parquet source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("Parquet identity must be a bounded string.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown Parquet source stability.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) {
    unsupported("Parquet requires stable replay evidence.");
  }
  const readSource = input.read.bind(input);
  const source: ByteSourceType = Object.freeze({
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: readSource,
  });
  const policy: PolicyType = {
    footer: options.maxFooterBytes ?? 8 * 1024 * 1024,
    header: options.maxPageHeaderBytes ?? 65536,
    page: options.maxPageBytes ?? 8 * 1024 * 1024,
    columns: options.maxColumns ?? 1024,
    groups: options.maxRowGroups ?? 4096,
    compact: options.maxCompactValues ?? 1048576,
    depth: options.maxDepth ?? 32,
    string: options.maxStringBytes ?? 65536,
    retained: options.maxRetainedMetadataBytes ?? 8 * 1024 * 1024,
    pages: options.maxPages ?? 65536,
    rows: options.maxRows ?? 1048576,
  };
  for (const [name, count] of Object.entries(policy)) integer(count, `Parquet maximum ${name}`);
  const captured = new WeakMap<ArchiveLedgerType, ArchiveLedgerType>();
  const capture = (owner: ArchiveLedgerType | undefined): ArchiveLedgerType | undefined => {
    if (!owner) return undefined;
    let saved = captured.get(owner);
    if (!saved) {
      saved = { reserve: owner.reserve.bind(owner), inspect: owner.inspect.bind(owner) };
      captured.set(owner, saved);
    }
    return saved;
  };
  const lifetime = createArchiveLedger(options), opening = capture(options.ledger);
  const together = (owners: readonly (ArchiveLedgerType | undefined)[], signal?: AbortSignal): ArchiveLedgerType => {
    const unique = [...new Set(owners.filter((owner): owner is ArchiveLedgerType => owner !== undefined))];
    return {
      reserve(kind, count) {
        for (const owner of unique) {
          owner.reserve(kind, count);
          signal?.throwIfAborted();
        }
      },
      inspect: () => lifetime.inspect(),
    };
  };
  const budget = new ArchiveBudget(
    source,
    { ...options, ledger: together([lifetime, opening], options.signal) },
    options.signal,
  );
  const meter = new Meter(policy, options.signal);
  const metadata = async (offset: number, length: number): Promise<Uint8Array> => {
    budget.decoded(length);
    options.signal?.throwIfAborted();
    return (await budget.read(offset, length)).slice();
  };
  if (size < 12) invalid("Parquet file is too short.");
  const tail = await metadata(size - 8, 8);
  const magic = view(tail).getUint32(4, true);
  if (magic === 0x45524150) unsupported("Parquet encrypted footers are unsupported.");
  if (magic !== 0x31524150) invalid("Parquet footer magic mismatch.");
  const footerLength = view(tail).getUint32(0, true);
  if (footerLength > policy.footer) limit("Footer byte");
  if (footerLength > size - 12) invalid("Parquet footer overlaps its leading magic.");
  const footerOffset = size - 8 - footerLength;
  if (view(await metadata(0, 4)).getUint32(0, true) !== 0x31524150) invalid("Parquet leading magic mismatch.");
  const footer = new Compact(await metadata(footerOffset, footerLength), meter);
  let version: number | undefined,
    schemaList: SchemaType[] | undefined,
    rows: number | undefined,
    groups: GroupType[] | undefined;
  try {
    footer.fields({
      1: (t) => {
        version = footer.number(t);
      },
      2: (t) => {
        schemaList = footer.list(t, 12, policy.columns + 1, () => schema(footer));
      },
      3: (t) => {
        rows = footer.number(t, 64);
      },
      4: (t) => {
        groups = footer.list(t, 12, policy.groups, () => group(footer, policy.columns));
      },
      8: () => unsupported("Parquet footer encryption is unsupported."),
      9: () => unsupported("Parquet signed/encrypted footer metadata is unsupported."),
    });
  } catch (error) {
    if (error instanceof NeedMore) invalid("Parquet footer is truncated.");
    throw error;
  }
  if (footer.at !== footerLength) invalid("Parquet footer has trailing bytes.");
  if (required(version, "file version") !== 1 && version !== 2) {
    unsupported("Parquet file metadata version is unsupported.");
  }
  const fields = required(schemaList, "schema"),
    groupList = required(groups, "row groups"),
    rowCount = required(rows, "file rows");
  const root = fields[0];
  if (!root || root.physical !== undefined || root.children !== fields.length - 1) {
    unsupported("Parquet requires a flat root schema.");
  }
  const names = new Set<string>();
  const columns: ParquetColumnType[] = [];
  for (let i = 1; i < fields.length; i++) {
    const field = fields[i]!;
    if (
      field.physical === undefined || field.children !== undefined || (field.repetition !== 0 && field.repetition !== 1)
    ) unsupported("Parquet nested/repeated schemas are unsupported.");
    if (field.physical > 7 || names.has(field.name)) {
      invalid("Parquet physical type or duplicate column name is invalid.");
    }
    if (field.typeLength === 0 || (field.physical === 7 && field.typeLength === undefined)) {
      invalid("Parquet fixed or declared type length is absent or zero.");
    }
    names.add(field.name);
    let reason = field.annotated
      ? "Logical annotations are unsupported."
      : width(field.physical) === 0
      ? "Physical type is outside the numeric profile."
      : undefined;
    for (const group of groupList) {
      const chunk = group.chunks[i - 1];
      if (
        !chunk || chunk.physical !== field.physical || chunk.path.length !== 1 || chunk.path[0] !== field.name ||
        chunk.values !== group.rows
      ) invalid("Parquet column chunk disagrees with the flat schema or row count.");
      if (chunk.codec !== 0) reason ??= "Compression is unsupported.";
      if (chunk.dictionary !== undefined || chunk.encodings.some((encoding) => encoding !== 0 && encoding !== 3)) {
        reason ??= "Value encoding/dictionaries are unsupported.";
      }
    }
    meter.retain(128);
    columns.push(
      Object.freeze({
        id: i - 1,
        name: field.name,
        physical: field.physical,
        optional: field.repetition === 1,
        readable: reason === undefined,
        ...(reason === undefined ? {} : { reason }),
      }),
    );
  }
  meter.retain(groupList.length * 64);
  const extents: ChunkType[] = [];
  const rowGroups: ParquetRowGroupType[] = [];
  let totalRows = 0;
  for (let i = 0; i < groupList.length; i++) {
    const group = groupList[i]!;
    if (group.chunks.length !== columns.length) invalid("Parquet row group column count disagrees with schema.");
    rowGroups.push(Object.freeze({ id: i, offset: totalRows, rows: group.rows }));
    totalRows = exact(BigInt(totalRows) + BigInt(group.rows), "total rows");
    for (const chunk of group.chunks) {
      // Native empty columns can use the required zero page-offset sentinel.
      // It represents no physical extent and must never authorize page reads.
      if (chunk.stored === 0) {
        if (chunk.values !== 0 || chunk.uncompressed !== 0 || chunk.dictionary !== undefined) {
          invalid("Parquet empty column declares values, decoded bytes or a dictionary.");
        }
        if (chunk.data === 0) continue;
      }
      if (chunk.start < 4 || chunk.end > footerOffset || chunk.data < chunk.start || chunk.data > chunk.end) {
        invalid("Parquet column chunk extent is outside data bytes.");
      }
      if (chunk.stored !== 0) extents.push(chunk);
    }
  }
  if (totalRows !== rowCount) invalid("Parquet row groups disagree with file row count.");
  extents.sort((a, b) => a.start - b.start);
  for (let i = 1; i < extents.length; i++) {
    if (extents[i]!.start < extents[i - 1]!.end) invalid("Parquet column chunks overlap.");
  }
  options.signal?.throwIfAborted();
  return Object.freeze({
    rows: rowCount,
    columns: Object.freeze(columns),
    rowGroups: Object.freeze(rowGroups),
    integrity: "metadata-unverified" as const,
    work: Object.freeze(budget.inspect()),
    async read(columnId: number, supplied: ParquetReadOptionsType = {}): Promise<ParquetReadType> {
      const opts = { ...supplied };
      integer(columnId, "Parquet column ID");
      const column = columns[columnId];
      if (!column) throw new RangeError("Parquet column ID is absent.");
      if (!column.readable) unsupported(column.reason!);
      const signal = options.signal && opts.signal
        ? AbortSignal.any([options.signal, opts.signal])
        : options.signal ?? opts.signal;
      signal?.throwIfAborted();
      const offset = opts.offset ?? 0, length = opts.length ?? rowCount - offset;
      integer(offset, "Parquet row offset");
      integer(length, "Parquet row length");
      if (offset > rowCount || length > rowCount - offset) {
        throw new RangeError("Parquet row selection exceeds the file.");
      }
      if (length > policy.rows) limit("Returned row");
      const owners = together([lifetime, opening, capture(opts.ledger)], signal);
      const credits = { sourceBytes: 0, requests: 0 };
      const operation = new ArchiveBudget(source, {
        ...opts,
        ledger: {
          reserve(kind, count) {
            if ((kind === "sourceBytes" || kind === "requests") && credits[kind] >= count) credits[kind] -= count;
            else owners.reserve(kind, count);
            signal?.throwIfAborted();
          },
          inspect: () => lifetime.inspect(),
        },
      }, signal);
      const readMeter = new Meter(policy, signal);
      const plans: { page: PageType; group: number; row: number; selected: boolean }[] = [];
      for (let g = 0; g < groupList.length; g++) {
        const group = groupList[g]!, base = rowGroups[g]!.offset;
        if (length === 0 || base >= offset + length || base + group.rows <= offset) continue;
        const chunk = group.chunks[columnId]!;
        let at = chunk.data, count = 0, uncompressed = 0;
        while (at < chunk.end) {
          if (plans.length >= policy.pages) limit("Page count");
          let lookahead = Math.min(256, policy.header, chunk.end - at), parsed: PageType | undefined;
          for (;;) {
            operation.decoded(lookahead);
            signal?.throwIfAborted();
            const cursor = new Compact((await operation.read(at, lookahead)).slice(), readMeter);
            try {
              parsed = page(cursor, at);
              break;
            } catch (error) {
              if (!(error instanceof NeedMore)) throw error;
              if (lookahead === Math.min(policy.header, chunk.end - at)) {
                if (lookahead === policy.header && lookahead < chunk.end - at) limit("Page header byte");
                invalid("Parquet page header is truncated.");
              }
              lookahead = Math.min(lookahead * 2 || 1, policy.header, chunk.end - at);
            }
          }
          const p = required(parsed, "page");
          if (p.rows > group.rows - count) invalid("Parquet page row count exceeds its row group.");
          if (p.encoding !== 0) unsupported("Parquet selected column requires PLAIN data pages.");
          if (p.version === 1 && (![3, 4].includes(p.definition) || ![3, 4].includes(p.repetition))) {
            invalid("Parquet v1 level encoding is invalid.");
          }
          if (p.stored !== p.decoded || p.stored > chunk.end - at - p.header) {
            invalid("Parquet uncompressed page size exceeds its chunk or differs from stored size.");
          }
          if (p.version === 1 && column.optional && p.definition !== 3) {
            unsupported("Parquet optional levels require RLE/bit-packed encoding.");
          }
          if (p.version === 2 && (p.repetition !== 0 || (!column.optional && p.definition !== 0))) {
            invalid("Parquet flat v2 page level lengths are inconsistent.");
          }
          readMeter.retain(160);
          plans.push({
            page: p,
            group: g,
            row: base + count,
            selected: base + count < offset + length && base + count + p.rows > offset,
          });
          count += p.rows;
          uncompressed = exact(BigInt(uncompressed) + BigInt(p.decoded + p.header), "uncompressed chunk size");
          at += p.header + p.stored;
        }
        if (count !== group.rows || at !== chunk.end || uncompressed !== chunk.uncompressed) {
          invalid("Parquet page totals disagree with column metadata.");
        }
      }
      let bodyBytes = 0, bodyRequests = 0;
      for (const plan of plans) {
        if (plan.selected) {
          if (plan.page.stored > policy.page) limit("Page byte");
          bodyBytes = exact(BigInt(bodyBytes) + BigInt(plan.page.stored), "selected page bytes");
          if (plan.page.stored !== 0) bodyRequests++;
        }
      }
      const work = operation.inspect();
      if (
        bodyBytes > operation.limits.maxSourceBytes - work.sourceBytes ||
        bodyRequests > operation.limits.maxRequests - work.requests
      ) limit("Selected source/request");
      owners.reserve("sourceBytes", bodyBytes);
      owners.reserve("requests", bodyRequests);
      credits.sourceBytes = bodyBytes;
      credits.requests = bodyRequests;
      operation.decoded(bodyBytes);
      const outputBytes = exact(BigInt(length) * BigInt(width(column.physical) + 1), "output bytes");
      operation.decoded(outputBytes);
      operation.output(outputBytes);
      signal?.throwIfAborted();
      const output = values(column.physical, length), validity = new Uint8Array(length);
      const evidence: ParquetPageEvidenceType[] = [];
      for (const plan of plans) {
        const p = plan.page;
        if (!plan.selected) {
          evidence.push(
            Object.freeze({
              rowGroup: plan.group,
              offset: p.offset,
              rows: p.rows,
              selected: false,
              checksum: "not-read",
            }),
          );
          continue;
        }
        const body = (await operation.read(p.offset + p.header, p.stored)).slice();
        if (p.crc !== undefined && ((crc32(body) ^ 0xffffffff) >>> 0) !== p.crc) {
          throw new ArchiveError("checksum-mismatch", "Parquet selected page CRC32 mismatch.");
        }
        let start = 0, levelBytes = new Uint8Array();
        if (column.optional) {
          if (p.version === 1) {
            if (body.length < 4) {
              invalid("Parquet v1 definition length is truncated.");
            }
            const length = view(body).getUint32(0, true);
            if (length > body.length - 4) invalid("Parquet v1 definition levels exceed the page.");
            start = 4 + length;
            levelBytes = body.subarray(4, start);
          } else {
            if (p.definition > body.length) invalid("Parquet v2 definition levels exceed the page.");
            start = p.definition;
            levelBytes = body.subarray(0, start);
          }
        }
        const payload = body.subarray(start), data = view(payload);
        let present = 0;
        const emit = (row: number, valid: boolean): void => {
          readMeter.step();
          const at = plan.row + row - offset;
          if (valid) {
            const index = present++;
            if (at >= 0 && at < length) {
              validity[at] = 1;
              if (column.physical === 0) {
                if ((index >>> 3) >= payload.length) invalid("Parquet PLAIN boolean payload is truncated.");
                (output as Uint8Array)[at] = (payload[index >>> 3]! >>> (index & 7)) & 1;
              } else {
                const position = index * width(column.physical);
                if (position > payload.length - width(column.physical)) {
                  invalid("Parquet PLAIN numeric payload is truncated.");
                }
                if (column.physical === 2) (output as BigInt64Array)[at] = data.getBigInt64(position, true);
                else {(output as Int32Array | Float32Array | Float64Array)[at] = column.physical === 1
                    ? data.getInt32(position, true)
                    : column.physical === 4
                    ? data.getFloat32(position, true)
                    : data.getFloat64(position, true);}
              }
            }
          }
        };
        try {
          if (column.optional) levels(levelBytes, p.rows, emit, readMeter);
          else for (let row = 0; row < p.rows; row++) emit(row, true);
        } catch (error) {
          if (error instanceof NeedMore) invalid("Parquet definition levels are truncated.");
          throw error;
        }
        const expected = column.physical === 0 ? Math.ceil(present / 8) : present * width(column.physical);
        if (payload.length !== expected || (p.nulls !== undefined && p.nulls !== p.rows - present)) {
          invalid("Parquet PLAIN byte/null counts disagree with its page header.");
        }
        evidence.push(
          Object.freeze({
            rowGroup: plan.group,
            offset: p.offset,
            rows: p.rows,
            selected: true,
            checksum: p.crc === undefined ? "not-provided" : "crc32-verified",
          }),
        );
      }
      signal?.throwIfAborted();
      return {
        values: output,
        validity,
        pages: Object.freeze(evidence),
        integrity: "selected-pages",
        work: operation.inspect(),
      };
    },
  });
}
