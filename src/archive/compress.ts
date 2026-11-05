import { isBytes, toRequestBytes, toView } from "../bytes.ts";
import { close } from "../close.ts";
import { ArchiveError, crc32, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
import { createTarStream, readTarStream } from "./stream.ts";
import type {
  TarScanType,
  TarStreamOptionsType,
  TarVisitorType,
  TarWriteEntryType,
  TarWriteOptionsType,
} from "./stream.ts";

/** Native zlib framing, raw DEFLATE, or a gzip member. No automatic format sniffing or fallback codec. */
export type CompressionFormatType = "gzip" | "deflate" | "deflate-raw";

/** Finite admission at the producer, native codec and consumer boundaries. */
export interface CompressionOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  /** Maximum acquired producer chunk, before splitting it into codec input. Default 64 KiB. */
  readonly maxChunkBytes?: number;
  /** Maximum bytes submitted in one native write. Default 1024; must not exceed 64 KiB. */
  readonly inputChunkBytes?: number;
  /** Maximum native output chunk accepted after native allocation. Default 4 MiB. */
  readonly maxCodecChunkBytes?: number;
  /** Maximum output view delivered by one pull. Default 64 KiB. */
  readonly outputChunkBytes?: number;
}

/**
 * Compress one source using the runtime's native Web codec. Readers are acquired on first pull,
 * owned until EOF/cancel/failure, then retired before the terminal result. Native codec buffers
 * are opaque: byte limits bound admitted work/output, not prior native allocations or CPU time.
 */
export function compressStream(
  source: ReadableStream<Uint8Array>,
  format: CompressionFormatType,
  options: CompressionOptionsType = {},
): ReadableStream<Uint8Array> {
  return codecStream(source, format, "compress", options);
}

/**
 * Decode one native compression stream. Gzip/zlib checksums are checked only at successful EOF;
 * prefixes are unauthenticated and cancellation does not certify the footer or the remaining input.
 */
export function decompressStream(
  source: ReadableStream<Uint8Array>,
  format: CompressionFormatType,
  options: CompressionOptionsType = {},
): ReadableStream<Uint8Array> {
  return codecStream(source, format, "decompress", options);
}

/** A transform and its producer pipeline share one teardown, including concurrent abort and output cancellation. */
function codecStream(
  source: ReadableStream<Uint8Array> | (() => ReadableStream<Uint8Array>),
  format: CompressionFormatType,
  mode: "compress" | "decompress",
  options: CompressionOptionsType,
): ReadableStream<Uint8Array> {
  const ledger = createArchiveLedger(options);
  const shared = options.ledger;
  const signal = options.signal;
  const maximum = options.maxChunkBytes ?? 65536;
  const inputBytes = options.inputChunkBytes ?? 1024;
  const codecMaximum = options.maxCodecChunkBytes ?? 4 * 1024 * 1024;
  const outputBytes = options.outputChunkBytes ?? 65536;
  const frame = mode === "decompress" ? new CompressionFrame(format) : undefined;
  for (const [name, value] of Object.entries({ maximum, inputBytes, codecMaximum, outputBytes })) {
    integer(value, name);
    if (value === 0) throw new RangeError(`${name} must be positive.`);
  }
  if (inputBytes > 65536) throw new RangeError("Native codec inputChunkBytes cannot exceed 64 KiB.");
  if (format !== "gzip" && format !== "deflate" && format !== "deflate-raw") {
    unsupported("Unknown compression profile.");
  }
  signal?.throwIfAborted();
  const Codec = mode === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
  if (typeof Codec !== "function") unsupported(`Native ${mode}ion streams are unavailable.`);
  let codec: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>>;
  try {
    codec = new Codec(format);
  } catch {
    unsupported(`The native ${mode}ion codec does not support ${format}.`);
  }
  let origin: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let decoded: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let originDone = false;
  let originFailed = false;
  let codecDone = false;
  let codecFailed = false;
  let stopped = false;
  let consumerCancelled = false;
  let input: Uint8Array = new Uint8Array();
  let inputOffset = 0;
  let output: Uint8Array = new Uint8Array();
  let outputOffset = 0;
  let pumping: Promise<void> | undefined;
  let originRetirement: Promise<void> | undefined;
  let retirement: Promise<readonly unknown[]> | undefined;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let demand = false;
  let wake: (() => void) | undefined;

  const reserve = (kind: keyof ArchiveWorkType, length: number): void => {
    ledger.reserve(kind, length);
    shared?.reserve(kind, length);
  };
  /** A native source rejection is already terminal; cancelling it again would repeat that same failure. */
  const retireOrigin = (reason?: unknown): Promise<void> =>
    originRetirement ??= (async () => {
      if (!origin) return;
      try {
        if (!originDone && !originFailed) await origin.cancel(reason);
      } finally {
        origin.releaseLock();
      }
    })();
  /** Never await this pipeline from its own feeder cancel hook: pipeTo waits for that hook to settle. */
  const retire = (reason?: unknown): Promise<readonly unknown[]> =>
    retirement ??= (async () => {
      stopped = true;
      wake?.();
      wake = undefined;
      signal?.removeEventListener("abort", abort);
      const failures: unknown[] = [];
      if (decoded) {
        try {
          if (!codecDone && !codecFailed) await decoded.cancel(reason);
        } catch (error) {
          failures.push(error);
        }
      } else {
        try {
          await codec.readable.cancel(reason);
        } catch (error) {
          failures.push(error);
        }
      }
      // pipeTo has an immediate rejection observer. Its primary codec/source error is
      // delivered by decoded.read(); origin cancellation failures are retained separately.
      await pumping?.catch(() => {});
      try {
        await retireOrigin(reason);
      } catch (error) {
        failures.push(error);
      }
      try {
        decoded?.releaseLock();
      } catch (error) {
        failures.push(error);
      }
      input = new Uint8Array();
      output = new Uint8Array();
      return failures;
    })();
  const fail = async (reason: unknown): Promise<void> => {
    const cleanup = await retire(reason);
    if (!consumerCancelled) {
      try {
        await close([], [reason, ...cleanup]);
      } catch (error) {
        controller.error(error);
      }
    }
  };
  function abort(): void {
    void fail(signal?.reason);
  }

  /** Start only after output demand; one pipeTo owns native codec backpressure and all input writes. */
  const start = (): void => {
    origin = (typeof source === "function" ? source() : source).getReader();
    decoded = codec.readable.getReader();
    const feeder = new ReadableStream<Uint8Array<ArrayBuffer>>({
      async pull(feed) {
        try {
          // Native writers may finish a write before their readable queue drains.
          // Keep the next producer read behind demand for a new native output chunk.
          if (!demand && !stopped) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          if (stopped) return;
          signal?.throwIfAborted();
          while (inputOffset === input.length) {
            reserve("requests", 1);
            let next: ReadableStreamReadResult<Uint8Array>;
            try {
              next = await origin!.read();
            } catch (error) {
              originFailed = true;
              throw error;
            }
            signal?.throwIfAborted();
            if (stopped) return;
            if (next.done) {
              originDone = true;
              feed.close();
              return;
            }
            if (!isBytes(next.value)) throw new TypeError("Compression source must yield native bytes.");
            input = toView(next.value);
            inputOffset = 0;
            reserve("sourceBytes", input.length);
            if (input.length > maximum) {
              throw new ArchiveError("budget-exceeded", "Compression producer chunk limit exceeded.");
            }
            frame?.input(input);
          }
          const length = Math.min(inputBytes, input.length - inputOffset);
          if (mode === "compress") reserve("decodedBytes", length);
          const bytes = toRequestBytes(input.subarray(inputOffset, inputOffset + length));
          inputOffset += length;
          feed.enqueue(bytes);
        } catch (error) {
          feed.error(error);
        }
      },
      cancel: retireOrigin,
    }, { highWaterMark: 0 });
    pumping = feeder.pipeTo(codec.writable);
    void pumping.catch(() => {});
  };

  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal?.addEventListener("abort", abort, { once: true });
    },
    async pull(value) {
      try {
        signal?.throwIfAborted();
        if (stopped) return;
        if (!decoded) start();
        while (outputOffset === output.length) {
          let next: ReadableStreamReadResult<Uint8Array>;
          demand = true;
          wake?.();
          wake = undefined;
          try {
            next = await decoded!.read();
          } catch (error) {
            codecFailed = true;
            throw error;
          }
          demand = false;
          signal?.throwIfAborted();
          if (stopped) return;
          if (next.done) {
            codecDone = true;
            await pumping;
            frame?.finish();
            const cleanup = await retire();
            await close([], cleanup);
            value.close();
            return;
          }
          if (!isBytes(next.value)) throw new TypeError("Native codec must return native bytes.");
          output = toView(next.value);
          outputOffset = 0;
          if (mode === "decompress") reserve("decodedBytes", output.length);
          if (output.length > codecMaximum) {
            throw new ArchiveError("budget-exceeded", "Native codec output chunk limit exceeded.");
          }
          frame?.output(output);
        }
        const length = Math.min(outputBytes, output.length - outputOffset);
        reserve("outputBytes", length);
        const bytes = output.subarray(outputOffset, outputOffset + length);
        outputOffset += length;
        value.enqueue(bytes);
      } catch (error) {
        await fail(error);
      }
    },
    async cancel(reason) {
      consumerCancelled = true;
      const cleanup = await retire(reason);
      await close([], cleanup);
    },
  }, { highWaterMark: 0 });
}

/**
 * Native EOF is not enough on every engine. Keep a constant-size trailer and
 * checksum state so gzip CRC/size and zlib Adler32 are independently checked.
 * Raw DEFLATE has no trailer; native structural completion remains runtime-owned.
 */
class CompressionFrame {
  readonly #format: CompressionFormatType;
  readonly #tail: Uint8Array;
  readonly #prefix = new Uint8Array(2);
  #input = 0;
  #size = 0;
  #crc = 0xffffffff;
  #adlerA = 1;
  #adlerB = 0;

  constructor(format: CompressionFormatType) {
    this.#format = format;
    this.#tail = new Uint8Array(format === "gzip" ? 8 : format === "deflate" ? 4 : 0);
  }

  input(bytes: Uint8Array): void {
    if (this.#format === "deflate-raw") return;
    for (const byte of bytes) {
      if (this.#input < 2) this.#prefix[this.#input] = byte;
      this.#tail[this.#input % this.#tail.length] = byte;
      this.#input++;
    }
    if (this.#format === "deflate" && this.#input >= 2) {
      const cmf = this.#prefix[0]!;
      const flags = this.#prefix[1]!;
      if ((cmf & 15) !== 8 || (cmf >>> 4) > 7 || ((cmf << 8) + flags) % 31 !== 0) invalid("Invalid zlib header.");
      if (flags & 32) unsupported("Preset-dictionary zlib streams are unsupported.");
    }
  }

  output(bytes: Uint8Array): void {
    if (this.#format === "gzip") {
      this.#crc = crc32(bytes, this.#crc);
      this.#size = (this.#size + bytes.length) >>> 0;
    } else if (this.#format === "deflate") {
      // Adler32 reductions every 5552 bytes keep the exact sums within uint32.
      for (let offset = 0; offset < bytes.length; offset += 5552) {
        const end = Math.min(offset + 5552, bytes.length);
        for (let index = offset; index < end; index++) {
          this.#adlerA += bytes[index]!;
          this.#adlerB += this.#adlerA;
        }
        this.#adlerA %= 65521;
        this.#adlerB %= 65521;
      }
    }
  }

  finish(): void {
    if (this.#format === "deflate-raw") return;
    if (this.#input < (this.#format === "gzip" ? 20 : 8)) invalid("Compressed stream is shorter than its framing.");
    const ordered = new Uint8Array(this.#tail.length);
    for (let index = 0; index < ordered.length; index++) {
      ordered[index] = this.#tail[(this.#input + index) % ordered.length]!;
    }
    const view = new DataView(ordered.buffer);
    if (this.#format === "gzip") {
      if (view.getUint32(0, true) !== ((this.#crc ^ 0xffffffff) >>> 0) || view.getUint32(4, true) !== this.#size) {
        throw new ArchiveError("checksum-mismatch", "Gzip CRC32 or ISIZE differs from decoded content.");
      }
    } else if (view.getUint32(0, false) !== ((this.#adlerB << 16 | this.#adlerA) >>> 0)) {
      throw new ArchiveError("checksum-mismatch", "Zlib Adler32 differs from decoded content.");
    }
  }
}

/** Separate layer budgets keep compressed acquisition distinct from TAR parsing and selected output. */
export interface CompressedTarOptionsType {
  /** Cancels acquisition, TAR traversal and the final decoder/footer drain. Combined with layer signals. */
  readonly signal?: AbortSignal;
  readonly compression?: CompressionOptionsType;
  readonly tar?: TarStreamOptionsType;
}

/** Independent TAR production/codec policies, with one combined cancellation authority. */
export interface CompressedTarWriteOptionsType {
  /** Cancels both TAR production and compression. Combined with layer signals. */
  readonly signal?: AbortSignal;
  readonly compression?: CompressionOptionsType;
  readonly tar?: TarWriteOptionsType;
}

/** TAR traversal and compression EOF/checksum scope are separate observations. */
export interface CompressedTarReadType extends TarScanType {
  readonly compression: {
    readonly format: CompressionFormatType;
    /** Native EOF after TAR end; gzip/zlib checksums passed. Raw EOF does not independently prove DEFLATE completeness. */
    readonly complete: boolean;
    readonly integrity: "gzip-crc32" | "zlib-adler32" | "none" | "pending";
    readonly work: ArchiveWorkType;
  };
}

/** Stream TAR output directly into a native codec; no archive materialization or resumable checkpoint. */
export function createCompressedTar(
  entries: AsyncIterable<TarWriteEntryType> | Iterable<TarWriteEntryType>,
  format: CompressionFormatType,
  options: CompressedTarWriteOptionsType = {},
): ReadableStream<Uint8Array> {
  const signal = joinedSignal(options.signal, options.tar?.signal, options.compression?.signal);
  return codecStream(
    () => createTarStream(entries, { ...options.tar, ...(signal === undefined ? {} : { signal }) }),
    format,
    "compress",
    { ...options.compression, ...(signal === undefined ? {} : { signal }) },
  );
}

/**
 * Visit a compressed TAR sequentially. A complete TAR scan drains the native decoder to EOF,
 * including trailing TAR record padding, so a damaged gzip/zlib footer cannot hide after TAR end blocks.
 * Returning false cancels without this drain and reports a pending checksum.
 */
export async function readCompressedTar(
  source: ReadableStream<Uint8Array>,
  format: CompressionFormatType,
  visit: TarVisitorType,
  options: CompressedTarOptionsType = {},
): Promise<CompressedTarReadType> {
  const ledger = createArchiveLedger(options.compression);
  const signal = joinedSignal(options.signal, options.tar?.signal, options.compression?.signal);
  const shared = options.compression?.ledger;
  const accounting: ArchiveLedgerType = {
    reserve(kind, length) {
      ledger.reserve(kind, length);
      shared?.reserve(kind, length);
    },
    inspect: () => ledger.inspect(),
  };
  const output = decompressStream(source, format, {
    ...options.compression,
    ...(signal === undefined ? {} : { signal }),
    ledger: accounting,
  });
  const reader = output.getReader();
  let done = false;
  let readerFailed = false;
  let failed = false;
  let primary: unknown;
  // TAR cancels its borrowed bridge after its end marker. This owner retains the
  // decoder until the full scan drains the footer or an incomplete/error path retires it.
  const bridge = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          done = true;
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        readerFailed = true;
        controller.error(error);
      }
    },
  }, { highWaterMark: 0 });
  try {
    const result = await readTarStream(bridge, visit, { ...options.tar, ...(signal === undefined ? {} : { signal }) });
    if (result.complete) {
      while (true) {
        let next: ReadableStreamReadResult<Uint8Array>;
        try {
          next = await reader.read();
        } catch (error) {
          readerFailed = true;
          throw error;
        }
        if (next.done) {
          done = true;
          break;
        }
      }
    }
    return {
      ...result,
      compression: {
        format,
        complete: result.complete && done,
        integrity: !done
          ? "pending"
          : format === "gzip"
          ? "gzip-crc32"
          : format === "deflate"
          ? "zlib-adler32"
          : "none",
        work: ledger.inspect(),
      },
    };
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    // Preserve a delivered primary failure. A cancelled prefix has no complete
    // checksum scope, even if the producer happened to prefetch the footer.
    await close([
      async () => {
        try {
          if (!done && !readerFailed) await reader.cancel(failed ? primary : undefined);
        } finally {
          reader.releaseLock();
        }
      },
    ], failed ? [primary] : []);
  }
}

/** One cancellation authority reaches every stage, including footer work after the TAR visitor finishes. */
function joinedSignal(...values: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const signals = values.filter((value): value is AbortSignal => value !== undefined);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}
