/** Bounded indexed XZ single-stream inspection and selected LZMA2 block reads. @module */
import type { ByteSourceType } from "../source.ts";
import { createLzmaDecoder } from "./lzma.ts";
import type { LzmaLimitsType } from "./lzma.ts";
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
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Codec CPU counters are cumulative across all blocks selected by one read. Memory is bounded per active decoder. */
export type XzLzmaOptionsType = Pick<
  LzmaLimitsType,
  "maxDictionaryBytes" | "maxMemoryBytes" | "maxDecisions" | "maxSteps" | "maxChunks" | "inputChunkBytes" | "yield"
>;
/** Metadata admission is separate from declared decoded size and selected output. */
export interface XzOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default 8 MiB, admitted before the index allocation. */ readonly maxIndexBytes?: number;
  /** Default 100,000 materialized records. */ readonly maxBlocks?: number;
  /** Default 1 MiB trailing zero padding, in multiples of four bytes. */ readonly maxPaddingBytes?: number;
  readonly allowUnverifiedSource?: boolean;
  readonly lzma?: XzLzmaOptionsType;
}
/** Each range decodes only intersecting blocks, from each block's own beginning. */
export interface XzReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default true drains each selected block and validates its terminal state and CRC, when provided. */ readonly verify?:
    boolean;
  readonly lzma?: XzLzmaOptionsType;
}
/** Physical ranges are exact; decoded sizes remain declarations until a successful complete block decode. */
export interface XzBlockType {
  readonly id: number;
  readonly offset: number;
  readonly headerBytes: number;
  readonly compressedOffset: number;
  readonly compressedBytes: number;
  readonly paddingBytes: number;
  readonly checkOffset: number;
  readonly checkBytes: number;
  readonly unpaddedBytes: number;
  readonly decodedOffset: number;
  readonly decodedBytes: number;
  readonly dictionary: number;
}
/** Checks describe decoded block bytes, not compressed extents, index metadata or authentication. */
export interface XzCheckType {
  readonly blockId: number;
  readonly decoding: "complete" | "prefix";
  readonly integrity: "crc32-verified" | "crc64-verified" | "pending" | "not-provided";
  readonly crc?: number;
  /** CRC64/XZ evidence uses exactly sixteen lowercase hex digits, preserving every bit. */
  readonly crc64?: string;
}
/** Retains only selected output. Counter totals include discarded decoded prefixes and LZMA2 framing. */
export interface XzReadType {
  readonly bytes: Uint8Array;
  readonly checks: readonly XzCheckType[];
  readonly work: ArchiveWorkType;
  readonly decisions: number;
  readonly steps: number;
  readonly chunks: number;
}
/** One borrowed single-stream container; metadata CRCs do not verify its compressed payload. */
export interface XzArchiveType {
  readonly size: number;
  readonly check: "crc32" | "crc64" | "none";
  readonly paddingBytes: number;
  readonly blocks: readonly XzBlockType[];
  readonly metadata: {
    readonly header: "crc32-verified";
    readonly footer: "crc32-verified";
    readonly index: "crc32-verified";
    readonly blockHeaders: "crc32-verified";
  };
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  read(options?: XzReadOptionsType): Promise<XzReadType>;
}

function exact(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    unsupported("XZ integer exceeds safe JavaScript indexing.");
  }
  return Number(value);
}
function add(left: number, right: number): number {
  return exact(BigInt(left) + BigInt(right));
}
function crc(bytes: Uint8Array): number {
  return (crc32(bytes) ^ 0xffffffff) >>> 0;
}
function verifyCrc(bytes: Uint8Array, expected: number, label: string): void {
  if (crc(bytes) !== expected) throw new ArchiveError("checksum-mismatch", `XZ ${label} CRC mismatch.`);
}
function zeros(bytes: Uint8Array, label: string): void {
  if (bytes.some((byte) => byte !== 0)) invalid(`XZ ${label} must contain only zero bytes.`);
}

/** CRC64/XZ keeps a reflected 64-bit register in two uint32 words.
 * A read owns one 2 KiB interleaved low/high table, built only when CRC64 is needed.
 * This replaces eight bit iterations per input byte with one byte recurrence,
 * without per-byte BigInt values or a retained body buffer. It is not authentication. */
class Crc64 {
  readonly #table = new Uint32Array(512);
  #low = 0xffffffff;
  #high = 0xffffffff;
  constructor() {
    for (let value = 0; value < 256; value++) {
      let low = value;
      let high = 0;
      for (let bit = 0; bit < 8; bit++) {
        const carry = low & 1;
        low = (low >>> 1 | high << 31) >>> 0;
        high >>>= 1;
        if (carry) {
          low = (low ^ 0xd7870f42) >>> 0;
          high = (high ^ 0xc96c5795) >>> 0;
        }
      }
      this.#table[value * 2] = low;
      this.#table[value * 2 + 1] = high;
    }
  }
  reset(): void {
    this.#low = 0xffffffff;
    this.#high = 0xffffffff;
  }
  update(bytes: Uint8Array): void {
    let low = this.#low;
    let high = this.#high;
    for (const byte of bytes) {
      const index = ((low ^ byte) & 255) * 2;
      low = (this.#table[index]! ^ (low >>> 8 | high << 24)) >>> 0;
      high = (this.#table[index + 1]! ^ high >>> 8) >>> 0;
    }
    this.#low = low;
    this.#high = high;
  }
  hex(): string {
    return ((this.#high ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0") +
      ((this.#low ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
  }
}

/** Canonical base128, at most nine bytes/63 bits. No truncated or zero-extended encoding is accepted. */
class Cursor {
  readonly bytes: Uint8Array;
  at = 0;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  byte(): number {
    if (this.at === this.bytes.length) invalid("XZ metadata is truncated.");
    return this.bytes[this.at++]!;
  }
  vli(): number {
    let value = 0n;
    for (let at = 0; at < 9; at++) {
      const byte = this.byte();
      value |= BigInt(byte & 127) << BigInt(at * 7);
      if (!(byte & 128)) {
        if (at > 0 && byte === 0) invalid("XZ VLI is noncanonical.");
        return exact(value);
      }
    }
    invalid("XZ VLI exceeds nine bytes.");
  }
  padding(): void {
    zeros(this.bytes.subarray(this.at), "header padding");
    this.at = this.bytes.length;
  }
}

/** Keep container authority out of the codec options copied from structural caller objects. */
function policy(options: XzLzmaOptionsType = {}): XzLzmaOptionsType {
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

/** Parse metadata without decompressing payload. Only one LZMA2 filter and none/CRC32/CRC64 checks are supported. */
export async function openXz(input: ByteSourceType, supplied: XzOpenOptionsType = {}): Promise<XzArchiveType> {
  const options = { ...supplied, lzma: policy(supplied.lzma) };
  const { size, identity, stability } = input;
  integer(size, "XZ source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown XZ source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("XZ source identity exceeds its string bound.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("XZ requires stable source evidence or explicit unverified acceptance.");
  }
  const snapshot: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: input.read.bind(input),
  };
  const maximumIndex = options.maxIndexBytes ?? 8 * 1024 * 1024;
  const maximumBlocks = options.maxBlocks ?? 100000;
  const maximumPadding = options.maxPaddingBytes ?? 1024 * 1024;
  for (const [label, value] of Object.entries({ maximumIndex, maximumBlocks, maximumPadding })) integer(value, label);
  if (size < 32 || size % 4 !== 0) invalid("XZ source must contain a complete four-byte-aligned stream.");
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
  const readMetadata = async (offset: number, length: number): Promise<Uint8Array> => {
    const bytes = await budget.read(offset, length);
    budget.decoded(length);
    return bytes;
  };
  // Start with one footer-aligned word. Only padded streams need wider lookbehind;
  // those bounded probes may fetch preceding compressed bytes, all charged as source work.
  let end = size;
  let padding = 0;
  let probe = await readMetadata(end - 4, 4);
  while (true) {
    let at = probe.length;
    while (at >= 4 && probe.subarray(at - 4, at).every((byte) => byte === 0)) {
      if (padding + 4 > maximumPadding) throw new ArchiveError("budget-exceeded", "XZ stream padding exceeds policy.");
      padding += 4;
      end -= 4;
      at -= 4;
    }
    if (at !== 0) break;
    if (end < 32) invalid("XZ stream footer is missing.");
    const count = Math.min(65536, end - 12, Math.floor((maximumPadding - padding) / 4) * 4 + 4);
    probe = await readMetadata(end - count, count);
  }
  if (end < 32) invalid("XZ stream footer is truncated.");
  const footer = await readMetadata(end - 12, 12);
  if (footer[10] !== 89 || footer[11] !== 90) invalid("XZ footer magic is missing.");
  verifyCrc(footer.subarray(4, 10), view(footer).getUint32(0, true), "footer");
  const header = await readMetadata(0, 12);
  if (![253, 55, 122, 88, 90, 0].every((byte, index) => header[index] === byte)) {
    invalid("XZ header magic must begin at byte zero.");
  }
  verifyCrc(header.subarray(6, 8), view(header).getUint32(8, true), "stream header");
  if (header[6] !== footer[8] || header[7] !== footer[9]) invalid("XZ header/footer flags differ.");
  if (header[6] !== 0 || (header[7]! & 240) !== 0) unsupported("XZ reserved stream flags are unsupported.");
  if (header[7] !== 0 && header[7] !== 1 && header[7] !== 4) {
    unsupported("XZ supports only none, CRC32 or CRC64 block checks.");
  }
  const checkBytes = header[7] === 1 ? 4 : header[7] === 4 ? 8 : 0;
  const indexBytes = (view(footer).getUint32(4, true) + 1) * 4;
  if (indexBytes > maximumIndex) throw new ArchiveError("budget-exceeded", "XZ index exceeds metadata policy.");
  if (indexBytes > end - 24) invalid("XZ backwards index size exceeds its stream.");
  const indexAt = end - 12 - indexBytes;
  const index = await readMetadata(indexAt, indexBytes);
  verifyCrc(index.subarray(0, -4), view(index).getUint32(index.length - 4, true), "index");
  const fields = new Cursor(index.subarray(0, -4));
  if (fields.byte() !== 0) invalid("XZ Index indicator is missing.");
  const count = fields.vli();
  if (count > maximumBlocks || count > Math.floor((fields.bytes.length - fields.at) / 2)) {
    throw new ArchiveError("budget-exceeded", "XZ block records exceed metadata bounds.");
  }
  const records: { unpadded: number; decoded: number }[] = [];
  for (let id = 0; id < count; id++) records.push({ unpadded: fields.vli(), decoded: fields.vli() });
  if (fields.bytes.length - fields.at > 3) invalid("XZ Index padding exceeds three bytes.");
  fields.padding();
  let physical = 12;
  let decoded = 0;
  const blocks: XzBlockType[] = [];
  for (const record of records) {
    const padded = exact((BigInt(record.unpadded) + 3n) & ~3n);
    if (record.unpadded < 5 || padded > indexAt - physical) invalid("XZ indexed block exceeds its payload region.");
    const first = await readMetadata(physical, 1);
    if (first[0] === 0) invalid("XZ Index declares a missing block.");
    const headerBytes = (first[0]! + 1) * 4;
    if (headerBytes + checkBytes >= record.unpadded) invalid("XZ block header/check leaves no compressed bytes.");
    const bytes = await readMetadata(physical, headerBytes);
    verifyCrc(bytes.subarray(0, -4), view(bytes).getUint32(headerBytes - 4, true), "block header");
    const block = new Cursor(bytes.subarray(1, -4));
    const flags = block.byte();
    if (flags & 60) unsupported("XZ block reserved flags are unsupported.");
    if ((flags & 3) !== 0) unsupported("XZ requires exactly one LZMA2 filter.");
    const compressedBytes = record.unpadded - headerBytes - checkBytes;
    if ((flags & 64) && block.vli() !== compressedBytes) invalid("XZ compressed size differs from Index extent.");
    if ((flags & 128) && block.vli() !== record.decoded) invalid("XZ decoded size differs between header and Index.");
    if (block.vli() !== 33 || block.vli() !== 1) unsupported("XZ filter must be LZMA2 with one property byte.");
    const dictionary = block.byte();
    if (dictionary > 40) invalid("XZ LZMA2 dictionary property exceeds 40.");
    block.padding();
    const paddingBytes = padded - record.unpadded;
    const compressedOffset = add(physical, headerBytes);
    const paddingOffset = add(compressedOffset, compressedBytes);
    if (paddingBytes) zeros(await readMetadata(paddingOffset, paddingBytes), "block padding");
    blocks.push(
      Object.freeze({
        id: blocks.length,
        offset: physical,
        headerBytes,
        compressedOffset,
        compressedBytes,
        paddingBytes,
        checkOffset: add(paddingOffset, paddingBytes),
        checkBytes,
        unpaddedBytes: record.unpadded,
        decodedOffset: decoded,
        decodedBytes: record.decoded,
        dictionary,
      }),
    );
    physical = add(physical, padded);
    decoded = add(decoded, record.decoded);
  }
  if (physical !== indexAt) {
    unsupported("XZ indexed blocks must exactly fill one stream; concatenation is unsupported.");
  }
  const archive: XzArchiveType = {
    size: decoded,
    check: checkBytes === 8 ? "crc64" : checkBytes === 4 ? "crc32" : "none",
    paddingBytes: padding,
    blocks: Object.freeze(blocks),
    metadata: Object.freeze({
      header: "crc32-verified",
      footer: "crc32-verified",
      index: "crc32-verified",
      blockHeaders: "crc32-verified",
    }),
    work: budget.inspect(),
    source: Object.freeze({ ...(identity === undefined ? {} : { identity }), stability: stability ?? "unverified" }),
    async read(supplied: XzReadOptionsType = {}): Promise<XzReadType> {
      const signal = options.signal && supplied.signal
        ? AbortSignal.any([options.signal, supplied.signal])
        : options.signal ?? supplied.signal;
      const codec = { ...options.lzma, ...policy(supplied.lzma) };
      const extra = supplied.ledger;
      const ledger: ArchiveLedgerType = {
        reserve(kind, count) {
          lifetime.reserve(kind, count);
          if (extra && extra !== openingLedger) extra.reserve(kind, count);
        },
        inspect: () => lifetime.inspect(),
      };
      const opts = { ...supplied, ledger, ...(signal === undefined ? {} : { signal }) };
      const offset = opts.offset ?? 0;
      const length = opts.length ?? decoded - offset;
      integer(offset, "XZ decoded offset");
      integer(length, "XZ decoded length");
      if (offset > decoded || length > decoded - offset) {
        throw new RangeError("XZ selected range exceeds declared output.");
      }
      const work = new ArchiveBudget(snapshot, opts, signal);
      work.output(length);
      signal?.throwIfAborted();
      const output = new Uint8Array(length);
      const checks: XzCheckType[] = [];
      let decisions = 0;
      let steps = 0;
      let chunks = 0;
      let crc64: Crc64 | undefined;
      for (const block of blocks) {
        const from = Math.max(offset, block.decodedOffset);
        const until = Math.min(offset + length, block.decodedOffset + block.decodedBytes);
        if (
          until <= from && !(offset === 0 && length === decoded && (opts.verify ?? true) && block.decodedBytes === 0)
        ) continue;
        if (block.checkBytes === 8 && !crc64) crc64 = new Crc64();
        const result = await readBlock(
          snapshot,
          block,
          from - block.decodedOffset,
          until - block.decodedOffset,
          output.subarray(from - offset, until - offset),
          opts.verify ?? true,
          work,
          {
            ...codec,
            maxDecisions: (codec.maxDecisions ?? 64 * 1024 * 1024) - decisions,
            maxSteps: (codec.maxSteps ?? 128 * 1024 * 1024) - steps,
            maxChunks: (codec.maxChunks ?? 100000) - chunks,
          },
          signal,
          crc64,
        );
        decisions += result.decisions;
        steps += result.steps;
        chunks += result.chunks;
        checks.push(Object.freeze(result.check));
      }
      signal?.throwIfAborted();
      return { bytes: output, checks: Object.freeze(checks), work: work.inspect(), decisions, steps, chunks };
    },
  };
  return Object.freeze(archive);
}

/** Stream one indexed block into the selected destination view. CRC covers decoded data only.
 * Source/decoded accounting belongs to the archive; decoder output is scan work, not selected-output work. */
async function readBlock(
  snapshot: ByteSourceType,
  block: XzBlockType,
  from: number,
  until: number,
  destination: Uint8Array,
  verify: boolean,
  work: ArchiveBudget,
  options: XzLzmaOptionsType,
  signal?: AbortSignal,
  crc64?: Crc64,
): Promise<{ check: XzCheckType; decisions: number; steps: number; chunks: number }> {
  let state = 0xffffffff;
  crc64?.reset();
  let at = 0;
  const source: ByteSourceType = {
    size: block.compressedBytes,
    stability: snapshot.stability ?? "caller",
    read(offset, length) {
      return work.read(add(block.compressedOffset, offset), length);
    },
  };
  const relay: ArchiveLedgerType = {
    reserve(kind, count) {
      if (kind === "decodedBytes") work.decoded(count);
    },
    inspect: () => work.inspect(),
  };
  const decoder = createLzmaDecoder(source, {
    ...options,
    format: "raw-lzma2",
    dictionary: block.dictionary,
    size: block.decodedBytes,
    maxSourceBytes: work.limits.maxSourceBytes,
    maxRequests: work.limits.maxRequests,
    maxDecodedBytes: work.limits.maxDecodedBytes,
    maxOutputBytes: block.decodedBytes,
    ledger: relay,
    ...(signal === undefined ? {} : { signal }),
  });
  const reader = decoder.stream.getReader();
  let complete = false;
  let failed = false;
  let primary: unknown;
  const retain = (reason: unknown): void => {
    if (failed && reason === primary) return; // Duplicate observation of one decoder terminal result.
    primary = failed ? new AggregateError([primary, reason], "XZ decode and retirement failed.") : reason;
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
      if (crc64) crc64.update(bytes);
      else if (block.checkBytes === 4) state = crc32(bytes, state);
      const end = add(at, bytes.length);
      const begin = Math.max(at, from);
      const finish = Math.min(end, until);
      if (finish > begin) destination.set(bytes.subarray(begin - at, finish - at), begin - from);
      at = end;
      if (!verify && until < block.decodedBytes && at >= until) break;
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
  let counters = { decisions: 0, steps: 0, chunks: 0 };
  try {
    const terminal = await decoder.finished;
    complete = terminal.status === "complete";
    counters = { decisions: terminal.decisions, steps: terminal.steps, chunks: terminal.chunks };
  } catch (reason) {
    retain(reason);
  }
  reader.releaseLock();
  if (failed) throw primary;
  signal?.throwIfAborted();
  if (complete && at !== block.decodedBytes) invalid("XZ decoded block differs from Index size.");
  let expected: number | undefined;
  let expected64: string | undefined;
  if (block.checkBytes) {
    const stored = view(await work.read(block.checkOffset, block.checkBytes));
    work.decoded(block.checkBytes);
    if (block.checkBytes === 8) {
      expected64 = stored.getUint32(4, true).toString(16).padStart(8, "0") +
        stored.getUint32(0, true).toString(16).padStart(8, "0");
      if (verify && complete && crc64?.hex() !== expected64) {
        throw new ArchiveError("checksum-mismatch", "XZ decoded block CRC64 mismatch.");
      }
    } else {
      expected = stored.getUint32(0, true);
      if (verify && complete && ((state ^ 0xffffffff) >>> 0) !== expected) {
        throw new ArchiveError("checksum-mismatch", "XZ decoded block CRC32 mismatch.");
      }
    }
  }
  signal?.throwIfAborted();
  return {
    ...counters,
    check: {
      blockId: block.id,
      decoding: complete ? "complete" : "prefix",
      integrity: block.checkBytes === 0
        ? "not-provided"
        : verify && complete
        ? block.checkBytes === 8 ? "crc64-verified" : "crc32-verified"
        : "pending",
      ...(expected === undefined ? {} : { crc: expected }),
      ...(expected64 === undefined ? {} : { crc64: expected64 }),
    },
  };
}
