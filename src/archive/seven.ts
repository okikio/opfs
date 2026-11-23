/** Bounded 7z indexing with COPY and single-stream LZMA reads. @module */
import { createLzmaDecoder } from "./lzma.ts";
import type { LzmaFormatType, LzmaLimitsType } from "./lzma.ts";
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
} from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

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

/** Refuse precision loss before converting a serialized 64-bit offset/count to JavaScript indexing. */
function exact(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
    unsupported("7z integer exceeds exact JavaScript indexing.");
  }
  return Number(value);
}
function add(left: number, right: number): number {
  return exact(BigInt(left) + BigInt(right));
}
function checksum(bytes: Uint8Array): number {
  return (crc32(bytes) ^ 0xffffffff) >>> 0;
}

/** Counts bound materialized records; string copies share the header-byte admission owner. */
class Admission {
  readonly max: {
    header: number;
    entries: number;
    folders: number;
    coders: number;
    streams: number;
    properties: number;
    name: number;
  };
  #copies = 0;
  #coders = 0;
  #streams = 0;
  #properties = 0;
  constructor(options: SevenOpenOptionsType) {
    this.max = {
      header: options.maxHeaderBytes ?? 8 * 1024 * 1024,
      entries: options.maxEntries ?? 100000,
      folders: options.maxFolders ?? 4096,
      coders: options.maxCoders ?? 4096,
      streams: options.maxStreams ?? 100000,
      properties: options.maxProperties ?? 100000,
      name: options.maxNameBytes ?? 65536,
    };
    for (const [name, value] of Object.entries(this.max)) integer(value, name);
  }
  count(value: number, maximum: number): void {
    if (value > maximum) throw new ArchiveError("budget-exceeded", "7z metadata admission limit exceeded.");
  }
  copies(value: number): void {
    this.count(value, this.max.header - this.#copies);
    this.#copies += value;
  }
  coders(value: number): void {
    this.count(value, this.max.coders - this.#coders);
    this.#coders += value;
  }
  streams(value: number): void {
    this.count(value, this.max.streams - this.#streams);
    this.#streams += value;
  }
  property(): void {
    this.count(1, this.max.properties - this.#properties);
    this.#properties++;
  }
}

/** Every property gets an extent-limited cursor. Underflow and unconsumed bytes cannot bleed into its neighbor. */
class Cursor {
  readonly #bytes: Uint8Array;
  #at = 0;
  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }
  get remaining(): number {
    return this.#bytes.length - this.#at;
  }
  byte(): number {
    return this.take(1)[0]!;
  }
  take(size: number): Uint8Array {
    integer(size, "7z property size");
    if (size > this.remaining) invalid("7z metadata extent is truncated.");
    const result = this.#bytes.subarray(this.#at, this.#at + size);
    this.#at += size;
    return result;
  }
  name(maximum: number): Uint8Array {
    const start = this.#at;
    while (true) {
      if (this.#at - start + 2 > maximum) throw new ArchiveError("budget-exceeded", "7z filename limit exceeded.");
      const unit = this.take(2);
      if (unit[0] === 0 && unit[1] === 0) return this.#bytes.subarray(start, this.#at - 2);
    }
  }
  number(): number {
    const first = this.byte();
    let mask = 128;
    let result = 0n;
    for (let index = 0; index < 8; index++) {
      if ((first & mask) === 0) return exact(result + (BigInt(first & (mask - 1)) << BigInt(index * 8)));
      result += BigInt(this.byte()) << BigInt(index * 8);
      mask >>= 1;
    }
    return exact(result);
  }
  u32(): number {
    return view(this.take(4)).getUint32(0, true);
  }
  u64(): bigint {
    return view(this.take(8)).getBigUint64(0, true);
  }
  expect(id: number): void {
    if (this.number() !== id) unsupported("7z metadata form or property order is unsupported.");
  }
  end(): void {
    if (this.remaining !== 0) invalid("7z property has unconsumed bytes.");
  }
  bits(count: number): boolean[] {
    const raw = this.take(Math.ceil(count / 8));
    if (count % 8 && (raw[raw.length - 1]! & ((1 << (8 - count % 8)) - 1)) !== 0) {
      invalid("7z bit-vector padding must be zero.");
    }
    return Array.from({ length: count }, (_, index) => (raw[index >> 3]! & (128 >> (index & 7))) !== 0);
  }
  defined(count: number): boolean[] {
    const all = this.byte();
    if (all > 1) invalid("7z all-defined flag must be zero or one.");
    return all ? Array.from({ length: count }, () => true) : this.bits(count);
  }
  digests(count: number): (number | undefined)[] {
    return this.defined(count).map((defined) => defined ? this.u32() : undefined);
  }
}
interface StreamType {
  size: number;
  crc: number | undefined;
  origin: "substream" | "folder";
}
interface FolderType {
  coders: SevenCoderType[];
  output: number;
  size: number;
  crc: number | undefined;
  streams: StreamType[];
}

/** Linear one-input/one-output graphs are fully connected and acyclic, not merely count-compatible. */
function folder(cursor: Cursor, admission: Admission): FolderType {
  const count = cursor.number();
  admission.coders(count);
  if (count === 0) invalid("7z folders require a coder.");
  const coders: SevenCoderType[] = [];
  for (let id = 0; id < count; id++) {
    const flags = cursor.byte();
    const idSize = flags & 15;
    if ((flags & 0xc0) !== 0 || idSize === 0 || idSize > 8) {
      unsupported("7z coder identifier/alternative form is unsupported.");
    }
    const methodBytes = cursor.take(idSize);
    if (flags & 0x10) {
      if (cursor.number() !== 1 || cursor.number() !== 1) {
        unsupported("7z complex/multi-input coder graphs are unsupported.");
      }
    }
    const properties = flags & 0x20 ? cursor.take(cursor.number()) : new Uint8Array();
    admission.copies((methodBytes.length + properties.length) * 4); // Two hex chars, up to two logical bytes per char.
    const hex = (bytes: Uint8Array): string => {
      let result = "";
      for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
      return result;
    };
    coders.push(Object.freeze({ method: hex(methodBytes), properties: hex(properties) }));
  }
  const inputs = new Set<number>();
  const outputs = new Set<number>();
  const edges = new Map<number, number>();
  for (let index = 0; index < count - 1; index++) {
    const input = cursor.number();
    const output = cursor.number();
    if (input >= count || output >= count || inputs.has(input) || outputs.has(output)) {
      invalid("7z coder bindings are invalid or repeated.");
    }
    inputs.add(input);
    outputs.add(output);
    edges.set(output, input);
  }
  let first = -1;
  let last = -1;
  for (let index = 0; index < count; index++) {
    if (!inputs.has(index)) first = index;
    if (!outputs.has(index)) last = index;
  }
  const visited = new Set<number>();
  let current: number | undefined = first;
  while (current !== undefined) {
    if (visited.has(current)) invalid("7z coder graph contains a cycle.");
    visited.add(current);
    const next = edges.get(current);
    if (next === undefined && current !== last) invalid("7z coder graph has an invalid final output.");
    current = next;
  }
  if (visited.size !== count) invalid("7z coder graph is disconnected.");
  return { coders, output: last, size: 0, crc: undefined, streams: [] };
}

/** Read a supported StreamsInfo without acquiring or decoding a packed payload. */
function streams(
  cursor: Cursor,
  admission: Admission,
): { position: number; sizes: number[]; crcs: (number | undefined)[]; folders: FolderType[] } {
  cursor.expect(6);
  const position = cursor.number();
  const count = cursor.number();
  admission.streams(count);
  cursor.expect(9);
  const sizes = Array.from({ length: count }, () => cursor.number());
  let tag = cursor.number();
  let crcs: (number | undefined)[] = Array.from({ length: count }, () => undefined);
  if (tag === 10) {
    crcs = cursor.digests(count);
    tag = cursor.number();
  }
  if (tag !== 0) unsupported("7z packed stream metadata is unsupported.");
  cursor.expect(7);
  cursor.expect(11);
  const foldersCount = cursor.number();
  admission.count(foldersCount, admission.max.folders);
  if (cursor.byte() !== 0) unsupported("7z external folder metadata is unsupported.");
  const folders = Array.from({ length: foldersCount }, () => folder(cursor, admission));
  if (foldersCount !== count) unsupported("7z profile requires one packed stream per linear folder.");
  cursor.expect(12);
  for (const item of folders) {
    const unpacked = item.coders.map(() => cursor.number());
    item.size = unpacked[item.output]!;
  }
  tag = cursor.number();
  if (tag === 10) {
    const values = cursor.digests(foldersCount);
    folders.forEach((item, index) => {
      item.crc = values[index];
    });
    tag = cursor.number();
  }
  if (tag !== 0) unsupported("7z folder unpack metadata is unsupported.");
  tag = cursor.number();
  let counts = folders.map(() => 1);
  if (tag === 8) {
    tag = cursor.number();
    if (tag === 13) {
      counts = folders.map(() => cursor.number());
      tag = cursor.number();
    }
    let total = 0;
    for (const value of counts) total = add(total, value);
    admission.streams(total);
    const needsSizes = counts.some((value) => value > 1);
    if (needsSizes && tag !== 9) invalid("7z multi-substream sizes are missing.");
    for (let index = 0; index < folders.length; index++) {
      const item = folders[index]!;
      const count = counts[index]!;
      if (count === 0) unsupported("7z zero-substream folders are unsupported.");
      let used = 0;
      for (let stream = 0; stream < count; stream++) {
        const size = stream === count - 1 ? item.size - used : cursor.number();
        if (size < 0 || size > item.size - used) invalid("7z substreams exceed the folder extent.");
        used = add(used, size);
        item.streams.push({
          size,
          crc: count === 1 ? item.crc : undefined,
          origin: count === 1 && item.crc !== undefined ? "folder" : "substream",
        });
      }
    }
    if (tag === 9) tag = cursor.number();
    const missing = folders.reduce(
      (sum, item) => add(sum, item.streams.length === 1 && item.crc !== undefined ? 0 : item.streams.length),
      0,
    );
    if (tag === 10) {
      const digests = cursor.digests(missing);
      let at = 0;
      for (const item of folders) {
        if (!(item.streams.length === 1 && item.crc !== undefined)) {
          for (const stream of item.streams) stream.crc = digests[at++];
        }
      }
      tag = cursor.number();
    }
    if (tag !== 0) unsupported("7z substream metadata is unsupported.");
    cursor.expect(0);
  } else {
    if (tag !== 0) unsupported("7z stream metadata is unsupported.");
    admission.streams(folders.length);
    for (const item of folders) {
      item.streams.push({ size: item.size, crc: item.crc, origin: item.crc === undefined ? "substream" : "folder" });
    }
  }
  return { position, sizes, crcs, folders };
}

/** Inline file properties never resolve additional streams or host metadata. */
function files(
  cursor: Cursor,
  admission: Admission,
): {
  names: string[];
  empty: boolean[];
  emptyFile: boolean[];
  anti: boolean[];
  attributes: (number | undefined)[];
  mtime: (bigint | undefined)[];
} {
  const count = cursor.number();
  admission.count(count, admission.max.entries);
  const properties = new Map<number, Uint8Array>();
  while (true) {
    const id = cursor.number();
    if (id === 0) break;
    admission.property();
    if (id === 25) {
      const padding = cursor.take(cursor.number());
      if (padding.some((byte) => byte !== 0)) invalid("7z Dummy padding contains nonzero bytes.");
      continue;
    }
    if (properties.has(id)) invalid("7z file property is duplicated.");
    if (![14, 15, 16, 17, 18, 19, 20, 21, 22, 25].includes(id)) {
      unsupported("7z file property semantics are unsupported.");
    }
    properties.set(id, cursor.take(cursor.number()));
  }
  const bits = (id: number, length: number): boolean[] => {
    const value = properties.get(id);
    if (!value) return Array.from({ length }, () => false);
    const field = new Cursor(value);
    const result = field.bits(length);
    field.end();
    return result;
  };
  const empty = bits(14, count);
  const emptyCount = empty.filter(Boolean).length;
  const emptyFile = bits(15, emptyCount);
  const anti = bits(16, emptyCount);
  const names: string[] = [];
  const encoded = properties.get(17);
  if (count > 0 && !encoded) unsupported("7z names must be present inline for this profile.");
  if (encoded) {
    const field = new Cursor(encoded);
    if (field.byte() !== 0) unsupported("7z external filename streams are unsupported.");
    for (let id = 0; id < count; id++) {
      const raw = field.name(admission.max.name);
      if (raw.length === 0) unsupported("7z empty names are unsupported.");
      admission.copies(raw.length);
      try {
        names.push(new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(raw));
      } catch {
        return unsupported("7z filename contains invalid UTF-16.");
      }
    }
    field.end();
  }
  let attributes: (number | undefined)[] = Array.from({ length: count }, () => undefined);
  let mtime: (bigint | undefined)[] = Array.from({ length: count }, () => undefined);
  for (const id of [18, 19, 20, 21]) {
    const value = properties.get(id);
    if (!value) continue;
    const field = new Cursor(value);
    const defined = field.defined(count);
    if (field.byte() !== 0) unsupported("7z external attribute/time streams are unsupported.");
    if (id === 21) attributes = defined.map((present) => present ? field.u32() : undefined);
    else {
      const values = defined.map((present) => present ? field.u64() : undefined);
      if (id === 20) mtime = values;
    }
    field.end();
  }
  return { names, empty, emptyFile, anti, attributes, mtime };
}

/** Select a frozen codec from exact method properties; no registry or caller-supplied decoder runs. */
function codec(coder: SevenCoderType): Exclude<LzmaFormatType, { format: "alone" }> | undefined {
  const count = coder.method === "030101" ? 5 : coder.method === "21" ? 1 : 0;
  if (count === 0) return undefined;
  if (coder.properties.length !== count * 2) invalid("7z LZMA coder property length is invalid.");
  const bytes = new Uint8Array(count);
  for (let at = 0; at < count; at++) bytes[at] = Number.parseInt(coder.properties.slice(at * 2, at * 2 + 2), 16);
  if (coder.method === "030101") {
    if (bytes.length !== 5 || bytes[0]! >= 225) invalid("7z LZMA1 properties must contain five valid bytes.");
    const lc = bytes[0]! % 9;
    const lp = Math.floor(bytes[0]! / 9) % 5;
    if (lc + lp > 4) return undefined;
    return { format: "raw-lzma1", properties: bytes, marker: "optional" };
  }
  if (coder.method === "21") {
    if (bytes.length !== 1 || bytes[0]! > 40) invalid("7z LZMA2 properties must contain one valid dictionary byte.");
    return { format: "raw-lzma2", dictionary: bytes[0]! };
  }
  return undefined;
}

/** Retain only codec policy fields. Container framing and work owners cannot be overwritten by foreign options. */
function codecPolicy(options: SevenLzmaOptionsType = {}): SevenLzmaOptionsType {
  const result: Record<string, unknown> = {};
  for (
    const key of [
      "maxDictionaryBytes",
      "maxMemoryBytes",
      "maxDecisions",
      "maxSteps",
      "maxChunks",
      "inputChunkBytes",
      "yield",
    ] as const
  ) {
    if (options[key] !== undefined) result[key] = options[key];
  }
  return result;
}

/** Decoding visits one packed extent from its start. Packed and plaintext CRCs never share an accumulator.
 * The container charges source operations and selected output; the codec charges decoded work through the relay.
 * Decoder output is bounded scan work, not a second charge against returned archive bytes. */
async function decode(
  snapshot: ByteSourceType,
  pack: SevenPackType,
  coder: SevenCoderType,
  size: number,
  offset: number,
  length: number,
  verify: boolean,
  budget: ArchiveBudget,
  policy: SevenLzmaOptionsType,
  signal?: AbortSignal,
  selectedOutput = true,
  decodedCredit = 0,
): Promise<{ bytes: Uint8Array; complete: boolean; packed: number; plain: number }> {
  const framing = codec(coder);
  if (!framing) unsupported("7z coder is outside the supported LZMA profile.");
  if (selectedOutput) budget.output(length);
  signal?.throwIfAborted();
  const output = new Uint8Array(length);
  if (!verify && length === 0) return { bytes: output, complete: false, packed: 0, plain: 0 };
  let packedState = 0xffffffff;
  let plainState = 0xffffffff;
  let packedRead = 0;
  const source: ByteSourceType = {
    size: pack.size,
    stability: snapshot.stability ?? "caller",
    async read(at, count) {
      if (at !== packedRead) invalid("7z decoder requested a nonsequential packed range.");
      const bytes = await budget.read(add(pack.offset, at), count);
      packedState = crc32(bytes, packedState);
      packedRead += count;
      return bytes;
    },
  };
  const relay: ArchiveLedgerType = {
    reserve(kind, count) {
      if (kind === "decodedBytes") {
        const credit = Math.min(decodedCredit, count);
        decodedCredit -= credit;
        budget.decoded(count - credit);
      }
    },
    inspect: () => budget.inspect(),
  };
  const decoder = createLzmaDecoder(source, {
    ...policy,
    ...framing,
    size,
    maxSourceBytes: budget.limits.maxSourceBytes,
    maxRequests: budget.limits.maxRequests,
    maxDecodedBytes: budget.limits.maxDecodedBytes,
    maxOutputBytes: size,
    ledger: relay,
    ...(signal === undefined ? {} : { signal }),
  });
  const reader = decoder.stream.getReader();
  let at = 0;
  let complete = false;
  let failed = false;
  let primary: unknown;
  const retain = (reason: unknown): void => {
    if (failed && reason === primary) return; // A second observation of this decoder's single terminal promise.
    primary = failed ? new AggregateError([primary, reason], "7z decode and retirement failed.") : reason;
    failed = true;
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        break;
      }
      const bytes = result.value;
      plainState = crc32(bytes, plainState);
      const end = add(at, bytes.length);
      const from = Math.max(at, offset);
      const until = Math.min(end, offset + length);
      if (until > from) output.set(bytes.subarray(from - at, until - at), from - offset);
      at = end;
      if (!verify && offset + length < size && at >= offset + length) break;
    }
  } catch (reason) {
    retain(reason);
  }
  if (!complete) {
    try {
      await reader.cancel();
    } catch (reason) {
      retain(reason);
    }
  }
  try {
    const terminal = await decoder.finished;
    if (terminal.status === "complete") complete = true;
  } catch (reason) {
    retain(reason);
  }
  reader.releaseLock();
  if (failed) throw primary;
  if (complete && (at !== size || packedRead !== pack.size)) invalid("7z decoded extent is incomplete.");
  return { bytes: output, complete, packed: (packedState ^ 0xffffffff) >>> 0, plain: (plainState ^ 0xffffffff) >>> 0 };
}

/** Index plain or bounded single-coder encoded headers; mandatory metadata CRCs remain separate from member checks. */
export async function openSeven(
  source: ByteSourceType,
  supplied: SevenOpenOptionsType = {},
): Promise<SevenArchiveType> {
  const options = { ...supplied, lzma: codecPolicy(supplied.lzma) };
  const { size, identity, stability } = source;
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown 7z source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("7z source identity must be a bounded string.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("7z requires source stability or explicit unverified-source acceptance.");
  }
  const admission = new Admission(options);
  admission.copies(32);
  const snapshot: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity: identity }),
    ...(stability === undefined ? {} : { stability: stability }),
    read: source.read.bind(source),
  };
  const local = createArchiveLedger(options);
  const openingLedger = options.ledger;
  const lifetime: ArchiveLedgerType = {
    reserve(kind, count) {
      local.reserve(kind, count);
      openingLedger?.reserve(kind, count);
    },
    inspect: () => local.inspect(),
  };
  const budget = new ArchiveBudget(snapshot, { ...options, ledger: lifetime }, options.signal);
  const signature = await budget.read(0, 32);
  budget.decoded(32);
  const start = view(signature);
  if (![55, 122, 188, 175, 39, 28].every((byte, index) => signature[index] === byte)) {
    invalid("7z signature must begin at source offset zero.");
  }
  if (signature[6] !== 0 || signature[7] !== 4) unsupported("Only 7z archive version 0.4 is supported.");
  if (checksum(signature.subarray(12, 32)) !== start.getUint32(8, true)) {
    throw new ArchiveError("checksum-mismatch", "7z start-header CRC mismatch.");
  }
  const headerAt = add(32, exact(start.getBigUint64(12, true)));
  const headerSize = exact(start.getBigUint64(20, true));
  if (headerAt > snapshot.size || headerSize !== snapshot.size - headerAt) {
    invalid("7z next header must fit and end at the full source extent.");
  }
  admission.copies(headerSize);
  let bytes = await budget.read(headerAt, headerSize);
  budget.decoded(headerSize);
  if (checksum(bytes) !== start.getUint32(28, true)) {
    throw new ArchiveError("checksum-mismatch", "7z next-header CRC mismatch.");
  }
  let payloadEnd = headerAt;
  let decodedHeader: SevenArchiveType["headers"]["decoded"];
  if (headerSize > 0 && bytes[0] === 23) {
    const encoded = new Cursor(bytes);
    encoded.expect(23);
    const data = streams(encoded, admission);
    encoded.end();
    if (data.folders.length !== 1 || data.sizes.length !== 1) {
      unsupported("7z encoded header requires one folder/pack.");
    }
    const item = data.folders[0]!;
    if (item.coders.length !== 1 || item.streams.length !== 1 || !codec(item.coders[0]!)) {
      unsupported("7z encoded header requires one supported LZMA coder/substream.");
    }
    const offset = add(32, data.position);
    const size = data.sizes[0]!;
    if (offset > headerAt || size !== headerAt - offset) {
      invalid("7z encoded header pack must end at its outer header.");
    }
    const checks: { scope: SevenCheckType["scope"]; crc: number }[] = [];
    if (data.crcs[0] !== undefined) checks.push({ scope: "pack", crc: data.crcs[0]! });
    if (item.crc !== undefined) checks.push({ scope: "folder", crc: item.crc });
    if (item.streams[0]!.crc !== undefined && item.streams[0]!.origin !== "folder") {
      checks.push({ scope: "substream", crc: item.streams[0]!.crc! });
    }
    if (!checks.some((check) => check.scope !== "pack")) unsupported("7z encoded header requires a decoded CRC.");
    admission.copies(add(size, item.size));
    // Reserve the retained decoded header before allocation, including aggregate admission.
    // The relay consumes this credit, then charges any additional LZMA2 framing work once.
    budget.decoded(item.size);
    const result = await decode(
      snapshot,
      { id: 0, offset, size },
      item.coders[0]!,
      item.size,
      0,
      item.size,
      true,
      budget,
      options.lzma,
      options.signal,
      false,
      item.size,
    );
    for (const check of checks) {
      if (check.crc !== (check.scope === "pack" ? result.packed : result.plain)) {
        throw new ArchiveError("checksum-mismatch", "7z encoded header CRC mismatch.");
      }
    }
    bytes = result.bytes;
    if (bytes[0] !== 1) unsupported("7z decoded header must be one unencoded Header.");
    decodedHeader = Object.freeze({
      method: item.coders[0]!.method,
      integrity: "crc32-verified",
      checks: Object.freeze(checks.map((check) => Object.freeze({ ...check, status: "crc32-verified" as const }))),
    });
    payloadEnd = offset;
  }
  const packs: SevenPackType[] = [];
  const publicFolders: SevenFolderType[] = [];
  const entries: SevenEntryType[] = [];
  if (headerSize > 0) {
    const cursor = new Cursor(bytes);
    const marker = cursor.number();
    if (marker === 23) unsupported("7z recursively encoded headers are unsupported.");
    if (marker !== 1) unsupported("7z next-header profile is unsupported.");
    let tag = cursor.number();
    if (tag === 2) {
      while (true) {
        const id = cursor.number();
        if (id === 0) break;
        admission.property();
        cursor.take(cursor.number());
      }
      tag = cursor.number();
    }
    if (tag === 3) unsupported("7z additional/external metadata streams are unsupported.");
    let streamData: ReturnType<typeof streams> = { position: 0, sizes: [], crcs: [], folders: [] };
    if (tag === 4) {
      streamData = streams(cursor, admission);
      tag = cursor.number();
    }
    if (tag !== 5) unsupported("7z files metadata is required for this profile.");
    const info = files(cursor, admission);
    cursor.expect(0);
    cursor.end();
    let physical = add(32, streamData.position);
    if (physical > payloadEnd) invalid("7z pack base exceeds the payload region.");
    for (let id = 0; id < streamData.sizes.length; id++) {
      const size = streamData.sizes[id]!;
      if (physical > payloadEnd || size > payloadEnd - physical) {
        invalid("7z packed stream exceeds the pre-header payload region.");
      }
      const crc = streamData.crcs[id];
      packs.push(Object.freeze({ id, offset: physical, size, ...(crc === undefined ? {} : { crc }) }));
      physical = add(physical, size);
    }
    for (let id = 0; id < streamData.folders.length; id++) {
      const item = streamData.folders[id]!;
      const pack = packs[id]!;
      const copy = item.coders.length === 1 && item.coders[0]!.method === "00" && item.coders[0]!.properties === "";
      if (copy && item.size !== pack.size) invalid("7z COPY folder has different packed and unpacked sizes.");
      const compressed = item.coders.length === 1 && codec(item.coders[0]!) !== undefined;
      const known = item.coders.every((coder) => ["00", "21", "030101", "040108", "040202"].includes(coder.method));
      const encrypted = item.coders.some((coder) => coder.method === "06f10701") ? true : known ? false : "unknown";
      publicFolders.push(
        Object.freeze({
          id,
          coders: Object.freeze(item.coders),
          size: item.size,
          packId: id,
          substreams: item.streams.length,
          solid: item.streams.length > 1,
          encrypted,
          readable: (copy || compressed) && item.streams.length === 1,
          ...(item.crc === undefined ? {} : { crc: item.crc }),
        }),
      );
    }
    const substreams: { folder: number; offset: number; stream: StreamType }[] = [];
    streamData.folders.forEach((item, folder) => {
      let offset = 0;
      for (const stream of item.streams) {
        substreams.push({ folder, offset, stream });
        offset = add(offset, stream.size);
      }
    });
    let streamIndex = 0;
    let emptyIndex = 0;
    for (let id = 0; id < info.names.length; id++) {
      const attributes = info.attributes[id];
      const mtime = info.mtime[id];
      const isEmpty = info.empty[id]!;
      const emptyFile = isEmpty ? info.emptyFile[emptyIndex]! : false;
      const anti = isEmpty ? info.anti[emptyIndex++]! : false;
      const substream = isEmpty ? undefined : substreams[streamIndex++];
      if (!isEmpty && !substream) invalid("7z file count exceeds available substreams.");
      let kind: SevenEntryType["kind"] = anti ? "anti" : isEmpty && !emptyFile ? "directory" : "file";
      if (attributes !== undefined) {
        const mode = (attributes >>> 16) & 0xf000;
        if (attributes & 0x400) kind = "special";
        else if (attributes & 0x8000) {
          if (mode === 0xa000) kind = "symbolic-link";
          else if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) kind = "special";
        }
      }
      entries.push(
        Object.freeze({
          id,
          name: info.names[id]!,
          kind,
          size: substream?.stream.size ?? 0,
          readable: kind === "file" && (!substream || publicFolders[substream.folder]!.readable),
          ...(substream === undefined ? {} : { folderId: substream.folder, folderOffset: substream.offset }),
          ...(substream?.stream.crc === undefined
            ? {}
            : { crc: substream.stream.crc, crcSource: substream.stream.origin }),
          ...(attributes === undefined ? {} : { attributes }),
          ...(mtime === undefined ? {} : { mtime }),
        }),
      );
    }
    if (streamIndex !== substreams.length) invalid("7z substreams remain without file records.");
  } else if (headerAt !== 32) unsupported("7z empty header with preceding packed data is unsupported.");
  return Object.freeze({
    entries: Object.freeze(entries),
    folders: Object.freeze(publicFolders),
    packs: Object.freeze(packs),
    headers: Object.freeze({
      start: "crc32-verified",
      next: "crc32-verified",
      ...(decodedHeader === undefined ? {} : { decoded: decodedHeader }),
    }),
    work: budget.inspect(),
    source: Object.freeze({
      ...(snapshot.identity === undefined ? {} : { identity: snapshot.identity }),
      stability: snapshot.stability ?? "unverified",
    }),
    async read(id: number, readOptions: SevenReadOptionsType = {}): Promise<SevenReadType> {
      const active = options.signal && readOptions.signal
        ? AbortSignal.any([options.signal, readOptions.signal])
        : options.signal ?? readOptions.signal;
      const extra = readOptions.ledger;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          lifetime.reserve(kind, count);
          if (extra && extra !== openingLedger) extra.reserve(kind, count);
        },
        inspect: () => lifetime.inspect(),
      };
      readOptions = { ...readOptions, ledger, ...(active === undefined ? {} : { signal: active }) };
      integer(id, "Entry ID");
      const entry = entries[id];
      if (!entry) throw new RangeError("7z entry ID does not exist.");
      if (!entry.readable || entry.kind !== "file") {
        unsupported("7z payload requires a regular supported single-substream file or an empty file.");
      }
      const offset = readOptions.offset ?? 0;
      const length = readOptions.length ?? entry.size - offset;
      integer(offset, "Member offset");
      integer(length, "Member length");
      if (offset > entry.size || length > entry.size - offset) {
        throw new RangeError("7z requested range exceeds the file.");
      }
      const checks: { scope: SevenCheckType["scope"]; crc: number }[] = [];
      const item = entry.folderId === undefined ? undefined : publicFolders[entry.folderId];
      const pack = item === undefined ? undefined : packs[item.packId];
      if (pack?.crc !== undefined) checks.push({ scope: "pack", crc: pack.crc });
      if (item?.crc !== undefined) checks.push({ scope: "folder", crc: item.crc });
      if (entry.crc !== undefined && entry.crcSource !== "folder") checks.push({ scope: "substream", crc: entry.crc });
      const readBudget = new ArchiveBudget(snapshot, readOptions, readOptions.signal);
      if (item && pack && item.coders[0]!.method !== "00") {
        const result = await decode(
          snapshot,
          pack,
          item.coders[0]!,
          entry.size,
          offset,
          length,
          readOptions.verify ?? true,
          readBudget,
          { ...options.lzma, ...codecPolicy(readOptions.lzma) },
          readOptions.signal,
        );
        const verified = (readOptions.verify ?? true) && result.complete;
        if (verified) {
          for (const check of checks) {
            if (check.crc !== (check.scope === "pack" ? result.packed : result.plain)) {
              throw new ArchiveError("checksum-mismatch", "7z compressed member CRC mismatch.");
            }
          }
        }
        return {
          bytes: result.bytes,
          decoding: result.complete ? "complete" : "prefix",
          integrity: checks.length === 0 ? "none" : verified ? "crc32-verified" : "pending",
          checks: Object.freeze(
            checks.map((check) =>
              Object.freeze({ ...check, status: verified ? "crc32-verified" as const : "pending" as const })
            ),
          ),
          work: readBudget.inspect(),
        };
      }
      const verify = (readOptions.verify ?? true) && checks.length > 0;
      const workLength = verify ? entry.size : length;
      if (
        workLength > readBudget.limits.maxSourceBytes || Math.ceil(workLength / 65536) > readBudget.limits.maxRequests
      ) throw new ArchiveError("budget-exceeded", "7z selected COPY work exceeds source limits.");
      readBudget.output(length);
      readBudget.decoded(workLength);
      readOptions.signal?.throwIfAborted();
      const output = new Uint8Array(length);
      let state = 0xffffffff;
      const begin = verify ? 0 : offset;
      const end = verify ? entry.size : offset + length;
      for (let at = begin; at < end;) {
        const count = Math.min(65536, end - at);
        const chunk = await readBudget.read(add(pack!.offset, at), count);
        if (verify) state = crc32(chunk, state);
        const from = Math.max(at, offset);
        const until = Math.min(at + count, offset + length);
        if (until > from) output.set(chunk.subarray(from - at, until - at), from - offset);
        at += count;
      }
      if (verify && checks.some((check) => check.crc !== ((state ^ 0xffffffff) >>> 0))) {
        throw new ArchiveError("checksum-mismatch", "7z selected COPY extent CRC mismatch.");
      }
      return {
        bytes: output,
        integrity: checks.length === 0 ? "none" : verify ? "crc32-verified" : "pending",
        checks: Object.freeze(
          checks.map((check): SevenCheckType =>
            Object.freeze({ ...check, status: verify ? "crc32-verified" : "pending" })
          ),
        ),
        work: readBudget.inspect(),
      };
    },
  });
}
