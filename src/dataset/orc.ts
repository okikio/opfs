/** Bounded numeric ORC previews over a borrowed stable byte source. @module */
import type { ByteSourceType } from "../source.ts";
import {
  ArchiveBudget,
  ArchiveError,
  createArchiveLedger,
  integer,
  invalid,
  unsupported,
  view,
} from "../archive/record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";
export { ArchiveError, createArchiveLedger } from "../archive/record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "../archive/record.ts";

/** Opening limits remain aggregate authority for all later reads; no source ownership transfers. */
export interface OrcOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 8 MiB of owned serialized file footer bytes. */
  readonly maxFooterBytes?: number;
  /** Default: 1 MiB of owned serialized footer per selected stripe. */
  readonly maxStripeFooterBytes?: number;
  /** Default: 16 MiB total PRESENT/DATA bytes acquired by one selected read. */
  readonly maxSelectedStreamBytes?: number;
  /** Default: 4,096 file stripe descriptors. This is independent of request limits. */
  readonly maxStripes?: number;
  /** Default: 1,024 flat leaf columns. Nested schemas refuse opening. */
  readonly maxColumns?: number;
  /** Default: 8 MiB of conservative retained metadata allowances per operation, not an exact heap cap. */
  readonly maxRetainedMetadataBytes?: number;
  /** Default: 32 nested interpreted Protobuf messages. Unknown binary fields are skipped as opaque bytes. */
  readonly maxDepth?: number;
  /** Default: 65,536 stream descriptors scanned across selected stripes per read. */
  readonly maxStreams?: number;
  /** Default: 65,536 bytes per metadata string, including uninterpreted known text. */
  readonly maxStringBytes?: number;
  /** Default: 1,048,576 returned rows per read; file and decoded stripe row counts can be larger. */
  readonly maxRows?: number;
  /** Default: 8,388,608 wire fields/varint bytes and expanded RLE/row steps per operation. */
  readonly maxSteps?: number;
  /** Default: false. An identity alone is not stable replay evidence. */
  readonly allowUnverifiedSource?: boolean;
}

/** Row ranges are zero-based. The opening signal always remains authoritative. */
export interface OrcReadOptionsType extends ArchiveLimitsType {
  readonly offset?: number;
  readonly length?: number;
  readonly signal?: AbortSignal;
}

/** Schema eligibility only; a selected stripe can still refuse an unsupported encoding or stream role. */
export interface OrcColumnType {
  readonly id: number;
  readonly name: string;
  /** Original ORC Type.Kind number. */
  readonly kind: number;
  readonly supported: boolean;
  readonly reason?: string;
}

/** Declared geometry checked against source bounds; unread column bodies are not validated. */
export interface OrcStripeType {
  readonly id: number;
  /** Physical source offset, unlike rowOffset. */
  readonly offset: number;
  readonly rowOffset: number;
  readonly rows: number;
  readonly indexBytes: number;
  readonly dataBytes: number;
  readonly footerBytes: number;
}

/** LONG is exact bigint; BOOLEAN is 0/1. Null slots are zero and require the separate mask. */
export type OrcValuesType =
  | Uint8Array
  | Int8Array
  | Int16Array
  | Int32Array
  | BigInt64Array
  | Float32Array
  | Float64Array;

/** The selected column's complete streams were decoded, without a checksum or authentication claim. */
export interface OrcStripeReadType {
  readonly id: number;
  readonly rows: number;
  readonly selectedRows: number;
  readonly storedBytes: number;
  readonly encoding: "DIRECT";
}

/** Owned selected output; IEEE semantics are preserved without NaN payload bit-identity guarantees. */
export interface OrcReadType {
  readonly values: OrcValuesType;
  readonly validity: Uint8Array;
  readonly stripes: readonly OrcStripeReadType[];
  readonly integrity: "none";
  readonly scope: "selected-column-stripes";
  readonly work: ArchiveWorkType;
}

/** Borrowed range reader. No query engine, mount, worker or disposal operation is created. */
export interface OrcDatasetType {
  readonly rows: number;
  readonly columns: readonly OrcColumnType[];
  readonly stripes: readonly OrcStripeType[];
  readonly formatVersion: "0.11" | "0.12";
  /** Prose specification and official C++ writer use these two exact conventions. Geometry is checked independently. */
  readonly contentLengthBasis: "body" | "header-and-body";
  readonly integrity: "none";
  /** Frozen work from opening only, not later lifetime counters. */
  readonly work: ArchiveWorkType;
  read(columnId: number, options?: OrcReadOptionsType): Promise<OrcReadType>;
}

interface PolicyType {
  footer: number;
  stripeFooter: number;
  input: number;
  stripes: number;
  columns: number;
  retained: number;
  depth: number;
  streams: number;
  string: number;
  rows: number;
  steps: number;
}

function limit(label: string): never {
  throw new ArchiveError("budget-exceeded", `ORC ${label} limit exceeded.`);
}
function exact(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid(`ORC ${label} exceeds exact nonnegative integers.`);
  }
  return Number(value);
}

/** Count wire and expanded work independently of returned bytes. No global parser or allocation state exists. */
class Meter {
  readonly policy: PolicyType;
  readonly signal: AbortSignal | undefined;
  #steps = 0;
  #retained = 0;
  streams = 0;
  constructor(policy: PolicyType, signal?: AbortSignal) {
    this.policy = policy;
    this.signal = signal;
  }
  step(count = 1): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.steps - this.#steps) limit("Parser/row work");
    this.#steps += count;
  }
  admitSteps(count: number): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.steps - this.#steps) limit("Parser/row work");
  }
  retain(count: number): void {
    this.signal?.throwIfAborted();
    if (count > this.policy.retained - this.#retained) limit("Retained metadata");
    this.#retained += count;
  }
}

/** Exact bounded Protobuf wire cursor, not a generated object graph.
 * Scalars use last-one-wins. Interpreted nested messages here are repeated;
 * encryption message presence refuses immediately, so no singular message merge
 * is replaced with scalar semantics. Unknown messages are opaque length values.
 */
class Wire {
  readonly bytes: Uint8Array;
  readonly meter: Meter;
  readonly depth: number;
  at = 0;
  constructor(bytes: Uint8Array, meter: Meter, depth = 0) {
    if (depth > meter.policy.depth) limit("Protobuf depth");
    meter.retain(64); // Admit the next bounded field dispatch set before its caller constructs it.
    this.bytes = bytes;
    this.meter = meter;
    this.depth = depth;
  }
  byte(): number {
    if (this.at >= this.bytes.length) invalid("ORC wire value is truncated.");
    return this.bytes[this.at++]!;
  }
  take(count: number): Uint8Array {
    if (count > this.bytes.length - this.at) invalid("ORC wire extent is truncated.");
    const result = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return result;
  }
  uint(bits = 64): bigint {
    let value = 0n;
    for (let shift = 0; shift < bits; shift += 7) {
      this.meter.step();
      const byte = this.byte();
      value |= BigInt(byte & 127) << BigInt(shift);
      if (value >= (1n << BigInt(bits))) invalid("ORC varint exceeds its declared width.");
      if (byte < 128) return value;
    }
    invalid("ORC varint has no terminator within its declared width.");
  }
  type(actual: number, expected: number): void {
    if (actual !== expected) invalid("ORC Protobuf field wire type mismatch.");
  }
  number(type: number, bits = 64): number {
    this.type(type, 0);
    return exact(this.uint(bits), "integer field");
  }
  binary(type: number): Uint8Array {
    this.type(type, 2);
    return this.take(exact(this.uint(), "binary length"));
  }
  message(type: number): Wire {
    return new Wire(this.binary(type), this.meter, this.depth + 1);
  }
  text(type: number): string {
    const bytes = this.binary(type);
    if (bytes.length > this.meter.policy.string) limit("String byte");
    this.meter.retain(bytes.length * 2);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid("ORC metadata string is not UTF-8.");
    }
  }
  fields(known: Readonly<Record<number, (type: number) => void>>): void {
    while (this.at < this.bytes.length) {
      this.meter.step();
      const tag = this.uint(32), id = Number(tag >> 3n), type = Number(tag & 7n);
      if (id === 0 || id > 0x1fffffff || type > 5) invalid("ORC Protobuf tag is invalid.");
      const read = Object.hasOwn(known, id) ? known[id] : undefined;
      if (read) read(type);
      else this.skip(type);
    }
  }
  skip(type: number): void {
    if (type === 0) this.uint();
    else if (type === 1) this.take(8);
    else if (type === 2) this.binary(type);
    else if (type === 5) this.take(4);
    else unsupported("ORC deprecated Protobuf groups are outside this profile.");
  }
  integers(type: number, target: number[], maximum: number): void {
    const append = (cursor: Wire): void => {
      if (target.length >= maximum) limit("Repeated integer count");
      cursor.meter.retain(8);
      target.push(exact(cursor.uint(32), "repeated integer"));
    };
    if (type === 0) append(this);
    else {
      const cursor = this.message(type);
      while (cursor.at < cursor.bytes.length) append(cursor);
    }
  }
}

interface TypeType {
  kind: number;
  children: number[];
  names: string[];
}
interface StripeType {
  offset: number;
  index: number;
  data: number;
  footer: number;
  rows: number;
}
interface StreamType {
  kind: number;
  column: number;
  length: number;
  offset: number;
}
interface SelectedType {
  stripe: OrcStripeType;
  present?: StreamType;
  data?: StreamType;
  stored: number;
}

/** Retain only the flat schema fields this reader interprets; unknown binary annotations remain opaque. */
function type(cursor: Wire): TypeType {
  cursor.meter.retain(96);
  let kind = 0;
  const children: number[] = [], names: string[] = [];
  cursor.fields({
    1: (t) => {
      kind = cursor.number(t, 32);
    },
    2: (t) => {
      cursor.integers(t, children, cursor.meter.policy.columns);
    },
    3: (t) => {
      if (names.length >= cursor.meter.policy.columns) limit("Field name count");
      cursor.meter.retain(16);
      names.push(cursor.text(t));
    },
  });
  return { kind, children, names };
}
/** Capture declared physical geometry; encryption presence refuses before any later instance can hide it. */
function stripe(cursor: Wire): StripeType {
  cursor.meter.retain(96);
  let offset = 0, index = 0, data = 0, footer = 0, rows = 0;
  cursor.fields({
    1: (t) => {
      offset = cursor.number(t);
    },
    2: (t) => {
      index = cursor.number(t);
    },
    3: (t) => {
      data = cursor.number(t);
    },
    4: (t) => {
      footer = cursor.number(t);
    },
    5: (t) => {
      rows = cursor.number(t);
    },
    6: () => unsupported("ORC encryption stripe IDs are outside this profile."),
    7: () => unsupported("ORC encrypted local keys are unsupported."),
  });
  return { offset, index, data, footer, rows };
}
/** Physical stream lengths receive an offset only after their complete stripe section is checked. */
function stream(cursor: Wire): Omit<StreamType, "offset"> {
  cursor.meter.retain(64);
  let kind = 0, column = 0, length = 0;
  cursor.fields({
    1: (t) => {
      kind = cursor.number(t, 32);
    },
    2: (t) => {
      column = cursor.number(t, 32);
    },
    3: (t) => {
      length = cursor.number(t);
    },
  });
  if (kind === 9 || kind === 10 || kind >= 100) {
    unsupported("ORC encrypted/statistics virtual streams are unsupported.");
  }
  if (kind > 8) unsupported("ORC stream kind is unsupported.");
  return { kind, column, length };
}
/** The encoding kind is a scalar; duplicate instances inside this message use Protobuf last-wins. */
function encoding(cursor: Wire): number {
  cursor.meter.retain(16);
  let kind = 0;
  cursor.fields({
    1: (t) => {
      kind = cursor.number(t, 32);
    },
  });
  return kind;
}
function width(kind: number): number {
  return kind === 0 || kind === 1
    ? 1
    : kind === 2
    ? 2
    : kind === 3 || kind === 5
    ? 4
    : kind === 4 || kind === 6
    ? 8
    : 0;
}
function values(kind: number, count: number): OrcValuesType {
  if (kind === 0) return new Uint8Array(count);
  if (kind === 1) return new Int8Array(count);
  if (kind === 2) return new Int16Array(count);
  if (kind === 3) return new Int32Array(count);
  if (kind === 4) return new BigInt64Array(count);
  if (kind === 5) return new Float32Array(count);
  if (kind === 6) return new Float64Array(count);
  unsupported("ORC column is outside the physical numeric profile.");
}

/** Byte RLE expands at most 130 bytes per run; its terminal check rejects hidden extra runs. */
class Bytes {
  readonly cursor: Wire;
  #remaining = 0;
  #repeat: number | undefined;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.cursor = new Wire(bytes, meter);
  }
  next(): number {
    this.cursor.meter.step();
    if (this.#remaining === 0) {
      const control = this.cursor.byte();
      this.#remaining = control < 128 ? control + 3 : 256 - control;
      this.#repeat = control < 128 ? this.cursor.byte() : undefined;
    }
    this.#remaining--;
    return this.#repeat ?? this.cursor.byte();
  }
  end(): void {
    if (this.#remaining !== 0 || this.cursor.at !== this.cursor.bytes.length) {
      invalid("ORC byte RLE has excess values or trailing runs.");
    }
  }
}

/** Boolean RLE packs most-significant bits first; only the last byte's unused bits are ignored. */
class Bits {
  readonly bytes: Bytes;
  #byte = 0;
  #bit = 8;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.bytes = new Bytes(bytes, meter);
  }
  next(): boolean {
    this.bytes.cursor.meter.step();
    if (this.#bit === 8) {
      this.#byte = this.bytes.next();
      this.#bit = 0;
    }
    return ((this.#byte >>> (7 - this.#bit++)) & 1) === 1;
  }
  end(): void {
    this.bytes.end();
  }
}

/** Integer RLEv1 uses exact bigint delta arithmetic, then checks the declared signed leaf width. */
class Integers {
  readonly cursor: Wire;
  #remaining = 0;
  #value = 0n;
  #delta: bigint | undefined;
  constructor(bytes: Uint8Array, meter: Meter) {
    this.cursor = new Wire(bytes, meter);
  }
  next(): bigint {
    this.cursor.meter.step();
    const signed = (): bigint => {
      const value = this.cursor.uint();
      return (value >> 1n) ^ -(value & 1n);
    };
    if (this.#remaining === 0) {
      const control = this.cursor.byte();
      if (control < 128) {
        this.#remaining = control + 3;
        const delta = this.cursor.byte();
        this.#delta = BigInt(delta < 128 ? delta : delta - 256);
        this.#value = signed();
      } else {
        this.#remaining = 256 - control;
        this.#delta = undefined;
      }
    }
    this.#remaining--;
    if (this.#delta === undefined) return signed();
    const value = this.#value;
    this.#value += this.#delta;
    return value;
  }
  end(): void {
    if (this.#remaining !== 0 || this.cursor.at !== this.cursor.bytes.length) {
      invalid("ORC integer RLE has excess values or trailing runs.");
    }
  }
}

/** Inspect numeric columns, then decode complete selected column streams in each intersecting stripe.
 * Metadata and values have no checksum/authentication claim. Stable replay is a
 * caller/provider contract and is not established by a source identity alone.
 */
export async function openOrc(input: ByteSourceType, supplied: OrcOpenOptionsType = {}): Promise<OrcDatasetType> {
  const options = { ...supplied };
  if (options.allowUnverifiedSource !== undefined && typeof options.allowUnverifiedSource !== "boolean") {
    throw new TypeError("ORC unverified-source policy must be boolean.");
  }
  const { size, identity, stability } = input;
  integer(size, "ORC source size");
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("ORC identity must be a bounded string.");
  }
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown ORC source stability.");
  }
  if (stability === undefined && !options.allowUnverifiedSource) unsupported("ORC requires stable replay evidence.");
  const source: ByteSourceType = Object.freeze({
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: input.read.bind(input),
  });
  const policy: PolicyType = {
    footer: options.maxFooterBytes ?? 8 * 1024 * 1024,
    stripeFooter: options.maxStripeFooterBytes ?? 1024 * 1024,
    input: options.maxSelectedStreamBytes ?? 16 * 1024 * 1024,
    stripes: options.maxStripes ?? 4096,
    columns: options.maxColumns ?? 1024,
    retained: options.maxRetainedMetadataBytes ?? 8 * 1024 * 1024,
    depth: options.maxDepth ?? 32,
    streams: options.maxStreams ?? 65536,
    string: options.maxStringBytes ?? 65536,
    rows: options.maxRows ?? 1048576,
    steps: options.maxSteps ?? 8388608,
  };
  for (const [name, count] of Object.entries(policy)) integer(count, `ORC maximum ${name}`);
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
  const metadata = async (offset: number, count: number): Promise<Uint8Array> => {
    budget.decoded(count);
    options.signal?.throwIfAborted();
    return (await budget.read(offset, count)).slice();
  };
  if (size < 4) invalid("ORC file is too short.");
  const header = await metadata(0, 3);
  if (header[0] !== 79 || header[1] !== 82 || header[2] !== 67) invalid("ORC header magic is absent.");
  const postLength = (await metadata(size - 1, 1))[0]!;
  if (postLength === 0 || postLength > size - 4) invalid("ORC postscript extent is invalid.");
  const postOffset = size - 1 - postLength, post = new Wire(await metadata(postOffset, postLength), meter);
  let footerLength = 0, metadataLength = 0, compression = 0;
  meter.retain(32);
  const version: number[] = [];
  post.fields({
    1: (t) => {
      footerLength = post.number(t);
    },
    2: (t) => {
      compression = post.number(t, 32);
    },
    4: (t) => {
      post.integers(t, version, 2);
    },
    5: (t) => {
      metadataLength = post.number(t);
    },
    7: (t) => {
      if (post.number(t) !== 0) unsupported("ORC encrypted stripe statistics are unsupported.");
    },
    8000: (t) => {
      if (post.text(t) !== "ORC") invalid("ORC postscript magic disagrees with its header.");
    },
  });
  if (compression !== 0) unsupported("ORC generic compression is outside this profile.");
  if (version.length !== 2 || version[0] !== 0 || (version[1] !== 11 && version[1] !== 12)) {
    unsupported("ORC file version is unsupported.");
  }
  const formatVersion = version[1] === 11 ? "0.11" : "0.12";
  if (footerLength > policy.footer) limit("File footer byte");
  const tailLength = exact(BigInt(footerLength) + BigInt(metadataLength), "tail length");
  if (footerLength === 0 || tailLength > postOffset - 3) invalid("ORC footer/metadata extents are invalid.");
  const footerOffset = postOffset - footerLength, metadataStart = postOffset - tailLength;
  const footer = new Wire(await metadata(footerOffset, footerLength), meter);
  let headerLength = 0, contentLength = 0, rows = 0;
  meter.retain(64);
  const declaredStripes: StripeType[] = [], types: TypeType[] = [];
  footer.fields({
    1: (t) => {
      headerLength = footer.number(t);
    },
    2: (t) => {
      contentLength = footer.number(t);
    },
    3: (t) => {
      if (declaredStripes.length >= policy.stripes) limit("Stripe count");
      declaredStripes.push(stripe(footer.message(t)));
    },
    4: (t) => {
      if (types.length > policy.columns) limit("Schema type count");
      types.push(type(footer.message(t)));
    },
    6: (t) => {
      rows = footer.number(t);
    },
    10: () => unsupported("ORC encrypted/masked footers are unsupported."),
  });
  if (headerLength !== 3) unsupported("ORC profile requires a three-byte header.");
  // The prose includes the header; the official C++ writer excludes it. Both
  // exact conventions are observable; neither relaxes the independent extents.
  const contentLengthBasis = contentLength === metadataStart
    ? "header-and-body"
    : BigInt(contentLength) + BigInt(headerLength) === BigInt(metadataStart)
    ? "body"
    : undefined;
  if (!contentLengthBasis) invalid("ORC declared content length disagrees with its tail.");
  const root = types[0];
  if (
    !root || root.kind !== 12 || root.names.length !== root.children.length || root.children.length !== types.length - 1
  ) unsupported("ORC requires a flat STRUCT root.");
  meter.retain(types.length * 16 + 64);
  const seen = new Set<number>(), columns: OrcColumnType[] = [];
  for (let index = 0; index < root.children.length; index++) {
    const id = root.children[index]!, child = types[id];
    if (id === 0 || !child || seen.has(id)) invalid("ORC schema child ID is invalid or repeated.");
    seen.add(id);
    if (
      child.children.length || child.names.length || child.kind === 12 || child.kind === 10 || child.kind === 11 ||
      child.kind === 13
    ) unsupported("ORC nested schemas are unsupported.");
    meter.retain(96);
    const supported = width(child.kind) !== 0;
    columns.push(
      Object.freeze({
        id,
        name: root.names[index]!,
        kind: child.kind,
        supported,
        ...(supported ? {} : { reason: "ORC leaf is outside the physical numeric profile." }),
      }),
    );
  }
  meter.retain(32);
  const stripes: OrcStripeType[] = [];
  let end = headerLength, rowOffset = 0;
  for (let id = 0; id < declaredStripes.length; id++) {
    const stripe = declaredStripes[id]!;
    const next = exact(
      BigInt(stripe.offset) + BigInt(stripe.index) + BigInt(stripe.data) + BigInt(stripe.footer),
      "stripe end",
    );
    if (stripe.offset !== end || next > metadataStart || stripe.footer === 0) {
      invalid("ORC stripes overlap, contain unsupported padding, or exceed the body.");
    }
    meter.retain(96);
    stripes.push(
      Object.freeze({
        id,
        offset: stripe.offset,
        rowOffset,
        rows: stripe.rows,
        indexBytes: stripe.index,
        dataBytes: stripe.data,
        footerBytes: stripe.footer,
      }),
    );
    rowOffset = exact(BigInt(rowOffset) + BigInt(stripe.rows), "row count");
    end = next;
  }
  if (end !== metadataStart || rowOffset !== rows) invalid("ORC stripes disagree with body extent or file row count.");
  options.signal?.throwIfAborted();
  return Object.freeze({
    rows,
    columns: Object.freeze(columns),
    stripes: Object.freeze(stripes),
    formatVersion,
    contentLengthBasis,
    integrity: "none",
    work: Object.freeze(budget.inspect()),
    async read(columnId: number, supplied: OrcReadOptionsType = {}): Promise<OrcReadType> {
      const opts = { ...supplied };
      integer(columnId, "ORC column ID");
      const column = columns.find((column) => column.id === columnId);
      if (!column) throw new RangeError("ORC column ID is absent.");
      if (!column.supported) unsupported(column.reason!);
      const signal = options.signal && opts.signal
        ? AbortSignal.any([options.signal, opts.signal])
        : options.signal ?? opts.signal;
      signal?.throwIfAborted();
      const offset = opts.offset ?? 0, length = opts.length ?? rows - offset;
      integer(offset, "ORC row offset");
      integer(length, "ORC row length");
      if (offset > rows || length > rows - offset) throw new RangeError("ORC row selection exceeds the file.");
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
      readMeter.retain(64);
      const selected: SelectedType[] = [];
      let inputBytes = 0, requests = 0, decodedRows = 0;
      for (const stripe of stripes) {
        if (length === 0 || stripe.rowOffset >= offset + length || stripe.rowOffset + stripe.rows <= offset) continue;
        if (stripe.footerBytes > policy.stripeFooter) limit("Stripe footer byte");
        operation.decoded(stripe.footerBytes);
        signal?.throwIfAborted();
        const cursor = new Wire(
          (await operation.read(stripe.offset + stripe.indexBytes + stripe.dataBytes, stripe.footerBytes)).slice(),
          readMeter,
        );
        readMeter.retain(64);
        const streams: Omit<StreamType, "offset">[] = [], encodings: number[] = [];
        cursor.fields({
          1: (t) => {
            if (readMeter.streams >= policy.streams) limit("Stream count");
            readMeter.streams++;
            streams.push(stream(cursor.message(t)));
          },
          2: (t) => {
            if (encodings.length >= types.length) invalid("ORC stripe has excess column encodings.");
            encodings.push(encoding(cursor.message(t)));
          },
          3: (t) => {
            cursor.text(t);
          },
          4: () => unsupported("ORC encrypted stripe variants are unsupported."),
        });
        if (encodings.length !== types.length) invalid("ORC stripe encoding count disagrees with schema.");
        if (encodings[column.id] !== 0) {
          unsupported("ORC selected column requires DIRECT encoding; RLEv2/dictionaries are unsupported.");
        }
        let at = stripe.offset, indexBytes = 0;
        const dataStart = stripe.offset + stripe.indexBytes, footerStart = dataStart + stripe.dataBytes;
        readMeter.retain(streams.length * 16 + 96);
        const identities = new Set<string>();
        let present: StreamType | undefined, data: StreamType | undefined;
        for (const stream of streams) {
          const identity = `${stream.column}:${stream.kind}`;
          if (stream.column >= types.length || identities.has(identity)) {
            invalid("ORC stream column/kind is invalid or repeated.");
          }
          identities.add(identity);
          const next = exact(BigInt(at) + BigInt(stream.length), "stream end");
          const indexStream = stream.kind >= 6;
          if (indexStream) {
            if (at > dataStart || next > dataStart) invalid("ORC index stream exceeds its declared section.");
            indexBytes = exact(BigInt(indexBytes) + BigInt(stream.length), "index stream bytes");
          } else if (at < dataStart || next > footerStart) invalid("ORC data stream exceeds its declared section.");
          if (stream.column === 0 && stream.kind < 6) {
            unsupported("ORC root value/presence streams are outside the flat profile.");
          }
          if (stream.column === column.id && !indexStream) {
            const extent = { ...stream, offset: at };
            if (stream.kind === 0) present = extent;
            else if (stream.kind === 1) data = extent;
            else unsupported("ORC selected numeric column has an unsupported stream role.");
          }
          at = next;
        }
        if (indexBytes !== stripe.indexBytes || at !== footerStart) {
          invalid("ORC stream lengths disagree with stripe sections.");
        }
        const stored = exact(BigInt(present?.length ?? 0) + BigInt(data?.length ?? 0), "selected stream bytes");
        inputBytes = exact(BigInt(inputBytes) + BigInt(stored), "aggregate selected stream bytes");
        if (inputBytes > policy.input) limit("Selected stream byte");
        requests += Number((present?.length ?? 0) !== 0) + Number((data?.length ?? 0) !== 0);
        decodedRows = exact(BigInt(decodedRows) + BigInt(stripe.rows), "decoded rows");
        selected.push({ stripe, ...(present ? { present } : {}), ...(data ? { data } : {}), stored });
      }
      readMeter.admitSteps(decodedRows);
      const current = operation.inspect();
      if (
        inputBytes > operation.limits.maxSourceBytes - current.sourceBytes ||
        requests > operation.limits.maxRequests - current.requests
      ) limit("Selected source/request");
      owners.reserve("sourceBytes", inputBytes);
      owners.reserve("requests", requests);
      credits.sourceBytes = inputBytes;
      credits.requests = requests;
      const outputBytes = exact(BigInt(length) * BigInt(width(column.kind) + 1), "output bytes");
      operation.decoded(inputBytes);
      operation.decoded(
        exact(BigInt(decodedRows) * BigInt(width(column.kind) + 1) + BigInt(outputBytes), "decoded/copy bytes"),
      );
      operation.output(outputBytes);
      signal?.throwIfAborted();
      const output = values(column.kind, length), validity = new Uint8Array(length), evidence: OrcStripeReadType[] = [];
      for (const plan of selected) {
        const read = async (stream: StreamType | undefined): Promise<Uint8Array> =>
          stream && stream.length !== 0
            ? (await operation.read(stream.offset, stream.length)).slice()
            : new Uint8Array();
        const presentBytes = await read(plan.present), dataBytes = await read(plan.data);
        const present = plan.present ? new Bits(presentBytes, readMeter) : undefined;
        const boolean = column.kind === 0 ? new Bits(dataBytes, readMeter) : undefined;
        const byte = column.kind === 1 ? new Bytes(dataBytes, readMeter) : undefined;
        const integers = column.kind >= 2 && column.kind <= 4 ? new Integers(dataBytes, readMeter) : undefined;
        const dataView = view(dataBytes);
        let position = 0, presentCount = 0;
        for (let row = 0; row < plan.stripe.rows; row++) {
          readMeter.step();
          const valid = present ? present.next() : true;
          const target = plan.stripe.rowOffset + row - offset;
          if (!valid) continue;
          presentCount++;
          let value: number | bigint;
          if (boolean) value = Number(boolean.next());
          else if (byte) {
            const raw = byte.next();
            value = raw < 128 ? raw : raw - 256;
          } else if (integers) {
            const raw = integers.next(), bits = width(column.kind) * 8;
            if (raw < -(1n << BigInt(bits - 1)) || raw >= (1n << BigInt(bits - 1))) {
              invalid("ORC integer exceeds its declared signed width.");
            }
            value = column.kind === 4 ? raw : Number(raw);
          } else {
            if (position > dataBytes.length - width(column.kind)) invalid("ORC IEEE value stream is truncated.");
            value = column.kind === 5 ? dataView.getFloat32(position, true) : dataView.getFloat64(position, true);
            position += width(column.kind);
          }
          if (target >= 0 && target < length) {
            validity[target] = 1;
            if (typeof value === "bigint") (output as BigInt64Array)[target] = value;
            else (output as Exclude<OrcValuesType, BigInt64Array>)[target] = value;
          }
        }
        present?.end();
        boolean?.end();
        byte?.end();
        integers?.end();
        if ((column.kind === 5 || column.kind === 6) && position !== dataBytes.length) {
          invalid("ORC IEEE stream has trailing bytes.");
        }
        if (!plan.data && presentCount !== 0) invalid("ORC non-null column values have no DATA stream.");
        readMeter.retain(64);
        evidence.push(
          Object.freeze({
            id: plan.stripe.id,
            rows: plan.stripe.rows,
            selectedRows: Math.max(
              0,
              Math.min(plan.stripe.rowOffset + plan.stripe.rows, offset + length) -
                Math.max(plan.stripe.rowOffset, offset),
            ),
            storedBytes: plan.stored,
            encoding: "DIRECT",
          }),
        );
      }
      signal?.throwIfAborted();
      return {
        values: output,
        validity,
        stripes: Object.freeze(evidence),
        integrity: "none",
        scope: "selected-column-stripes",
        work: operation.inspect(),
      };
    },
  });
}
