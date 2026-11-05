/** Sequential BinHex 4.0 fork previews with explicit replay and CRC evidence. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported, view } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Fork names describe two separate byte streams, not filesystem paths. */
export type BinHexForkType = "data" | "resource";
/** Every later replay retains these opening limits, ledger and abort authority. */
export interface BinHexOpenOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Default: 4,096 bytes scanned through the opening body colon, including ignored text. */
  readonly maxPreambleBytes?: number;
  /** Default: 64 MiB per declared fork. This does not increase decoded-work limits. */
  readonly maxForkBytes?: number;
  /** Default: 4,096 owned encoded bytes per source request; allowed range: 1–65,536. */
  readonly inputChunkBytes?: number;
  /** Default: canonical. The alternative requires the observed Perl producer's whole-zero packed padding. */
  readonly padding?: "canonical" | "convert-binhex";
  /** Default: rfc1741. The alternative admits only the observed macutils comment. */
  readonly preamble?: "rfc1741" | "rfc1741-or-macutils";
  /** Default: strict ASCII. The callback receives an independent owned name copy. */
  readonly decodeName?: (bytes: Uint8Array) => string;
  /** Default: false. Identity alone does not establish replay stability. */
  readonly allowUnverifiedSource?: boolean;
}
/** Selected output is bounded separately from all preceding and discarded decoded work. */
export interface BinHexReadOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly offset?: number;
  readonly length?: number;
  /** Default: true. Consume the selected fork suffix and CRC before successful completion. */
  readonly verify?: boolean;
}
/** Evidence applies only to completed components; no CRC authenticates a publisher. */
export interface BinHexEvidenceType {
  readonly header: "crc16-verified";
  readonly data: "crc16-verified" | "pending";
  readonly resource: "crc16-verified" | "pending";
  readonly terminal: "verified" | "pending";
  readonly cancelled: boolean;
  readonly paddingPolicy: "canonical" | "convert-binhex";
  /** Null until terminal framing completes; otherwise the observed literal packed zero count. */
  readonly terminalPaddingBytes: number | null;
  readonly work: ArchiveWorkType;
}
/** Read returns bytes only after its requested verification has completed. */
export interface BinHexReadType extends BinHexEvidenceType {
  readonly bytes: Uint8Array;
}
/** Emitted chunks are provisional until finished verifies the relevant complete fork. */
export interface BinHexStreamType {
  readonly stream: ReadableStream<Uint8Array>;
  readonly finished: Promise<BinHexEvidenceType>;
}
/** Borrowed nested-source policy. Each read replays all preceding encoded content. */
export interface BinHexMemberOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
}
/** A single file with two independent forks. No host path or extraction semantics are implied. */
export interface BinHexArchiveType {
  readonly name: string;
  /** Raw metadata getters return a new owned copy on every access. */
  readonly rawName: Uint8Array;
  readonly type: Uint8Array;
  readonly creator: Uint8Array;
  readonly flags: number;
  readonly dataSize: number;
  readonly resourceSize: number;
  readonly preambleProfile: "rfc1741" | "macutils";
  readonly headerIntegrity: "crc16-verified";
  readonly paddingPolicy: "canonical" | "convert-binhex";
  readonly work: ArchiveWorkType;
  read(fork: BinHexForkType, options?: BinHexReadOptionsType): Promise<BinHexReadType>;
  stream(fork: BinHexForkType, options?: BinHexReadOptionsType): BinHexStreamType;
  /** Verify both complete forks and terminal framing without materializing their contents. */
  verify(options?: BinHexMemberOptionsType): Promise<BinHexEvidenceType>;
  /** Partial nested reads are explicitly unverified; opening/member authority remains active. */
  member(fork: BinHexForkType, options?: BinHexMemberOptionsType): ByteSourceType;
}

/** CRC-16/XMODEM recurrence: polynomial 0x1021, initial zero, no final XOR. */
function crc(byte: number, state: number): number {
  state ^= byte << 8;
  for (let bit = 0; bit < 8; bit++) state = ((state << 1) ^ (0x1021 & -(state >>> 15))) & 65535;
  return state;
}
function combined(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
  return left && right ? AbortSignal.any([left, right]) : left ?? right;
}
/** Keep encoded buffering owned: a borrowed source may reuse its returned scratch on its next call. */
class Decoder {
  readonly budget: ArchiveBudget;
  readonly #source: ByteSourceType;
  readonly #signal: AbortSignal | undefined;
  readonly #window: number;
  #input = new Uint8Array();
  #cursor = 0;
  #at = 0;
  #column = 1;
  #bits = 0;
  #bitCount = 0;
  #packedBytes = 0;
  #ended = false;
  #last = -1;
  #repeat = 0;
  profile: "rfc1741" | "macutils" = "rfc1741";
  constructor(source: ByteSourceType, budget: ArchiveBudget, window: number, signal?: AbortSignal) {
    this.#source = source;
    this.budget = budget;
    this.#signal = signal;
    this.#window = window;
  }
  async raw(): Promise<number> {
    this.#signal?.throwIfAborted();
    if (this.#cursor === this.#input.length) {
      if (this.#at === this.#source.size) return -1;
      // ArchiveBudget admits source bytes and requests before invoking the source.
      const length = Math.min(this.#window, this.#source.size - this.#at);
      const borrowed = await this.budget.read(this.#at, length);
      this.#signal?.throwIfAborted();
      this.#input = borrowed.slice();
      this.#cursor = 0;
      this.#at += length;
    }
    return this.#input[this.#cursor++]!;
  }
  /** Ignore bounded preceding text, then require an exact identifying comment at column one. */
  async begin(maximum: number, compatibility: boolean): Promise<void> {
    let line = "", found = false, previousCR = false;
    for (let count = 0; count < maximum; count++) {
      const byte = await this.raw();
      if (byte === -1) invalid("BinHex opening colon is missing.");
      if (byte === 10 && previousCR) {
        previousCR = false;
        continue;
      }
      previousCR = byte === 13;
      if (byte === 10 || byte === 13) {
        if (!found) {
          if (line === "(This file must be converted with BinHex 4.0)") found = true;
          else if (compatibility && line === "(This file must be converted; you knew that already.)") {
            found = true;
            this.profile = "macutils";
          }
        } else if (line.length !== 0) invalid("BinHex text follows its identifying comment.");
        line = "";
      } else {
        if (found && byte === 58 && line.length === 0) return;
        line += String.fromCharCode(byte);
      }
    }
    throw new ArchiveError("budget-exceeded", "BinHex preamble exceeds policy.");
  }
  /** Decode one pre-RLE byte; retain and validate the unused tail bits at the closing colon. */
  async packed(): Promise<number> {
    const alphabet = "!\"#$%&'()*+,-012345689@ABCDEFGHIJKLMNPQRSTUVXYZ[`abcdefhijklmpqr";
    while (this.#bitCount < 8) {
      if (this.#ended) return -1;
      const byte = await this.raw();
      if (byte === -1) invalid("BinHex terminal colon is missing.");
      if (byte === 10 || byte === 13) {
        this.#column = 0;
        continue;
      }
      if (++this.#column > 64) invalid("BinHex encoded line exceeds 64 characters.");
      if (byte === 58) {
        this.#ended = true;
        if (this.#bitCount === 6 || this.#bits !== 0) invalid("BinHex terminal padding bits are invalid.");
        return -1;
      }
      const value = alphabet.indexOf(String.fromCharCode(byte));
      if (value < 0) invalid("BinHex body contains a non-alphabet character.");
      this.#bits = (this.#bits << 6) | value;
      this.#bitCount += 6;
    }
    this.#bitCount -= 8;
    const result = this.#bits >>> this.#bitCount;
    this.#bits &= (1 << this.#bitCount) - 1;
    this.#packedBytes++;
    return result;
  }
  /** RLE state spans component boundaries; a run never resets at a CRC field. */
  async next(): Promise<number> {
    this.#signal?.throwIfAborted();
    if (this.#repeat) {
      this.#repeat--;
      return this.#last;
    }
    const byte = await this.packed();
    if (byte < 0) invalid("BinHex decoded component is truncated.");
    if (byte !== 0x90) {
      this.budget.decoded(1);
      this.#signal?.throwIfAborted();
      return this.#last = byte;
    }
    const count = await this.packed();
    if (count < 0) invalid("BinHex RLE escape is truncated.");
    if (count === 0) {
      this.budget.decoded(1);
      this.#signal?.throwIfAborted();
      return this.#last = 0x90;
    }
    if (this.#last < 0 || count < 2) invalid("BinHex RLE run has no preceding byte or no output.");
    this.budget.decoded(count - 1);
    this.#signal?.throwIfAborted();
    this.#repeat = count - 2;
    return this.#last;
  }
  async checksum(state: number, label: string): Promise<void> {
    const stored = (await this.next()) * 256 + await this.next();
    if (stored !== state) throw new ArchiveError("checksum-mismatch", `BinHex ${label} CRC16 mismatch.`);
  }
  async header(maximum: number, compatibility: boolean, maxFork: number): Promise<Uint8Array> {
    await this.begin(maximum, compatibility);
    const length = await this.next();
    if (length < 1 || length > 63) invalid("BinHex name length must be 1–63 bytes.");
    const bytes = new Uint8Array(length + 20);
    bytes[0] = length;
    for (let at = 1; at < bytes.length; at++) bytes[at] = await this.next();
    let state = 0;
    for (const byte of bytes) state = crc(byte, state);
    await this.checksum(state, "header");
    if (bytes[length + 1] !== 0) unsupported("Only BinHex 4.0 version zero is supported.");
    const fields = view(bytes);
    if (fields.getUint32(length + 12) > maxFork || fields.getUint32(length + 16) > maxFork) {
      throw new ArchiveError("budget-exceeded", "BinHex declared fork size exceeds policy.");
    }
    return bytes;
  }
  /** The Perl profile pads packed bytes, never an RLE-expanded logical component. */
  async terminal(policy: "canonical" | "convert-binhex"): Promise<number> {
    if (this.#repeat) invalid("BinHex has pending RLE output after its resource CRC.");
    const padding = policy === "canonical" ? 0 : (3 - this.#packedBytes % 3) % 3;
    for (let at = 0; at < padding; at++) {
      if (await this.packed() !== 0) invalid("BinHex producer padding is missing or nonzero.");
      this.budget.decoded(1);
      this.#signal?.throwIfAborted();
    }
    if (await this.packed() !== -1) invalid("BinHex has excess packed bytes.");
    if (policy === "convert-binhex" && this.#bitCount !== 0) {
      invalid("BinHex producer padding must complete a packed quantum.");
    }
    for (;;) {
      const byte = await this.raw();
      if (byte < 0) return padding;
      if (byte !== 10 && byte !== 13) invalid("BinHex has trailing content.");
    }
  }
}

/** Open only the header. Fork contents and terminal framing remain unverified until consumed. */
export async function openBinHex(
  input: ByteSourceType,
  supplied: BinHexOpenOptionsType = {},
): Promise<BinHexArchiveType> {
  const options = { ...supplied };
  const { size, identity, stability } = input;
  integer(size, "BinHex source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown BinHex stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("BinHex identity must be bounded text.");
  }
  if (!stability && !options.allowUnverifiedSource) unsupported("BinHex requires stable source evidence.");
  const sourceRead = input.read.bind(input);
  const source: ByteSourceType = Object.freeze({
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read(offset: number, length: number, opts: { signal?: AbortSignal } = {}) {
      opts.signal?.throwIfAborted();
      return sourceRead(offset, length, opts);
    },
  });
  const preamble = options.maxPreambleBytes ?? 4096, maxFork = options.maxForkBytes ?? 64 * 1024 * 1024;
  const window = options.inputChunkBytes ?? 4096;
  integer(window, "BinHex input chunk bytes");
  if (window < 1 || window > 65536) throw new RangeError("BinHex input chunk must be 1–65,536 bytes.");
  integer(preamble, "BinHex preamble bytes");
  integer(maxFork, "BinHex maximum fork bytes");
  if (options.preamble !== undefined && !["rfc1741", "rfc1741-or-macutils"].includes(options.preamble)) {
    throw new TypeError("Unknown BinHex preamble policy.");
  }
  const padding = options.padding ?? "canonical";
  if (padding !== "canonical" && padding !== "convert-binhex") throw new TypeError("Unknown BinHex padding policy.");
  const owners = new WeakMap<ArchiveLedgerType, ArchiveLedgerType>();
  const capture = (owner?: ArchiveLedgerType): ArchiveLedgerType | undefined => {
    if (!owner) return undefined;
    let saved = owners.get(owner);
    if (!saved) {
      saved = { reserve: owner.reserve.bind(owner), inspect: owner.inspect.bind(owner) };
      owners.set(owner, saved);
    }
    return saved;
  };
  const local = createArchiveLedger(options), opening = capture(options.ledger);
  const ledger = (
    additional?: ArchiveLedgerType,
    member?: ArchiveLedgerType,
    signal?: AbortSignal,
  ): ArchiveLedgerType => {
    const unique = [
      ...new Set(
        [local, opening, additional, member].filter((value): value is ArchiveLedgerType => value !== undefined),
      ),
    ];
    return {
      reserve(kind, count) {
        for (const owner of unique) owner.reserve(kind, count);
        signal?.throwIfAborted();
      },
      inspect: () => local.inspect(),
    };
  };
  const openingBudget = new ArchiveBudget(
    source,
    { ...options, ledger: ledger(undefined, undefined, options.signal) },
    options.signal,
  );
  const compatibility = options.preamble === "rfc1741-or-macutils";
  const decoder = new Decoder(source, openingBudget, window, options.signal);
  const header = await decoder.header(preamble, compatibility, maxFork);
  const nameLength = header[0]!, rawName = header.slice(1, nameLength + 1);
  const rawType = header.slice(nameLength + 2, nameLength + 6), creator = header.slice(nameLength + 6, nameLength + 10);
  let name: string;
  if (options.decodeName) name = options.decodeName(rawName.slice());
  else {
    if (rawName.some((byte) => byte > 127)) unsupported("BinHex non-ASCII names require an explicit decoder.");
    name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawName);
  }
  if (
    typeof name !== "string" || name.includes("\0") || name.length > 4096 ||
    new TextEncoder().encode(name).length > 4096
  ) throw new TypeError("BinHex decoded name must be bounded NUL-free text.");
  const fields = view(header),
    dataSize = fields.getUint32(nameLength + 12),
    resourceSize = fields.getUint32(nameLength + 16);
  const forkSize = (fork: BinHexForkType): number => {
    if (fork !== "data" && fork !== "resource") throw new TypeError("Unknown BinHex fork.");
    return fork === "data" ? dataSize : resourceSize;
  };
  /** Each operation owns its decoder and reservations; replay cannot borrow another call's credit. */
  const prepare = (fork: BinHexForkType, supplied: BinHexReadOptionsType, member?: ArchiveLedgerType) => {
    const opts = { ...supplied }, lengthOfFork = forkSize(fork);
    const offset = opts.offset ?? 0, length = opts.length ?? lengthOfFork - offset;
    integer(offset, "BinHex offset");
    integer(length, "BinHex length");
    if (offset > lengthOfFork || length > lengthOfFork - offset) throw new RangeError("BinHex selection exceeds fork.");
    const signal = combined(options.signal, opts.signal);
    const budget = new ArchiveBudget(source, { ...opts, ledger: ledger(capture(opts.ledger), member, signal) }, signal);
    signal?.throwIfAborted();
    budget.output(length);
    signal?.throwIfAborted();
    const evidence = {
      header: "crc16-verified",
      data: "pending",
      resource: "pending",
      terminal: "pending",
      cancelled: false,
      paddingPolicy: padding,
      terminalPaddingBytes: null,
    } as {
      header: "crc16-verified";
      data: "crc16-verified" | "pending";
      resource: "crc16-verified" | "pending";
      terminal: "verified" | "pending";
      cancelled: boolean;
      paddingPolicy: "canonical" | "convert-binhex";
      terminalPaddingBytes: number | null;
    };
    const inspect = (): BinHexEvidenceType => Object.freeze({ ...evidence, work: budget.inspect() });
    async function* chunks(): AsyncGenerator<Uint8Array, void> {
      const current = new Decoder(source, budget, window, signal);
      const replay = await current.header(preamble, compatibility, maxFork);
      if (replay.length !== header.length || replay.some((byte, at) => byte !== header[at])) {
        invalid("BinHex header changed during replay.");
      }
      if (length === 0 && opts.verify === false && lengthOfFork !== 0) return;
      for (const component of ["data", "resource"] as const) {
        const selected = component === fork, total = forkSize(component);
        const complete = !selected || opts.verify !== false || (offset === 0 && length === total);
        const stop = selected && !complete ? offset + length : total;
        let state = 0, buffer = new Uint8Array(selected ? Math.min(65536, length) : 0), used = 0;
        for (let at = 0; at < stop; at++) {
          const byte = await current.next();
          state = crc(byte, state);
          if (selected && at >= offset && at < offset + length) {
            buffer[used++] = byte;
            if (used === buffer.length) {
              yield buffer;
              signal?.throwIfAborted();
              const remaining = offset + length - at - 1;
              buffer = new Uint8Array(Math.min(65536, remaining));
              used = 0;
            }
          }
        }
        if (used) yield buffer.slice(0, used);
        if (complete) {
          await current.checksum(state, component);
          evidence[component] = "crc16-verified";
        }
        if (selected) {
          if (complete && component === "resource") {
            evidence.terminalPaddingBytes = await current.terminal(padding);
            evidence.terminal = "verified";
          }
          signal?.throwIfAborted();
          return;
        }
      }
    }
    return { length, chunks, inspect, signal };
  };
  const read = async (
    fork: BinHexForkType,
    opts: BinHexReadOptionsType = {},
    member?: ArchiveLedgerType,
  ): Promise<BinHexReadType> => {
    const operation = prepare(fork, opts, member);
    const bytes = new Uint8Array(operation.length);
    let at = 0;
    for await (const chunk of operation.chunks()) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    operation.signal?.throwIfAborted();
    if (at !== bytes.length) invalid("BinHex selected output is incomplete.");
    return Object.freeze({ bytes, ...operation.inspect() });
  };
  const stream = (fork: BinHexForkType, supplied: BinHexReadOptionsType = {}): BinHexStreamType => {
    const controller = new AbortController(), cancellation = new DOMException("BinHex stream cancelled.", "AbortError");
    const operation = prepare(fork, { ...supplied, signal: combined(supplied.signal, controller.signal)! });
    const iterator = operation.chunks();
    let resolve!: (value: BinHexEvidenceType) => void, reject!: (reason: unknown) => void;
    const finished = new Promise<BinHexEvidenceType>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void finished.catch(() => {});
    let active: Promise<void> | undefined, cancelled = false, settled = false, failure: unknown, failed = false;
    const fail = (error: unknown) => {
      failed = true;
      failure = error;
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const stream = new ReadableStream<Uint8Array>({
      pull(output) {
        active = Promise.resolve().then(async () => {
          try {
            const next = await iterator.next();
            if (cancelled) return;
            operation.signal?.throwIfAborted();
            if (next.done) {
              settled = true;
              resolve(operation.inspect());
              output.close();
            } else output.enqueue(next.value);
          } catch (error) {
            if (cancelled && error === cancellation) return;
            fail(error);
            if (!cancelled) output.error(error);
          }
        });
        return active;
      },
      async cancel() {
        cancelled = true;
        controller.abort(cancellation);
        await active;
        try {
          await iterator.return();
        } catch (error) {
          fail(error);
        }
        if (failed) throw failure;
        if (!settled) {
          settled = true;
          resolve(Object.freeze({ ...operation.inspect(), cancelled: true }));
        }
      },
    }, { highWaterMark: 0 });
    return Object.freeze({ stream, finished });
  };
  options.signal?.throwIfAborted();
  return Object.freeze({
    name,
    get rawName() {
      return rawName.slice();
    },
    get type() {
      return rawType.slice();
    },
    get creator() {
      return creator.slice();
    },
    flags: fields.getUint16(nameLength + 10),
    dataSize,
    resourceSize,
    preambleProfile: decoder.profile,
    headerIntegrity: "crc16-verified" as const,
    paddingPolicy: padding,
    work: openingBudget.inspect(),
    read,
    stream,
    async verify(supplied: BinHexMemberOptionsType = {}): Promise<BinHexEvidenceType> {
      const operation = prepare("resource", { ...supplied, offset: 0, length: 0, verify: true });
      for await (const _chunk of operation.chunks()) { /* The selection is empty; all content is verification work. */ }
      operation.signal?.throwIfAborted();
      return operation.inspect();
    },
    member(fork: BinHexForkType, supplied: BinHexMemberOptionsType = {}): ByteSourceType {
      const opts = { ...supplied }, memberOwner = createArchiveLedger(opts), external = capture(opts.ledger);
      const memberSignal = combined(options.signal, opts.signal), total = forkSize(fork);
      const memberLedger: ArchiveLedgerType = {
        reserve(kind, count) {
          memberOwner.reserve(kind, count);
          external?.reserve(kind, count);
          memberSignal?.throwIfAborted();
        },
        inspect: () => memberOwner.inspect(),
      };
      // Passing an already-opening owner through this wrapper would double charge;
      // compose the captured owners directly for each replay instead.
      const owner = external && external === opening ? memberOwner : memberLedger;
      memberSignal?.throwIfAborted();
      return Object.freeze({
        size: total,
        ...(identity === undefined ? {} : { identity: `binhex:${identity.length}:${identity}:${fork}` }),
        ...(stability === undefined ? {} : { stability }),
        async read(offset: number, length: number, request: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
          const signal = combined(memberSignal, request.signal);
          return (await read(fork, { offset, length, verify: false, ...(signal ? { signal } : {}) }, owner)).bytes;
        },
      });
    },
  });
}
