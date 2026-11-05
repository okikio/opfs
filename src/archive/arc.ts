/** Bounded Internet Archive ARC 1.0 stored-record inspection, distinct from SEA ARC compression. @module */
import type { ByteSourceType } from "../source.ts";
import { sourceRange } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** A physical ordinal distinguishes repeated captures of the same literal URL. */
export interface ArcEntryType {
  readonly id: number;
  readonly kind: "filedesc" | "record";
  readonly url: string;
  readonly ip: string;
  readonly date: string;
  readonly contentType: string;
  readonly headerOffset: number;
  readonly blockOffset: number;
  readonly size: number;
}
/** The compatibility mode changes descriptor framing only; declared byte extents are never repaired. */
export interface ArcOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Default outside-length. Native IIPC ARCWriter 3.0.5 counts the descriptor's final separator inside its length. */
  readonly filedescSeparator?: "outside-length" | "inside-length";
  /** Default 10000, including the initial descriptor. */ readonly maxEntries?: number;
  /** Default 8192 bytes, hard 65536, excluding LF. */ readonly maxLineBytes?: number;
  /** Default 65536 bytes for the descriptor block, hard 1 MiB. */ readonly maxFiledescBytes?: number;
  /** Header/descriptor bytes plus 128 per entry; default4 MiB. Not an exact JavaScript heap bound. */ readonly maxMetadataBytes?:
    number;
  /** Physical read chunk, default 4096, admitted 1..65536. Lookahead may include block prefixes. */ readonly maxChunkBytes?:
    number;
}
/** An exact range within the stored protocol block, not an HTTP entity range. */
export interface ArcReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
}
/** Successful framing alone supplies no checksum or authenticity evidence. */
export interface ArcReadType {
  readonly bytes: Uint8Array;
  readonly integrity: "none";
  readonly work: ArchiveWorkType;
}
/** Sources and cancellation remain borrowed; the caller keeps the original snapshot available. */
export interface ArcArchiveType {
  readonly format: "internet-archive-arc";
  readonly version: "1.0";
  readonly filedesc: {
    readonly origin: string;
    readonly reserved: "0";
    readonly separator: "outside-length" | "inside-length";
  };
  readonly entries: readonly ArcEntryType[];
  readonly work: ArchiveWorkType;
  readonly provenance: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(id: number, options?: ArcReadOptionsType): Promise<ArcReadType>;
  source(id: number, options?: ArcReadOptionsType): ByteSourceType;
}
function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}
/** Metadata is printable ASCII by policy; binary content is never passed through this decoder. */
function ascii(bytes: Uint8Array): string {
  for (const byte of bytes) {
    if (byte < 32 || byte > 126) unsupported("ARC metadata requires printable ASCII and LF framing.");
  }
  return new TextDecoder().decode(bytes);
}
/** Validate a UTC calendar without Date's silent normalization or network resolution. */
function dateOf(value: string): void {
  if (!/^\d{14}$/.test(value)) invalid("ARC date must contain 14 UTC decimal digits.");
  const year = +value.slice(0, 4);
  const month = +value.slice(4, 6);
  const day = +value.slice(6, 8);
  const hour = +value.slice(8, 10);
  const minute = +value.slice(10, 12);
  const second = +value.slice(12, 14);
  if (second === 60) unsupported("ARC leap-second dates are outside this profile.");
  const days = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    !year || month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59
  ) invalid("Invalid ARC UTC calendar date.");
}
function ipOf(value: string, descriptor: boolean): void {
  if (descriptor && value === "0") return;
  if (value.includes(":")) unsupported("IPv6 ARC metadata is outside this dotted-quad profile.");
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.split(".").some((part) => +part > 255)) {
    invalid("ARC IP metadata must be a dotted-quad IPv4 address.");
  }
}
/** A bounded lookahead cache can include payload bytes; every fetched byte is charged to the opening budget. */
class ArcCursor {
  readonly #size: number;
  readonly #work: ArchiveBudget;
  readonly #chunk: number;
  #start = 0;
  #bytes: Uint8Array = new Uint8Array();
  constructor(size: number, work: ArchiveBudget, chunk: number) {
    this.#size = size;
    this.#work = work;
    this.#chunk = chunk;
  }
  async byte(offset: number): Promise<number> {
    if (offset >= this.#size) invalid("Truncated ARC framing.");
    if (offset < this.#start || offset >= this.#start + this.#bytes.length) {
      this.#start = offset;
      this.#bytes = await this.#work.read(offset, Math.min(this.#chunk, this.#size - offset));
    }
    return this.#bytes[offset - this.#start]!;
  }
  async line(offset: number, maximum: number): Promise<{ text: string; next: number; bytes: number }> {
    const result = new Uint8Array(Math.min(maximum, this.#size - offset));
    let count = 0;
    while (true) {
      const byte = await this.byte(offset + count);
      if (byte === 10) {
        this.#work.decoded(count + 1);
        return { text: ascii(result.subarray(0, count)), next: offset + count + 1, bytes: count + 1 };
      }
      cap(count + 1, maximum, "ARC metadata line bytes");
      result[count++] = byte;
    }
  }
}
function ledgerOf(options: ArchiveLimitsType): ArchiveLedgerType {
  const local = createArchiveLedger(options);
  const outer = options.ledger;
  return {
    reserve(kind, count) {
      local.reserve(kind, count);
      outer?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
}
/** Admit the complete selected range and allocation before acquiring any underlying extent. */
async function bytesOf(
  source: ByteSourceType,
  offset: number,
  length: number,
  options: ArcReadOptionsType,
  chunk: number,
): Promise<ArcReadType> {
  sourceRange(source.size, offset, length);
  options.signal?.throwIfAborted();
  const outer = options.ledger;
  const work = new ArchiveBudget(source, {
    ...options,
    ...(outer
      ? {
        ledger: {
          reserve(kind, count) {
            if (kind !== "sourceBytes" && kind !== "requests") outer.reserve(kind, count);
          },
          inspect: () => outer.inspect(),
        },
      }
      : {}),
  }, options.signal);
  cap(length, work.limits.maxSourceBytes, "ARC source bytes");
  cap(Math.ceil(length / chunk), work.limits.maxRequests, "ARC requests");
  outer?.reserve("sourceBytes", length);
  outer?.reserve("requests", Math.ceil(length / chunk));
  work.decoded(length);
  work.output(length);
  const bytes = new Uint8Array(length);
  for (let done = 0; done < length;) {
    const part = await work.read(offset + done, Math.min(chunk, length - done));
    bytes.set(part, done);
    done += part.length;
  }
  options.signal?.throwIfAborted();
  return { bytes, integrity: "none", work: work.inspect() };
}
/** Index a single uncompressed ARC 1.0 file, then expose exact stored block ranges without fetching any URL. */
export async function openArc(input: ByteSourceType, options: ArcOpenOptionsType = {}): Promise<ArcArchiveType> {
  options = { ...options };
  const { size, identity, stability } = input;
  integer(size, "ARC source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown ARC source stability evidence.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("ARC requires a stable source or explicit unverified-source acceptance.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("ARC identity must be a string of at most 8192 UTF16 code units.");
  }
  const source: ByteSourceType = {
    size,
    read: input.read.bind(input),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  const policy = {
    entries: options.maxEntries ?? 10000,
    line: options.maxLineBytes ?? 8192,
    filedesc: options.maxFiledescBytes ?? 65536,
    metadata: options.maxMetadataBytes ?? 4 * 1024 * 1024,
    chunk: options.maxChunkBytes ?? 4096,
  };
  for (const [key, value] of Object.entries(policy)) integer(value, key);
  if (
    policy.line < 1 || policy.line > 65536 || policy.filedesc > 1024 * 1024 || policy.chunk < 1 || policy.chunk > 65536
  ) throw new RangeError("ARC line/filedesc/chunk implementation ceiling exceeded.");
  const separator = options.filedescSeparator ?? "outside-length";
  if (separator !== "outside-length" && separator !== "inside-length") {
    throw new TypeError("Unknown ARC filedesc separator policy.");
  }
  const ledger = ledgerOf(options);
  const work = new ArchiveBudget(source, { ...options, ledger }, options.signal);
  const cursor = new ArcCursor(size, work, policy.chunk);
  cap(1, policy.entries, "ARC entries");
  cap(129, policy.metadata, "ARC retained metadata");
  const entries: ArcEntryType[] = [];
  let offset = 0;
  let retained = 0;
  let origin = "";
  if (size >= 2 && (await cursor.byte(0)) === 31 && (await cursor.byte(1)) === 139) {
    unsupported("Compose gzip decoding separately before ARC indexing.");
  }
  while (offset < size) {
    cap(entries.length + 1, policy.entries, "ARC entries");
    cap(129, policy.metadata - retained, "ARC retained metadata");
    // Line admission excludes LF, but retained metadata includes LF and the record overhead.
    const line = await cursor.line(offset, Math.min(policy.line, policy.metadata - retained - 129));
    if (!line.text) invalid("Unexpected blank ARC record header.");
    const fields = line.text.split(" ");
    if (fields.length !== 5 || fields.some((field) => !field)) {
      invalid("ARC 1.0 requires exactly five nonempty ASCII space-separated fields.");
    }
    const [url, ip, date, contentType, length] = fields as [string, string, string, string, string];
    const descriptor = url.startsWith("filedesc://");
    if (!entries.length && (!descriptor || url.length === 11)) {
      invalid("ARC must begin with a nonempty filedesc:// URL record.");
    }
    if (entries.length && descriptor) unsupported("Concatenated ARC files require a separate explicit profile.");
    if (!/^\d+$/.test(length)) invalid("ARC block length must be an unsigned decimal integer.");
    const blockSize = Number(length);
    integer(blockSize, "ARC block length");
    if (blockSize > size - line.next) invalid("ARC declared block exceeds source.");
    dateOf(date);
    ipOf(ip, descriptor);
    retained += line.bytes + 128;
    let end = line.next + blockSize;
    if (descriptor) {
      if (contentType !== "text/plain") invalid("ARC filedesc must declare text/plain.");
      cap(blockSize, policy.filedesc, "ARC filedesc bytes");
      cap(blockSize, policy.metadata - retained, "ARC retained metadata");
      // The descriptor is small retained metadata; ordinary blocks are skipped by physical length.
      work.decoded(blockSize);
      const bytes = new Uint8Array(blockSize);
      for (let index = 0; index < blockSize; index++) bytes[index] = await cursor.byte(line.next + index);
      retained += blockSize;
      const first = bytes.indexOf(10);
      const second = bytes.indexOf(10, first + 1);
      if (first < 0 || second < 0) invalid("ARC filedesc lacks two LF-terminated metadata lines.");
      const version = ascii(bytes.subarray(0, first));
      const match = /^([0-9]+) ([^ ]+) (.+)$/.exec(version);
      if (!match) invalid("Malformed ARC filedesc version record.");
      if (match[1] !== "1" || match[2] !== "0") {
        unsupported(
          "Only ARC 1.0 filedesc version 1 reserved 0 is supported; metadata extensions remain opaque unsupported profiles.",
        );
      }
      origin = match[3]!;
      if (ascii(bytes.subarray(first + 1, second)) !== "URL IP-address Archive-date Content-type Archive-length") {
        invalid("Unsupported ARC 1.0 URL-record field definition.");
      }
      if (separator === "inside-length") {
        if (second + 2 !== bytes.length || bytes[second + 1] !== 10) {
          invalid("ARC inside-length filedesc must contain exactly one final blank LF.");
        }
      } else {
        if (second + 1 !== bytes.length) {
          invalid("ARC outside-length filedesc cannot contain extra metadata or a counted separator.");
        }
        if (await cursor.byte(end) !== 10) invalid("ARC record requires an outside-length LF separator.");
        end++;
      }
    } else {
      if (await cursor.byte(end) !== 10) invalid("ARC record requires an outside-length LF separator.");
      end++;
    }
    entries.push(
      Object.freeze({
        id: entries.length,
        kind: descriptor ? "filedesc" : "record",
        url,
        ip,
        date,
        contentType,
        headerOffset: offset,
        blockOffset: line.next,
        size: blockSize,
      }),
    );
    offset = end;
  }
  if (!entries.length) invalid("ARC source has no filedesc record.");
  function entryOf(id: number): ArcEntryType {
    integer(id, "ARC record ID");
    const entry = entries[id];
    if (!entry) throw new RangeError("Unknown ARC record ID.");
    return entry;
  }
  function operation(call: ArcReadOptionsType): ArcReadOptionsType {
    const local = createArchiveLedger(call);
    const extra = call.ledger;
    return {
      ...call,
      ledger: {
        reserve(kind, count) {
          local.reserve(kind, count);
          ledger.reserve(kind, count);
          if (extra && extra !== options.ledger) extra.reserve(kind, count);
        },
        inspect: () => local.inspect(),
      },
      ...(call.signal ? { signal: call.signal } : options.signal ? { signal: options.signal } : {}),
    };
  }
  return Object.freeze({
    format: "internet-archive-arc",
    version: "1.0",
    filedesc: Object.freeze({ origin, reserved: "0", separator }),
    entries: Object.freeze(entries),
    work: work.inspect(),
    provenance: Object.freeze({
      ...(identity === undefined ? {} : { identity }),
      stability: stability ?? "unverified",
    }),
    async read(id: number, call: ArcReadOptionsType = {}): Promise<ArcReadType> {
      call = { ...call };
      const entry = entryOf(id);
      const offset = call.offset ?? 0;
      const length = call.length ?? entry.size - offset;
      sourceRange(entry.size, offset, length);
      return await bytesOf(source, entry.blockOffset + offset, length, operation(call), policy.chunk);
    },
    source(id: number, call: ArcReadOptionsType = {}): ByteSourceType {
      call = { ...call };
      const entry = entryOf(id);
      const offset = call.offset ?? 0;
      const length = call.length ?? entry.size - offset;
      sourceRange(entry.size, offset, length);
      const captured = operation(call);
      const physical = entry.blockOffset + offset;
      const selectedSize = length;
      return Object.freeze({
        size: length,
        ...(identity === undefined
          ? {}
          : { identity: JSON.stringify([identity, "internet-archive-arc", physical, length]) }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, readOptions: { signal?: AbortSignal } = {}) {
          sourceRange(selectedSize, offset, length);
          const signal = captured.signal && readOptions.signal
            ? AbortSignal.any([captured.signal, readOptions.signal])
            : readOptions.signal ?? captured.signal;
          return (await bytesOf(
            source,
            physical + offset,
            length,
            { ...captured, ...(signal ? { signal } : {}) },
            policy.chunk,
          )).bytes;
        },
      });
    },
  });
}
