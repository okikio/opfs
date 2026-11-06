/** Bounded single-frame LZ4 decoding; checksum evidence becomes complete only at successful EOF. @module */
import { isBytes, toView } from "../bytes.ts";
import { close } from "../close.ts";
import { ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** Finite input, block, output and work admission. A whole archive is never buffered. */
export interface Lz4OptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Maximum acquired upstream chunk before making an owned snapshot. Default 64 KiB. */
  readonly maxInputChunkBytes?: number;
  /** Largest admitted decoded block. Default and implementation ceiling 4 MiB. */
  readonly maxBlockBytes?: number;
  /** Total block count, including empty blocks. Default 100000. */
  readonly maxBlocks?: number;
  /** Largest returned chunk. Default 64 KiB; implementation ceiling 64 KiB. */
  readonly outputChunkBytes?: number;
}

/** Header checksum has already passed when this metadata becomes available. */
export interface Lz4HeaderType {
  readonly independent: boolean;
  readonly blockBytes: number;
  readonly blockChecksum: boolean;
  readonly contentChecksum: boolean;
  readonly contentSize?: number;
}

/** Cancellation never verifies unconsumed content. Checksums detect corruption, not authentication. */
export interface Lz4ResultType {
  readonly status: "complete" | "cancelled";
  readonly header?: Lz4HeaderType;
  readonly integrity: "checksum-verified" | "checksum-pending" | "not-provided";
  readonly verifiedBlocks: number;
  readonly blocks: number;
  readonly work: ArchiveWorkType;
}

/** Consume the stream to EOF to receive complete footer evidence; always observe finished for terminal failures. */
export interface Lz4DecoderType {
  readonly stream: ReadableStream<Uint8Array>;
  readonly finished: Promise<Lz4ResultType>;
}

/**
 * Decode one modern frame, including dependent blocks with a 64 KiB history.
 * Acquires the source reader on first pull and owns it until EOF/cancel/failure.
 * Rejects dictionaries, skippable/legacy frames, concatenation and trailing bytes.
 * A verified block may be released before a later whole-frame checksum failure.
 */
export function createLz4Decoder(source: ReadableStream<Uint8Array>, options: Lz4OptionsType = {}): Lz4DecoderType {
  options = { ...options };
  const inputMaximum = options.maxInputChunkBytes ?? 65536;
  const blockMaximum = options.maxBlockBytes ?? 4 * 1024 * 1024;
  const blockCount = options.maxBlocks ?? 100000;
  const outputChunk = options.outputChunkBytes ?? 65536;
  for (const [name, value] of Object.entries({ inputMaximum, blockMaximum, blockCount, outputChunk })) {
    integer(value, name);
  }
  if (!inputMaximum || !blockMaximum || !outputChunk || blockMaximum > 4 * 1024 * 1024 || outputChunk > 65536) {
    throw new RangeError(
      "LZ4 input/block/output chunk limits must be positive; block ceiling is 4 MiB and output ceiling 64 KiB.",
    );
  }
  const ledger = createArchiveLedger({ ...options, maxOutputBytes: options.maxOutputBytes ?? 64 * 1024 * 1024 });
  const reserve = (kind: keyof ArchiveWorkType, count: number): void => {
    ledger.reserve(kind, count);
    options.ledger?.reserve(kind, count);
  };
  const signal = options.signal;
  signal?.throwIfAborted();
  let resolve!: (result: Lz4ResultType) => void;
  let reject!: (reason: unknown) => void;
  const finished = new Promise<Lz4ResultType>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Consumers may read the stream before awaiting completion; retain its rejection without an unhandled-rejection window.
  void finished.catch(() => {});
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let sourceDone = false;
  let sourceFailed = false;
  let stopped = false;
  let cleanup: Promise<void> | undefined;
  let header: Lz4HeaderType | undefined;
  let blocks = 0;
  let verifiedBlocks = 0;
  let decodedBytes = 0;
  let input: Uint8Array = new Uint8Array();
  let inputOffset = 0;
  let pending: Uint8Array = new Uint8Array();
  let pendingOffset = 0;
  let history: Uint8Array = new Uint8Array();
  const content = new XxHash32();
  const cancelled = new Error("LZ4 decoder has stopped.");
  let control: ReadableStreamDefaultController<Uint8Array>;
  const assertActive = (): void => {
    signal?.throwIfAborted();
    if (stopped) throw cancelled;
  };
  const retire = (reason?: unknown): Promise<void> =>
    cleanup ??= Promise.resolve().then(async () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        await close([
          () => sourceDone || sourceFailed ? undefined : reader?.cancel(reason),
          () => reader?.releaseLock(),
        ]);
      } finally {
        input = pending = history = new Uint8Array();
      }
    });
  const result = (status: "complete" | "cancelled"): Lz4ResultType => ({
    status,
    ...(header ? { header } : {}),
    blocks,
    verifiedBlocks,
    integrity: status === "cancelled"
      ? "checksum-pending"
      : header?.contentChecksum
      ? "checksum-verified"
      : "not-provided",
    work: ledger.inspect(),
  });
  const onAbort = (): void => {
    if (stopped) return;
    stopped = true;
    control.error(signal?.reason);
    void close([() => retire(signal?.reason)], [signal?.reason]).then(() => reject(signal?.reason), reject);
  };
  /** Only one bounded producer snapshot is retained. Acquisition is charged before copying into our memory. */
  const more = async (): Promise<boolean> => {
    while (inputOffset === input.length) {
      assertActive();
      if (sourceDone) return false;
      input = new Uint8Array();
      inputOffset = 0;
      reader ??= source.getReader();
      reserve("requests", 1);
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (reason) {
        sourceFailed = true;
        throw reason;
      }
      assertActive();
      if (next.done) {
        sourceDone = true;
        input = new Uint8Array();
        inputOffset = 0;
        return false;
      }
      if (!isBytes(next.value)) invalid("LZ4 source returned a non-byte chunk.");
      const bytes = toView(next.value);
      if (bytes.length > inputMaximum) {
        throw new ArchiveError("budget-exceeded", "LZ4 source chunk exceeds maxInputChunkBytes.");
      }
      reserve("sourceBytes", bytes.length);
      input = new Uint8Array(bytes);
      inputOffset = 0;
    }
    return true;
  };
  const read = async (length: number): Promise<Uint8Array<ArrayBuffer>> => {
    assertActive();
    // Count bytes already owned by the cursor once. Refuse impossible extents before allocating their contiguous buffer.
    const additional = Math.max(0, length - (input.length - inputOffset));
    const remaining = (options.maxSourceBytes ?? 64 * 1024 * 1024) - ledger.inspect().sourceBytes;
    if (additional > remaining) {
      throw new ArchiveError("budget-exceeded", "LZ4 extent exceeds remaining source byte policy.");
    }
    const bytes = new Uint8Array(length);
    let position = 0;
    while (position < length) {
      if (!await more()) invalid("LZ4 frame is truncated.");
      const count = Math.min(length - position, input.length - inputOffset);
      bytes.set(input.subarray(inputOffset, inputOffset + count), position);
      inputOffset += count;
      position += count;
    }
    return bytes;
  };
  const word = async (): Promise<number> => new DataView((await read(4)).buffer).getUint32(0, true);
  const open = async (): Promise<void> => {
    const magic = await word();
    if (magic !== 0x184d2204) {
      unsupported("Only one modern LZ4 frame is supported; skippable and legacy frames are refused.");
    }
    const flags = await read(2);
    const flg = flags[0]!;
    const bd = flags[1]!;
    if ((flg >>> 6) !== 1 || flg & 2 || bd & 0x8f) invalid("LZ4 frame version or reserved bits are invalid.");
    const code = bd >>> 4;
    if (code < 4 || code > 7) invalid("LZ4 block-size code is invalid.");
    const blockBytes = [65536, 262144, 1048576, 4194304][code - 4]!;
    if (blockBytes > blockMaximum) throw new ArchiveError("budget-exceeded", "LZ4 frame block maximum exceeds policy.");
    const optional = await read((flg & 8 ? 8 : 0) + (flg & 1 ? 4 : 0));
    const descriptor = new Uint8Array(2 + optional.length);
    descriptor.set(flags);
    descriptor.set(optional, 2);
    if ((await read(1))[0] !== ((hash32(descriptor) >>> 8) & 255)) {
      throw new ArchiveError("checksum-mismatch", "LZ4 frame header checksum failed.");
    }
    if (flg & 1) unsupported("LZ4 dictionary IDs require an unsupported external dictionary profile.");
    let contentSize: number | undefined;
    if (flg & 8) {
      const size = new DataView(optional.buffer).getBigUint64(0, true);
      if (size > BigInt(Number.MAX_SAFE_INTEGER)) invalid("LZ4 content size exceeds safe integer range.");
      contentSize = Number(size);
      const maximum = options.maxDecodedBytes ?? 64 * 1024 * 1024;
      if (contentSize > maximum) {
        throw new ArchiveError("budget-exceeded", "LZ4 declared content size exceeds decoded policy.");
      }
    }
    header = Object.freeze({
      independent: Boolean(flg & 32),
      blockBytes,
      blockChecksum: Boolean(flg & 16),
      contentChecksum: Boolean(flg & 4),
      ...(contentSize === undefined ? {} : { contentSize }),
    });
  };
  const block = async (): Promise<boolean> => {
    const encoded = await word();
    if (encoded === 0) {
      if (header!.contentChecksum && await word() !== content.digest()) {
        throw new ArchiveError("checksum-mismatch", "LZ4 complete content checksum failed.");
      }
      if (header!.contentSize !== undefined && decodedBytes !== header!.contentSize) {
        invalid("LZ4 decoded content size disagrees with header.");
      }
      if (await more()) unsupported("LZ4 concatenated frames and trailing bytes are unsupported.");
      return false;
    }
    if (blocks >= blockCount) throw new ArchiveError("budget-exceeded", "LZ4 block count exceeds maxBlocks.");
    const raw = Boolean(encoded & 0x80000000);
    const size = encoded & 0x7fffffff;
    if (size > header!.blockBytes) invalid("LZ4 encoded block exceeds declared block maximum.");
    const bytes = await read(size);
    if (header!.blockChecksum) {
      if (await word() !== hash32(bytes)) {
        throw new ArchiveError("checksum-mismatch", "LZ4 encoded block checksum failed.");
      }
      verifiedBlocks++;
    }
    const previous = header!.independent ? new Uint8Array() : history;
    const sizeDecoded = raw ? size : measureBlock(bytes, previous.length, header!.blockBytes);
    if (header!.contentSize !== undefined && sizeDecoded > header!.contentSize - decodedBytes) {
      invalid("LZ4 block exceeds declared remaining content size.");
    }
    reserve("decodedBytes", sizeDecoded);
    // Validate and measure without expanding matches first, so output allocation follows decoded admission.
    pending = raw ? bytes : decodeBlock(bytes, previous, sizeDecoded);
    pendingOffset = 0;
    decodedBytes += sizeDecoded;
    blocks++;
    content.update(pending);
    if (!header!.independent) {
      const length = Math.min(65536, history.length + pending.length);
      const next = new Uint8Array(length);
      const tail = Math.min(pending.length, length);
      next.set(history.subarray(history.length - (length - tail)), 0);
      next.set(pending.subarray(pending.length - tail), length - tail);
      history = next;
    }
    return true;
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      control = controller;
      signal?.addEventListener("abort", onAbort, { once: true });
    },
    async pull(controller) {
      if (stopped) return;
      try {
        assertActive();
        if (!header) await open();
        while (pendingOffset === pending.length) {
          // History has its own bounded snapshot; release the consumed block before allocating its successor.
          pending = new Uint8Array();
          pendingOffset = 0;
          if (!await block()) {
            try {
              await retire();
            } catch (failure) {
              stopped = true;
              controller.error(failure);
              reject(failure);
              return;
            }
            if (stopped) return;
            stopped = true;
            controller.close();
            resolve(result("complete"));
            return;
          }
        }
        assertActive();
        const count = Math.min(outputChunk, pending.length - pendingOffset);
        reserve("outputBytes", count);
        controller.enqueue(pending.slice(pendingOffset, pendingOffset + count));
        pendingOffset += count;
      } catch (reason) {
        if (stopped) return;
        stopped = true;
        try {
          await close([() => retire(reason)], [reason]);
        } catch (failure) {
          controller.error(failure);
          reject(failure);
        }
      }
    },
    async cancel(reason) {
      if (stopped) {
        await cleanup;
        return;
      }
      stopped = true;
      try {
        await retire(reason);
        resolve(result("cancelled"));
      } catch (failure) {
        reject(failure);
        throw failure;
      }
    },
  }, { highWaterMark: 0 });
  return Object.freeze({ stream, finished });
}

/** Walk bounded token bytes twice: the measuring pass validates references and terminal constraints without expanding matches. */
function sequences(
  input: Uint8Array,
  history: number,
  maximum: number,
  output?: Uint8Array,
  previous?: Uint8Array,
): number {
  let at = 0;
  let position = 0;
  let lastMatch = -1;
  let lastLiterals = 0;
  const length = (base: number): number => {
    let value = base;
    if (base === 15) {
      let extra = 255;
      while (extra === 255) {
        if (at === input.length) invalid("LZ4 extended length is truncated.");
        extra = input[at++]!;
        if (extra > maximum - value) invalid("LZ4 length exceeds block maximum.");
        value += extra;
      }
    }
    return value;
  };
  while (at < input.length) {
    const token = input[at++]!;
    const literals = length(token >>> 4);
    if (literals > input.length - at || literals > maximum - position) invalid("LZ4 literal extent exceeds block.");
    if (output) output.set(input.subarray(at, at + literals), position);
    at += literals;
    position += literals;
    lastLiterals = literals;
    if (at === input.length) break;
    if (input.length - at < 2) invalid("LZ4 match offset is truncated.");
    const offset = input[at]! | input[at + 1]! << 8;
    at += 2;
    if (!offset || offset > history + position) invalid("LZ4 match offset exceeds available history.");
    const match = length(token & 15) + 4;
    if (match > maximum - position) invalid("LZ4 match exceeds block maximum.");
    lastMatch = position;
    if (output) {
      for (let index = 0; index < match; index++) {
        const from = position + index - offset;
        output[position + index] = from < 0 ? previous![history + from]! : output[from]!;
      }
    }
    position += match;
    if (at === input.length) invalid("LZ4 block ends with a match rather than a literal sequence.");
  }
  if (!input.length || (lastMatch >= 0 && (lastLiterals < 5 || position - lastMatch < 12))) {
    invalid("LZ4 block violates terminal literal/match constraints.");
  }
  return position;
}
function measureBlock(input: Uint8Array, history: number, maximum: number): number {
  return sequences(input, history, maximum);
}
function decodeBlock(input: Uint8Array, history: Uint8Array, length: number): Uint8Array {
  const output = new Uint8Array(length);
  sequences(input, history.length, length, output, history);
  return output;
}

const P1 = 0x9e3779b1, P2 = 0x85ebca77, P3 = 0xc2b2ae3d, P4 = 0x27d4eb2f, P5 = 0x165667b1;
const rotate = (value: number, bits: number): number => value << bits | value >>> (32 - bits);
const round = (value: number, lane: number): number => Math.imul(rotate((value + Math.imul(lane, P2)) | 0, 13), P1);
const lane = (bytes: Uint8Array, at: number): number =>
  bytes[at]! | bytes[at + 1]! << 8 | bytes[at + 2]! << 16 | bytes[at + 3]! << 24;

/** Pure incremental XXH32, seed zero; sixteen-byte stripes plus a bounded tail. Integer products wrap modulo 2^32. */
class XxHash32 {
  #first = (P1 + P2) | 0;
  #second = P2;
  #third = 0;
  #fourth = -P1;
  #total = 0;
  #tail = new Uint8Array(16);
  #length = 0;
  #stripe(bytes: Uint8Array, at: number): void {
    this.#first = round(this.#first, lane(bytes, at));
    this.#second = round(this.#second, lane(bytes, at + 4));
    this.#third = round(this.#third, lane(bytes, at + 8));
    this.#fourth = round(this.#fourth, lane(bytes, at + 12));
  }
  update(bytes: Uint8Array): void {
    this.#total += bytes.length;
    let at = 0;
    if (this.#length) {
      const take = Math.min(16 - this.#length, bytes.length);
      this.#tail.set(bytes.subarray(0, take), this.#length);
      this.#length += take;
      at += take;
      if (this.#length === 16) {
        this.#stripe(this.#tail, 0);
        this.#length = 0;
      }
    }
    while (at <= bytes.length - 16) {
      this.#stripe(bytes, at);
      at += 16;
    }
    if (at < bytes.length) {
      this.#tail.set(bytes.subarray(at));
      this.#length = bytes.length - at;
    }
  }
  digest(): number {
    let hash = this.#total >= 16
      ? rotate(this.#first, 1) + rotate(this.#second, 7) + rotate(this.#third, 12) + rotate(this.#fourth, 18)
      : P5;
    hash = (hash + this.#total) | 0;
    let at = 0;
    for (; at <= this.#length - 4; at += 4) {
      hash = Math.imul(rotate((hash + Math.imul(lane(this.#tail, at), P3)) | 0, 17), P4);
    }
    for (; at < this.#length; at++) hash = Math.imul(rotate((hash + Math.imul(this.#tail[at]!, P5)) | 0, 11), P1);
    hash ^= hash >>> 15;
    hash = Math.imul(hash, P2);
    hash ^= hash >>> 13;
    hash = Math.imul(hash, P3);
    hash ^= hash >>> 16;
    return hash >>> 0;
  }
}
function hash32(bytes: Uint8Array): number {
  const hash = new XxHash32();
  hash.update(bytes);
  return hash.digest();
}
