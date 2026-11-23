/** Bounded pure LZMA1/LZMA2 decoding over borrowed exact-range sources. @module */
import type { ByteSourceType } from "../source.ts";
import { isBytes, toView } from "../bytes.ts";
import { ArchiveBudget, ArchiveError, integer, invalid, unsupported, view } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Framing is explicit: raw properties belong to the enclosing format, not an inferred filename. */
export type LzmaFormatType =
  | { readonly format: "alone" }
  | {
    readonly format: "raw-lzma1";
    readonly properties: Uint8Array;
    readonly size?: number;
    readonly marker?: "required" | "optional";
  }
  | { readonly format: "raw-lzma2"; readonly dictionary: number; readonly size?: number };
/** Independent allocation, CPU and logical byte admission. No limit is an elapsed-time promise. */
export interface LzmaLimitsType extends ArchiveLimitsType {
  /** Default 8 MiB; implementation ceiling 64 MiB. */ readonly maxDictionaryBytes?: number;
  /** Dictionary, probability arrays, packed cursor and output quantum. Default 16 MiB; ceiling 65 MiB. */ readonly maxMemoryBytes?:
    number;
  /** Default 64 Mi; ceiling 512 Mi binary range decisions. */ readonly maxDecisions?: number;
  /** Default 128 Mi; ceiling 1 Gi work units: range decisions, model resets and dictionary bytes written. */ readonly maxSteps?:
    number;
  /** Default 100,000; ceiling 1,000,000 LZMA2 chunks. */ readonly maxChunks?: number;
  /** Exact source request quantum, default 65,536, range 1..65,536. */ readonly inputChunkBytes?: number;
  /** Optional caller-owned task scheduling boundary, awaited after every output quantum. */ readonly yield?: () =>
    Promise<void>;
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
}
/** Format options are copied synchronously, including the raw LZMA1 property bytes. */
export type LzmaOptionsType = LzmaFormatType & LzmaLimitsType;
/** Structural termination is separate from checksums; neither raw codec supplies authentication. */
export interface LzmaResultType {
  readonly status: "complete" | "cancelled";
  readonly termination: "end-marker" | "size" | "lzma2-end" | "pending";
  readonly integrity: "none";
  readonly dictionaryBytes: number;
  readonly decisions: number;
  readonly steps: number;
  readonly chunks: number;
  readonly work: ArchiveWorkType;
}
/** The caller owns stream consumption/cancellation. The source remains borrowed and is never closed. */
export interface LzmaDecoderType {
  readonly stream: ReadableStream<Uint8Array>;
  readonly finished: Promise<LzmaResultType>;
}

/** Refills compact unread packed bytes; foreign source buffers are copied, never retained. */
class Cursor {
  readonly bytes = new Uint8Array(65536 + 64);
  readonly #budget: ArchiveBudget;
  readonly #size: number;
  readonly #chunk: number;
  start = 0;
  end = 0;
  fetched = 0;
  constructor(budget: ArchiveBudget, size: number, chunk: number) {
    this.#budget = budget;
    this.#size = size;
    this.#chunk = chunk;
  }
  get remaining(): number {
    return this.end - this.start + this.#size - this.fetched;
  }
  async ensure(count: number): Promise<void> {
    if (count > this.bytes.length) throw new RangeError("LZMA packed cursor capacity exceeded.");
    if (this.end - this.start >= count) return;
    this.bytes.copyWithin(0, this.start, this.end);
    this.end -= this.start;
    this.start = 0;
    while (this.end < count && this.fetched < this.#size) {
      const length = Math.min(this.#chunk, this.#size - this.fetched, this.bytes.length - this.end);
      const bytes = await this.#budget.read(this.fetched, length);
      this.bytes.set(bytes, this.end);
      this.end += length;
      this.fetched += length;
    }
  }
  byte(): number {
    if (this.start === this.end) invalid("LZMA packed input ended within a symbol.");
    return this.bytes[this.start++]!;
  }
}

/** Hot state follows the authored range model; probability arrays and dictionary stay flat and operation-owned. */
class Kernel {
  readonly cursor: Cursor;
  readonly budget: ArchiveBudget;
  readonly options: LzmaOptionsType;
  readonly signal: AbortSignal;
  readonly dictionary: Uint8Array;
  readonly maxSteps: number;
  readonly maxDecisions: number;
  readonly maxChunks: number;
  readonly memory: number;
  /** Flat model spans: match/rep 0..431; distance slots 432..687; special
   * distances 688..801; alignment 802..817; lengths 818..1845; literals 1846 onward.
   * Distance special models omit the specification's unused initial cell. */
  probs = new Uint16Array();
  lc = 0;
  lp = 0;
  pb = 0;
  state = 0;
  reps = [0, 0, 0, 0];
  position = 0;
  history = 0;
  total = 0;
  range = 0xffffffff;
  code = 0;
  decisions = 0;
  steps = 0;
  chunks = 0;
  pending = 0;
  distance = 0;
  literal = -1;
  size: number | undefined;
  marker: "required" | "optional" = "required";
  termination: LzmaResultType["termination"] = "pending";
  /** -1 selects no packed-chunk fence (LZMA1/raw copy); otherwise each range byte consumes this extent. */
  chunkPacked = -1;
  chunkOutput = 0;
  raw = false;
  needDictionary = true;
  needProperties = true;
  needState = true;
  constructor(
    cursor: Cursor,
    budget: ArchiveBudget,
    options: LzmaOptionsType,
    signal: AbortSignal,
    dictionary: number,
    memory: number,
  ) {
    this.cursor = cursor;
    this.budget = budget;
    this.options = options;
    this.signal = signal;
    this.maxSteps = options.maxSteps ?? 128 * 1024 * 1024;
    this.maxDecisions = options.maxDecisions ?? 64 * 1024 * 1024;
    this.maxChunks = options.maxChunks ?? 100000;
    this.memory = memory;
    if (dictionary > (options.maxDictionaryBytes ?? 8 * 1024 * 1024)) this.limit("dictionary");
    if (dictionary + 65536 + 64 + 16384 > memory) this.limit("owned memory");
    this.dictionary = new Uint8Array(dictionary);
  }
  limit(label: string): never {
    throw new ArchiveError("budget-exceeded", `LZMA ${label} limit exceeded.`);
  }
  step(count: number): void {
    if (count > this.maxSteps - this.steps) this.limit("work steps");
    this.steps += count;
  }
  properties(value: number): void {
    if (value >= 225) invalid("LZMA properties are invalid.");
    const lc = value % 9;
    const rest = Math.floor(value / 9);
    const lp = rest % 5;
    const pb = Math.floor(rest / 5);
    if (lc + lp > 4) unsupported("LZMA profile requires lc+lp<=4.");
    const length = 1846 + 768 * 2 ** (lc + lp);
    if (
      this.dictionary.length + 65536 + 64 + 16384 + length * 2 +
          (this.probs.length === length ? 0 : this.probs.byteLength) > this.memory
    ) this.limit("owned memory");
    // Reserve reset CPU before allocation/fill, including changes in LZMA2 properties.
    this.step(length);
    if (this.probs.length !== length) this.probs = new Uint16Array(length);
    this.probs.fill(1024);
    this.lc = lc;
    this.lp = lp;
    this.pb = pb;
    this.state = 0;
    this.reps.fill(0);
  }
  reset(): void {
    this.step(this.probs.length);
    this.probs.fill(1024);
    this.state = 0;
    this.reps.fill(0);
  }
  resetDictionary(): void {
    this.position = 0;
    this.history = 0;
  }
  byte(): number {
    if (this.chunkPacked === 0) invalid("LZMA range decoder exceeds its packed chunk.");
    const value = this.cursor.byte();
    if (this.chunkPacked > 0) this.chunkPacked--;
    return value;
  }
  initializeRange(): void {
    this.range = 0xffffffff;
    this.code = 0;
    if (this.byte() !== 0) invalid("LZMA range stream requires an initial zero byte.");
    for (let i = 0; i < 4; i++) this.code = (this.code * 256 + this.byte()) >>> 0;
    if (this.code >= this.range) invalid("LZMA initial range code is invalid.");
  }
  normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range * 256) >>> 0;
      this.code = (this.code * 256 + this.byte()) >>> 0;
    }
    if (this.code >= this.range) invalid("LZMA range code is outside its interval.");
  }
  decision(): void {
    if (this.decisions >= this.maxDecisions) this.limit("range decisions");
    this.decisions++;
    this.step(1);
  }
  bit(at: number): number {
    this.decision();
    const probability = this.probs[at];
    if (probability === undefined || probability < 31 || probability > 2017) {
      invalid("LZMA probability index/invariant is invalid.");
    }
    const bound = (this.range >>> 11) * probability;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      this.probs[at] = probability + ((2048 - probability) >>> 5);
      bit = 0;
    } else {
      this.range -= bound;
      this.code -= bound;
      this.probs[at] = probability - (probability >>> 5);
      bit = 1;
    }
    this.normalize();
    return bit;
  }
  tree(base: number, count: number, reverse = false): number {
    let node = 1;
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = this.bit(base + node);
      node = node * 2 + bit;
      if (reverse) value += bit * 2 ** i;
    }
    return reverse ? value : node - 2 ** count;
  }
  direct(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      this.decision();
      this.range >>>= 1;
      const bit = this.code >= this.range ? 1 : 0;
      if (bit) this.code -= this.range;
      value = value * 2 + bit;
      this.normalize();
    }
    return value;
  }
  length(base: number, position: number): number {
    if (!this.bit(base)) return this.tree(base + 2 + position * 8, 3);
    if (!this.bit(base + 1)) return 8 + this.tree(base + 130 + position * 8, 3);
    return 16 + this.tree(base + 258, 8);
  }
  previous(distance: number): number {
    if (distance < 1 || distance > this.dictionary.length || distance > this.history) {
      invalid("LZMA match exceeds available dictionary history.");
    }
    return this.dictionary[(this.position + this.dictionary.length - distance) % this.dictionary.length]!;
  }
  /** Longest symbol: 1+1+10+6+30=48 decisions. Probabilities stay 31..2017, so normalization needs <=1 byte/decision.
   * A 64-byte lookahead covers a complete symbol without rollback; real tail bytes are never replaced with zeroes. */
  symbol(): boolean {
    const position = this.history % 2 ** this.pb;
    const statePosition = this.state * 16 + position;
    if (!this.bit(statePosition)) {
      const previous = this.history ? this.previous(1) : 0;
      const context = (this.history % 2 ** this.lp) * 2 ** this.lc + (previous >>> (8 - this.lc));
      const base = 1846 + context * 768;
      let node = 1;
      if (this.state >= 7) {
        let matched = this.previous(this.reps[0]! + 1);
        while (node < 256) {
          const expected = matched >>> 7;
          matched = (matched * 2) & 255;
          const bit = this.bit(base + (1 + expected) * 256 + node);
          node = node * 2 + bit;
          if (bit !== expected) break;
        }
      }
      while (node < 256) node = node * 2 + this.bit(base + node);
      this.literal = node - 256;
      this.pending = 1;
      this.state = this.state < 4 ? 0 : this.state < 10 ? this.state - 3 : this.state - 6;
      return false;
    }
    this.literal = -1;
    if (!this.bit(192 + this.state)) {
      this.reps[3] = this.reps[2]!;
      this.reps[2] = this.reps[1]!;
      this.reps[1] = this.reps[0]!;
      const length = this.length(818, position);
      const slot = this.tree(432 + Math.min(length, 3) * 64, 6);
      let distance = slot;
      if (slot >= 4) {
        const count = Math.floor(slot / 2) - 1;
        distance = (2 + slot % 2) * 2 ** count;
        // The packed table omits the unused first cell of the specification's 115-cell distance array.
        distance += slot < 14
          ? this.tree(688 + distance - slot - 1, count, true)
          : this.direct(count - 4) * 16 + this.tree(802, 4, true);
      }
      this.state = this.state < 7 ? 7 : 10;
      if (distance === 0xffffffff) {
        if (this.code !== 0) invalid("LZMA EOS has unfinished range state.");
        return true;
      }
      this.reps[0] = distance;
      this.pending = length + 2;
    } else {
      if (!this.history) invalid("LZMA repetition has no dictionary history.");
      if (!this.bit(204 + this.state)) {
        if (!this.bit(240 + statePosition)) {
          this.state = this.state < 7 ? 9 : 11;
          this.pending = 1;
        }
      } else {
        let index: number;
        if (!this.bit(216 + this.state)) index = 1;
        else index = this.bit(228 + this.state) ? 3 : 2;
        const distance = this.reps[index]!;
        for (let i = index; i > 0; i--) this.reps[i] = this.reps[i - 1]!;
        this.reps[0] = distance;
      }
      if (!this.pending) {
        this.pending = this.length(1332, position) + 2;
        this.state = this.state < 7 ? 8 : 11;
      }
    }
    this.distance = this.reps[0]! + 1;
    this.previous(this.distance);
    return false;
  }
  put(bytes: Uint8Array, at: number, count: number): void {
    if (this.size !== undefined && count > this.size - this.total) invalid("LZMA output exceeds declared size.");
    if (this.options.format === "raw-lzma2" && count > this.chunkOutput) invalid("LZMA2 output exceeds chunk size.");
    this.step(count);
    this.budget.decoded(count);
    this.budget.output(count);
    for (let i = 0; i < count; i++) {
      const value = this.raw ? this.cursor.byte() : this.literal >= 0 ? this.literal : this.previous(this.distance);
      bytes[at + i] = value;
      this.dictionary[this.position++] = value;
      if (this.position === this.dictionary.length) this.position = 0;
      this.history++;
      this.total++;
    }
    this.pending -= count;
    if (this.options.format === "raw-lzma2") this.chunkOutput -= count;
  }
  /** LZMA2 controls progress from retained state (80), state reset (A0),
   * properties/state reset (C0), to full dictionary reset (E0). A raw chunk
   * invalidates compressed state; its successor must restore state/properties. */
  async chunk(): Promise<void> {
    await this.cursor.ensure(6);
    const control = this.cursor.byte();
    this.budget.decoded(1);
    if (control === 0) {
      this.termination = "lzma2-end";
      return;
    }
    if (this.chunks >= this.maxChunks) this.limit("chunk count");
    this.chunks++;
    if (control > 2 && control < 128) invalid("LZMA2 control byte is reserved.");
    if (control === 1 || control >= 224) {
      this.resetDictionary();
      this.needDictionary = false;
      this.needProperties = true;
    }
    if (this.needDictionary) invalid("LZMA2 initial dictionary reset is missing.");
    this.chunkOutput = (control >= 128 ? (control & 31) * 65536 : 0) + this.cursor.byte() * 256 + this.cursor.byte() +
      1;
    this.budget.decoded(2);
    if (this.size !== undefined && this.chunkOutput > this.size - this.total) {
      invalid("LZMA2 chunk exceeds remaining declared size.");
    }
    this.raw = control < 128;
    if (this.raw) {
      this.needState = true;
      this.chunkPacked = -1;
      return;
    }
    this.chunkPacked = this.cursor.byte() * 256 + this.cursor.byte() + 1;
    this.budget.decoded(2);
    if (control >= 192) {
      this.properties(this.cursor.byte());
      this.budget.decoded(1);
      this.needProperties = false;
    } else {
      if (this.needProperties) invalid("LZMA2 properties reset is missing.");
      if (control >= 160) this.reset();
      else if (this.needState) invalid("LZMA2 state reset is missing.");
    }
    this.needState = false;
    await this.cursor.ensure(this.chunkPacked);
    this.initializeRange();
  }
  async quantum(): Promise<Uint8Array> {
    this.signal.throwIfAborted();
    // Fixed 16 KiB scratch is admitted by the independent owned-memory policy. Actual returned batches are charged in put().
    const bytes = new Uint8Array(16384);
    let used = 0;
    const startSteps = this.steps;
    while (used < bytes.length && this.termination === "pending") {
      this.signal.throwIfAborted();
      if (this.options.format === "raw-lzma2") {
        if (!this.chunkOutput) {
          if (this.pending) invalid("LZMA2 match crosses a chunk output boundary.");
          if (this.chunkPacked >= 0 && (this.chunkPacked !== 0 || this.code !== 0)) {
            invalid("LZMA2 chunk did not finish its exact packed extent/range state.");
          }
          await this.chunk();
          if (this.termination !== "pending") break;
        }
        if (this.raw) {
          await this.cursor.ensure(Math.min(this.chunkOutput, bytes.length - used));
          this.pending = Math.min(this.chunkOutput, bytes.length - used);
        }
      } else if (!this.pending && this.size === this.total && this.marker === "optional" && this.code === 0) {
        this.termination = "size";
        break;
      }
      if (!this.pending) {
        if (this.options.format !== "raw-lzma2") await this.cursor.ensure(64);
        if (this.symbol()) {
          if (this.options.format === "raw-lzma2") invalid("LZMA2 compressed chunks forbid inner EOS markers.");
          this.termination = "end-marker";
          break;
        }
        if (this.size !== undefined && this.pending > this.size - this.total) {
          invalid("LZMA match/literal exceeds declared size.");
        }
        if (this.options.format === "raw-lzma2" && this.pending > this.chunkOutput) {
          invalid("LZMA2 match exceeds declared chunk output.");
        }
      }
      const count = Math.min(this.pending, bytes.length - used);
      this.put(bytes, used, count);
      used += count;
      if (this.steps - startSteps >= 65536) break;
    }
    if (this.termination !== "pending") {
      if (this.size !== undefined && this.total !== this.size) invalid("LZMA terminated before declared output size.");
      if (this.cursor.remaining) invalid("LZMA packed extent contains trailing bytes.");
    }
    return bytes.subarray(0, used);
  }
}

/** Allocate no decoder until consumption starts; finished rejects on source/parser errors and resolves pending on cancellation. */
export function createLzmaDecoder(input: ByteSourceType, supplied: LzmaOptionsType): LzmaDecoderType {
  let options: LzmaOptionsType = { ...supplied };
  if (options.format === "raw-lzma1") {
    if (!isBytes(options.properties) || options.properties.length !== 5) {
      throw new TypeError("Raw LZMA1 properties must contain five bytes.");
    }
    options = { ...options, properties: new Uint8Array(toView(options.properties)) };
    if (options.marker !== undefined && options.marker !== "required" && options.marker !== "optional") {
      throw new TypeError("Unknown LZMA end-marker policy.");
    }
  } else if (options.format === "raw-lzma2") {
    integer(options.dictionary, "LZMA2 dictionary property");
    if (options.dictionary > 40) invalid("LZMA2 dictionary property exceeds40.");
  } else if (options.format !== "alone") throw new TypeError("Unknown LZMA framing profile.");
  if (options.format !== "alone" && options.size !== undefined) integer(options.size, "LZMA expected size");
  const { size, identity, stability } = input;
  integer(size, "LZMA source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown LZMA source stability.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("LZMA source identity exceeds its string bound.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("LZMA requires stable source evidence or explicit unverified acceptance.");
  }
  const source: ByteSourceType = {
    size,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
    read: input.read.bind(input),
  };
  const maximums = [
    [options.maxDictionaryBytes ?? 8 * 1024 * 1024, 64 * 1024 * 1024],
    [options.maxMemoryBytes ?? 16 * 1024 * 1024, 65 * 1024 * 1024],
    [options.maxDecisions ?? 64 * 1024 * 1024, 512 * 1024 * 1024],
    [options.maxSteps ?? 128 * 1024 * 1024, 1024 * 1024 * 1024],
    [options.maxChunks ?? 100000, 1000000],
    [options.inputChunkBytes ?? 65536, 65536],
  ];
  for (const [value, ceiling] of maximums) {
    integer(value!, "LZMA policy limit");
    if (value! > ceiling!) throw new RangeError("LZMA policy exceeds implementation ceiling.");
  }
  if (options.inputChunkBytes === 0) throw new RangeError("LZMA source request quantum must be positive.");
  const memory = options.maxMemoryBytes ?? 16 * 1024 * 1024;
  if (memory < 65536 + 64 + 16384) {
    throw new ArchiveError("budget-exceeded", "LZMA fixed cursor/output memory exceeds policy.");
  }
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([abort.signal, options.signal]) : abort.signal;
  const budget = new ArchiveBudget(source, options, signal);
  let kernel: Kernel | undefined;
  let active: Promise<void> | undefined;
  let settled = false;
  let cancelled = false;
  let failed = false;
  let failure: unknown;
  let control: ReadableStreamDefaultController<Uint8Array>;
  const cancelReason = new Error("LZMA consumer cancelled.");
  let resolve!: (result: LzmaResultType) => void;
  let reject!: (reason: unknown) => void;
  const finished = new Promise<LzmaResultType>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void finished.catch(() => {});
  const result = (status: LzmaResultType["status"]): LzmaResultType => ({
    status,
    termination: status === "cancelled" ? "pending" : kernel?.termination ?? "pending",
    integrity: "none",
    dictionaryBytes: kernel?.dictionary.length ?? 0,
    decisions: kernel?.decisions ?? 0,
    steps: kernel?.steps ?? 0,
    chunks: kernel?.chunks ?? 0,
    work: budget.inspect(),
  });
  const complete = (status: LzmaResultType["status"]): void => {
    if (settled) return;
    settled = true;
    options.signal?.removeEventListener("abort", onAbort);
    resolve(result(status));
    kernel = undefined;
  };
  const fail = (reason: unknown): void => {
    if (settled) return;
    settled = true;
    failed = true;
    failure = reason;
    options.signal?.removeEventListener("abort", onAbort);
    reject(reason);
    kernel = undefined;
    control.error(reason);
  };
  const onAbort = (): void => {
    abort.abort(options.signal?.reason);
    void Promise.resolve().then(async () => {
      await active;
      fail(options.signal?.reason);
    });
  };
  const open = async (): Promise<void> => {
    const cursor = new Cursor(budget, size, options.inputChunkBytes ?? 65536);
    let properties: number | undefined;
    let dictionary: number;
    let expected: number | undefined;
    let marker: "required" | "optional" = "required";
    if (options.format === "alone") {
      await cursor.ensure(13);
      const bytes = new Uint8Array(13);
      for (let i = 0; i < 13; i++) bytes[i] = cursor.byte();
      budget.decoded(13);
      properties = bytes[0]!;
      dictionary = Math.max(4096, view(bytes).getUint32(1, true));
      const declared = view(bytes).getBigUint64(5, true);
      if (declared !== 0xffffffffffffffffn) {
        if (declared > BigInt(Number.MAX_SAFE_INTEGER)) unsupported("LZMA output size exceeds safe indexing.");
        expected = Number(declared);
        marker = "optional";
      }
    } else if (options.format === "raw-lzma1") {
      properties = options.properties[0]!;
      dictionary = Math.max(4096, view(options.properties).getUint32(1, true));
      expected = options.size;
      marker = options.marker ?? (expected === undefined ? "required" : "optional");
    } else {
      const value = options.dictionary;
      dictionary = value === 40 ? 0xffffffff : (2 + value % 2) * 2 ** (Math.floor(value / 2) + 11);
      expected = options.size;
    }
    kernel = new Kernel(cursor, budget, options, signal, dictionary, memory);
    kernel.size = expected;
    kernel.marker = marker;
    if (properties !== undefined) {
      kernel.properties(properties);
      await cursor.ensure(5);
      kernel.initializeRange();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    },
    async pull(controller) {
      if (settled) return;
      // Publish the join before a borrowed source or scheduler can reenter cancellation.
      active = Promise.resolve().then(async () => {
        try {
          signal.throwIfAborted();
          if (!kernel) await open();
          signal.throwIfAborted();
          const bytes = await kernel!.quantum();
          signal.throwIfAborted();
          if (bytes.length) controller.enqueue(bytes);
          if (kernel!.termination !== "pending") {
            controller.close();
            complete("complete");
          } else if (options.yield) {
            await options.yield();
            signal.throwIfAborted();
          }
        } catch (reason) {
          if (!(cancelled && reason === cancelReason)) fail(reason);
        }
      });
      await active;
      active = undefined;
    },
    async cancel() {
      cancelled = true;
      abort.abort(cancelReason);
      await active;
      if (failed) throw failure;
      complete("cancelled");
    },
  }, { highWaterMark: 0 });
  return Object.freeze({ stream, finished });
}
