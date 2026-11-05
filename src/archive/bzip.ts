/** Pure bounded BZip2 decoding with verified-block output and separate whole-stream evidence. @module */
import type { ByteSourceType } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Memory limits cover decoder-owned typed buffers, not borrowed source allocations or consumer-retained chunks. */
export interface BzipOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Advertised transformed block capacity, not expanded plaintext. Default/maximum 900000 bytes. */
  readonly maxBlockBytes?: number;
  /** Typed scratch capacity. Default 8 MiB; implementation maximum 16 MiB. */
  readonly maxMemoryBytes?: number;
  /** Default 4096; implementation maximum 65536. */
  readonly maxBlocks?: number;
  /** Bits, table updates, MTF moves, BWT visits and expanded bytes. Default 256 Mi; maximum 1 Gi. */
  readonly maxSteps?: number;
  /** Exact source request quantum, 1..65536 bytes. Default 65536. */
  readonly inputChunkBytes?: number;
  /** Maximum returned chunk, 1..65536 bytes. Default 65536. */
  readonly outputChunkBytes?: number;
  /** Borrowed scheduling capability, awaited at finite parser boundaries after 4096 steps and each emitted chunk. */
  readonly yield?: () => Promise<void>;
}

/** All emitted bytes belong to blocks with matching CRC; only complete EOF verifies the combined stream CRC. */
export interface BzipResultType {
  readonly status: "complete" | "cancelled";
  readonly integrity: "checksum-verified" | "checksum-pending";
  readonly blockBytes?: number;
  readonly blocks: number;
  readonly verifiedBlocks: number;
  readonly steps: number;
  readonly memoryBytes: number;
  readonly work: ArchiveWorkType;
}

/** Observe finished for terminal failure and the in-flight-operation join, including after early cancellation. */
export interface BzipDecoderType {
  readonly stream: ReadableStream<Uint8Array>;
  readonly finished: Promise<BzipResultType>;
}

/** Refills preserve at most seven undecoded bytes; returned foreign source views are copied before reuse. */
class Cursor {
  readonly bytes: Uint8Array;
  readonly #budget: ArchiveBudget;
  readonly #size: number;
  readonly #chunk: number;
  readonly #step: (count: number) => void;
  bit = 0;
  end = 0;
  fetched = 0;
  consumed = 0;
  constructor(budget: ArchiveBudget, size: number, chunk: number, step: (count: number) => void) {
    this.#budget = budget;
    this.#size = size;
    this.#chunk = chunk;
    this.#step = step;
    this.bytes = new Uint8Array(chunk + 8);
  }
  get available(): number {
    return this.end * 8 - this.bit;
  }
  async ensure(count: number): Promise<void> {
    if (this.available >= count) return;
    const discard = this.bit >>> 3;
    this.bytes.copyWithin(0, discard, this.end);
    this.end -= discard;
    this.bit -= discard * 8;
    while (this.available < count && this.fetched < this.#size) {
      const length = Math.min(this.#chunk, this.#size - this.fetched, this.bytes.length - this.end);
      const bytes = await this.#budget.read(this.fetched, length);
      this.bytes.set(bytes, this.end);
      this.end += length;
      this.fetched += length;
    }
    if (this.available < count) invalid("BZip2 packed bits are truncated.");
  }
  read(count: number): number {
    if (count > this.available) invalid("BZip2 packed bit extent is incomplete.");
    this.#step(count);
    let value = 0;
    for (let i = 0; i < count; i++, this.bit++, this.consumed++) {
      value = value * 2 + ((this.bytes[this.bit >>> 3]! >>> (7 - (this.bit & 7))) & 1);
    }
    return value;
  }
  async field(count: number): Promise<number> {
    if (this.available < count) await this.ensure(count);
    return this.read(count);
  }
}

interface TreeType {
  readonly counts: Uint16Array;
  readonly first: Uint32Array;
  readonly starts: Uint16Array;
  readonly symbols: Uint16Array;
  readonly width: number;
}

/** Flat canonical tables bound allocation by the alphabet, not by 2^maximum-code-length. */
function tree(lengths: Uint8Array, step: (count: number) => void): TreeType {
  const counts = new Uint16Array(21);
  let width = 0;
  for (const length of lengths) {
    counts[length] = counts[length]! + 1;
    width = Math.max(width, length);
  }
  const first = new Uint32Array(21);
  const starts = new Uint16Array(21);
  let code = 0;
  let used = 0;
  let left = 1;
  for (let length = 1; length <= 20; length++) {
    left = left * 2 - counts[length]!;
    if (left < 0) invalid("BZip2 Huffman tree is oversubscribed.");
    code = (code + counts[length - 1]!) * 2;
    first[length] = code;
    starts[length] = used;
    used += counts[length]!;
  }
  const symbols = new Uint16Array(lengths.length);
  let at = 0;
  for (let length = 1; length <= width; length++) {
    for (let symbol = 0; symbol < lengths.length; symbol++) {
      step(1);
      if (lengths[symbol] === length) symbols[at++] = symbol;
    }
  }
  return { counts, first, starts, symbols, width };
}

function symbol(cursor: Cursor, table: TreeType): number {
  let code = 0;
  for (let length = 1; length <= table.width; length++) {
    code = code * 2 + cursor.read(1);
    const delta = code - table.first[length]!;
    if (delta >= 0 && delta < table.counts[length]!) return table.symbols[table.starts[length]! + delta]!;
  }
  return invalid("BZip2 Huffman symbol is absent from its tree.");
}

/** Inverse BWT emits the initial RLE representation; four equal bytes require a following count byte. */
class Walker {
  readonly #table: Uint32Array;
  readonly #count: number;
  readonly #step: (count: number) => void;
  #position: number;
  #used = 0;
  #previous = -1;
  #run = 0;
  value = 0;
  constructor(table: Uint32Array, count: number, origin: number, step: (count: number) => void) {
    this.#table = table;
    this.#count = count;
    this.#position = table[origin]! >>> 8;
    this.#step = step;
  }
  next(): number {
    if (this.#used === this.#count) {
      if (this.#run === 4) invalid("BZip2 RLE count byte is missing.");
      return -1;
    }
    if (this.#position >= this.#count) invalid("BZip2 inverse BWT pointer exceeds its block.");
    this.#step(1);
    const packed = this.#table[this.#position]!;
    this.#position = packed >>> 8;
    this.#used++;
    const value = packed & 255;
    if (this.#run === 4) {
      this.value = this.#previous;
      this.#run = 0;
      this.#previous = -1;
      return value;
    }
    this.value = value;
    this.#run = this.#previous === value ? this.#run + 1 : 1;
    this.#previous = value;
    return 1;
  }
}

/** Decode one non-randomized BZh1..9 stream. Concatenation, whole trailing bytes and nonzero padding are refused.
 * The source stays borrowed. A whole transformed block is materialized, then traversed twice: once for CRC and
 * once to emit verified output. Cancellation joins through finished, never by closing the borrowed source.
 */
export function createBzipDecoder(source: ByteSourceType, options: BzipOptionsType = {}): BzipDecoderType {
  options = { ...options };
  const { size, identity, stability } = source;
  integer(size, "BZip2 source size");
  if (stability !== undefined && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown BZip2 stability evidence.");
  }
  if (identity !== undefined && (typeof identity !== "string" || identity.length > 8192)) {
    throw new TypeError("BZip2 identity exceeds 8192 UTF16 code units.");
  }
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("BZip2 requires source stability or explicit unverified-source acceptance.");
  }
  const snapshot: ByteSourceType = {
    size,
    read: source.read.bind(source),
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  const inputChunk = options.inputChunkBytes ?? 65536;
  const outputChunk = options.outputChunkBytes ?? 65536;
  const maximumBlock = options.maxBlockBytes ?? 900000;
  const maximumMemory = options.maxMemoryBytes ?? 8 * 1024 * 1024;
  const maximumBlocks = options.maxBlocks ?? 4096;
  const maximumSteps = options.maxSteps ?? 256 * 1024 * 1024;
  for (
    const [name, value] of Object.entries({
      inputChunk,
      outputChunk,
      maximumBlock,
      maximumMemory,
      maximumBlocks,
      maximumSteps,
    })
  ) integer(value, name);
  if (
    !inputChunk || inputChunk > 65536 || !outputChunk || outputChunk > 65536 || maximumBlock > 900000 ||
    maximumMemory > 16 * 1024 * 1024 || maximumBlocks > 65536 || maximumSteps > 1024 * 1024 * 1024
  ) throw new RangeError("BZip2 implementation policy ceiling exceeded.");
  const fixedMemory = inputChunk + 8 + outputChunk + 65536;
  if (fixedMemory > maximumMemory) {
    throw new ArchiveError("budget-exceeded", "BZip2 cursor/table/output scratch exceeds memory policy.");
  }
  const local = createArchiveLedger(options);
  const budget = new ArchiveBudget(snapshot, {
    ...options,
    ledger: {
      reserve(kind, count) {
        local.reserve(kind, count);
        options.ledger?.reserve(kind, count);
      },
      inspect: () => local.inspect(),
    },
  });
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  // Input reads observe the same internal cancellation authority as the pure kernel.
  const inputBudget = new ArchiveBudget(snapshot, {
    ...options,
    ledger: {
      reserve(kind, count) {
        local.reserve(kind, count);
        options.ledger?.reserve(kind, count);
      },
      inspect: () => local.inspect(),
    },
  }, signal);
  let steps = 0;
  let nextYield = 4096;
  let stopped = false;
  let settled = false;
  let cancelled = false;
  const cancelReason = new Error("BZip2 decoder was cancelled.");
  let active: Promise<void> | undefined;
  let blocks = 0;
  let verifiedBlocks = 0;
  let blockBytes: number | undefined;
  let memoryBytes = fixedMemory;
  let table = new Uint32Array(0);
  let walker: Walker | undefined;
  let remaining = 0;
  let pending = 0;
  let combined = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let resolve!: (result: BzipResultType) => void;
  let reject!: (reason: unknown) => void;
  const finished = new Promise<BzipResultType>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void finished.catch(() => {});
  const check = (): void => {
    signal.throwIfAborted();
    if (stopped) throw cancelReason;
  };
  const step = (count: number): void => {
    check();
    if (count > maximumSteps - steps) throw new ArchiveError("budget-exceeded", "BZip2 CPU step limit exceeded.");
    steps += count;
  };
  const pause = async (): Promise<void> => {
    if (steps >= nextYield) {
      nextYield = steps + 4096;
      if (options.yield) await options.yield();
      check();
    }
  };
  const cursor = new Cursor(inputBudget, size, inputChunk, step);
  // The polynomial defines BZip2's non-reflected CRC, not ZIP's reflected CRC32.
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i << 24;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
    crcTable[i] = value >>> 0;
  }
  const crc = (state: number, value: number): number =>
    ((state << 8) ^ crcTable[((state >>> 24) ^ value) & 255]!) >>> 0;
  const result = (status: "complete" | "cancelled"): BzipResultType => ({
    status,
    integrity: status === "complete" ? "checksum-verified" : "checksum-pending",
    ...(blockBytes === undefined ? {} : { blockBytes }),
    blocks,
    verifiedBlocks,
    steps,
    memoryBytes,
    work: local.inspect(),
  });
  const retire = (): void => {
    options.signal?.removeEventListener("abort", onAbort);
    table = new Uint32Array(0);
    walker = undefined;
  };
  const complete = (status: "complete" | "cancelled"): void => {
    if (settled) return;
    settled = true;
    stopped = true;
    retire();
    resolve(result(status));
  };
  const fail = (reason: unknown): void => {
    if (settled) return;
    settled = true;
    stopped = true;
    retire();
    controller.error(reason);
    reject(reason);
  };
  const onAbort = (): void => {
    if (!settled) {
      stopped = true;
      if (!active) fail(options.signal?.reason);
    }
  };

  const open = async (): Promise<void> => {
    if (await cursor.field(24) !== 0x425a68) invalid("BZip2 header must be BZh.");
    const level = await cursor.field(8);
    if (level < 49 || level > 57) invalid("BZip2 block level must be 1..9.");
    blockBytes = (level - 48) * 100000;
    if (blockBytes > maximumBlock) {
      throw new ArchiveError("budget-exceeded", "BZip2 advertised transformed block exceeds policy.");
    }
  };

  /** Parse a whole transformed block without buffering its potentially much larger expanded plaintext. */
  const block = async (): Promise<boolean> => {
    const first = await cursor.field(24);
    const last = await cursor.field(24);
    if (first === 0x177245 && last === 0x385090) {
      const expected = await cursor.field(32);
      if (expected !== combined) throw new ArchiveError("checksum-mismatch", "BZip2 combined stream CRC mismatch.");
      const pad = (8 - cursor.consumed % 8) % 8;
      if (pad && await cursor.field(pad) !== 0) unsupported("BZip2 selected profile requires zero final padding bits.");
      if (cursor.consumed / 8 !== size) unsupported("BZip2 concatenation and trailing bytes are not supported.");
      check();
      return false;
    }
    if (first !== 0x314159 || last !== 0x265359) invalid("BZip2 block marker is invalid.");
    if (blocks === maximumBlocks) throw new ArchiveError("budget-exceeded", "BZip2 block count limit exceeded.");
    blocks++;
    const expectedCRC = await cursor.field(32);
    if (await cursor.field(1)) unsupported("Randomized legacy BZip2 blocks are not supported.");
    const origin = await cursor.field(24);
    if (origin >= blockBytes!) invalid("BZip2 origin exceeds transformed block capacity.");
    if (!table.length) {
      memoryBytes = fixedMemory + blockBytes! * 4;
      if (memoryBytes > maximumMemory) {
        throw new ArchiveError("budget-exceeded", "BZip2 transformed block exceeds memory policy.");
      }
      table = new Uint32Array(blockBytes!);
    }
    const groups = await cursor.field(16);
    const alphabet = new Uint8Array(256);
    let alphabetSize = 0;
    for (let group = 0; group < 16; group++) {
      if ((groups >>> (15 - group)) & 1) {
        const flags = await cursor.field(16);
        for (let bit = 0; bit < 16; bit++) if ((flags >>> (15 - bit)) & 1) alphabet[alphabetSize++] = group * 16 + bit;
      }
    }
    if (!alphabetSize) invalid("BZip2 used alphabet is empty.");
    const treeCount = await cursor.field(3);
    const selectorCount = await cursor.field(15);
    if (treeCount < 2 || treeCount > 6 || !selectorCount) invalid("BZip2 Huffman selector counts are invalid.");
    const selectors = new Uint8Array(selectorCount);
    const selectorMtf = Uint8Array.from({ length: treeCount }, (_, i) => i);
    for (let i = 0; i < selectorCount; i++) {
      let index = 0;
      while (await cursor.field(1)) if (++index >= treeCount) invalid("BZip2 selector MTF index exceeds its alphabet.");
      const value = selectorMtf[index]!;
      step(index + 1);
      for (; index > 0; index--) selectorMtf[index] = selectorMtf[index - 1]!;
      selectorMtf[0] = value;
      selectors[i] = value;
      if (steps >= nextYield) await pause();
    }
    const trees: TreeType[] = [];
    const symbolCount = alphabetSize + 2;
    for (let i = 0; i < treeCount; i++) {
      let current = await cursor.field(5);
      const lengths = new Uint8Array(symbolCount);
      for (let j = 0; j < symbolCount; j++) {
        while (true) {
          if (current < 1 || current > 20) invalid("BZip2 Huffman code length exceeds 1..20.");
          if (!await cursor.field(1)) break;
          current += await cursor.field(1) ? -1 : 1;
          if (steps >= nextYield) await pause();
        }
        lengths[j] = current;
      }
      trees.push(tree(lengths, step));
      if (steps >= nextYield) await pause();
    }
    let selector = -1;
    let selected = 0;
    let position = 0;
    const frequencies = new Uint32Array(256);
    const mtf = alphabet.slice(0, alphabetSize);
    // Each group selects one table for fifty symbols including run codes. Refill and scheduling
    // stay outside this synchronous buffered path, rather than allocating a promise per symbol.
    const next = (): number => {
      if (selected === 0) {
        if (++selector >= selectors.length) invalid("BZip2 Huffman selectors ended before EOB.");
        selected = 50;
      }
      selected--;
      return symbol(cursor, trees[selectors[selector]!]!);
    };
    if (cursor.available < 20) await cursor.ensure(20);
    let value = next();
    while (value !== alphabetSize + 1) {
      if (value < 2) {
        let run = 0;
        let weight = 1;
        do {
          const add = (value + 1) * weight;
          if (add > blockBytes! - position - run) invalid("BZip2 RUNA/RUNB expansion exceeds transformed block.");
          run += add;
          weight *= 2;
          if (cursor.available < 20) await cursor.ensure(20);
          value = next();
        } while (value < 2);
        budget.decoded(run);
        for (let offset = 0; offset < run; offset += 4096) {
          const count = Math.min(4096, run - offset);
          step(count);
          table.fill(mtf[0]!, position + offset, position + offset + count);
          if (steps >= nextYield) await pause();
        }
        frequencies[mtf[0]!] = frequencies[mtf[0]!]! + run;
        position += run;
        if (steps >= nextYield) await pause();
        continue;
      }
      const index = value - 1;
      if (index >= alphabetSize || position === blockBytes) invalid("BZip2 MTF symbol exceeds transformed block.");
      step(index + 1);
      budget.decoded(1);
      const byte = mtf[index]!;
      for (let i = index; i > 0; i--) mtf[i] = mtf[i - 1]!;
      mtf[0] = byte;
      table[position++] = byte;
      frequencies[byte] = frequencies[byte]! + 1;
      if (cursor.available < 20) await cursor.ensure(20);
      value = next();
      if (steps >= nextYield) await pause();
    }
    if (!position || origin >= position) invalid("BZip2 origin exceeds actual transformed block.");
    const starts = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < 256; i++) {
      starts[i] = total;
      total += frequencies[i]!;
    }
    for (let i = 0; i < position; i++) {
      step(1);
      const byte = table[i]! & 255;
      const slot = starts[byte]!;
      starts[byte] = slot + 1;
      table[slot] = table[slot]! | (i << 8);
      if ((i & 4095) === 0 && steps >= nextYield) await pause();
    }
    const verification = new Walker(table, position, origin, step);
    let checksum = 0xffffffff;
    let count: number;
    let expanded = 0;
    while ((count = verification.next()) !== -1) {
      step(count);
      budget.decoded(count);
      expanded += count;
      for (let i = 0; i < count; i++) checksum = crc(checksum, verification.value);
      if (steps >= nextYield) await pause();
    }
    if (((checksum ^ 0xffffffff) >>> 0) !== expectedCRC) {
      throw new ArchiveError("checksum-mismatch", "BZip2 block CRC mismatch.");
    }
    verifiedBlocks++;
    combined = (((combined << 1) | (combined >>> 31)) ^ expectedCRC) >>> 0;
    walker = new Walker(table, position, origin, step);
    remaining = expanded;
    pending = 0;
    check();
    return true;
  };

  const emit = async (): Promise<Uint8Array> => {
    const count = Math.min(outputChunk, remaining);
    budget.output(count);
    budget.decoded(count);
    step(count);
    const bytes = new Uint8Array(count);
    let at = 0;
    while (at < count) {
      if (!pending) {
        pending = walker!.next();
        if (pending < 0) invalid("BZip2 verified replay ended early.");
        if (!pending) continue;
      }
      const size = Math.min(pending, count - at);
      bytes.fill(walker!.value, at, at + size);
      at += size;
      pending -= size;
      if ((at & 4095) === 0 && steps >= nextYield) await pause();
    }
    remaining -= count;
    check();
    return bytes;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(control) {
      controller = control;
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    },
    async pull(control) {
      if (settled) return;
      // Publish the join before a borrowed read/yield callback can reenter cancellation.
      active = Promise.resolve().then(async () => {
        try {
          check();
          if (blockBytes === undefined) await open();
          while (!remaining) {
            if (!await block()) {
              control.close();
              complete("complete");
              return;
            }
          }
          const bytes = await emit();
          check();
          control.enqueue(bytes);
          if (options.yield) {
            await options.yield();
            check();
          }
        } catch (reason) {
          if (!(cancelled && reason === cancelReason)) fail(reason);
        }
      });
      await active;
      active = undefined;
      if (cancelled && !settled) complete("cancelled");
    },
    cancel() {
      cancelled = true;
      stopped = true;
      abort.abort(cancelReason);
      if (!active) complete("cancelled");
    },
  }, { highWaterMark: 0 });
  return Object.freeze({ stream, finished });
}
