import { LimitedBytesTransformStream } from "@std/streams/limited-bytes-transform-stream";
import { toBytes as readStreamBytes } from "@std/streams/to-bytes";

import { FileSystemError, throwIfAborted } from "./error.ts";

/** Write input accepted by the high-level filesystem facade. */
export type WriteDataType =
  | string
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** Shared UTF-8 encoder; TextEncoder has no mutable per-call state. */
const textEncoder = new TextEncoder();

/** Returns true when a write value is a Web ReadableStream. */
export function isReadableStream(data: WriteDataType): data is ReadableStream<Uint8Array> {
  return typeof data === "object" && data !== null && typeof Reflect.get(data, "getReader") === "function";
}

/** Returns true when a write value exposes an async iterator. */
export function isAsyncIterable(data: WriteDataType): data is AsyncIterable<Uint8Array> {
  return typeof data === "object" && data !== null && typeof Reflect.get(data, Symbol.asyncIterator) === "function";
}

/** Converts materialized write input into bytes without changing its content. */
export async function toBytes(
  data: Exclude<WriteDataType, ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>,
): Promise<Uint8Array> {
  if (typeof data === "string") return textEncoder.encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Underlying source that exposes one async iterable as a Web byte stream. */
class AsyncIterableByteSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Iterator whose lifetime follows the returned Web stream. */
  readonly #iterator: AsyncIterator<Uint8Array>;

  /** Acquires exactly one iterator from the caller-supplied iterable. */
  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Pulls one item and closes the Web stream when the iterable reaches EOF. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    const next = await this.#iterator.next();
    if (next.done) controller.close();
    else controller.enqueue(next.value);
  }

  /** Propagates consumer cancellation to an iterable that supports `return()`. */
  async cancel(): Promise<void> {
    await this.#iterator.return?.();
  }
}

/** Underlying source that materializes one non-stream write value exactly once. */
class MaterializedByteSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Caller value converted only when the stream starts. */
  readonly #data: Exclude<WriteDataType, ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>;

  /** Retains the caller value without copying it before stream consumption. */
  constructor(data: Exclude<WriteDataType, ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>) {
    this.#data = data;
  }

  /** Converts the value, emits one chunk, and closes the stream. */
  async start(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    controller.enqueue(await toBytes(this.#data));
    controller.close();
  }
}

/** Converts any supported write value into a Web byte stream without eager copying. */
export function toByteStream(data: WriteDataType): ReadableStream<Uint8Array> {
  if (isReadableStream(data)) return data;
  if (isAsyncIterable(data)) return new ReadableStream(new AsyncIterableByteSource(data));
  return new ReadableStream(new MaterializedByteSource(data));
}

/**
 * Materializes a stream with an explicit memory limit.
 *
 * Record/database adapters need complete values because their public contracts
 * are value-oriented. The limit prevents a large browser stream from silently
 * becoming an unbounded heap allocation when the selected adapter cannot stream.
 */
export async function collectBytes(
  source: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal | undefined,
  operation: string,
  path: string,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Buffered byte limit must be a non-negative safe integer.");
  }

  const abortable = withAbortSignal(source, signal, path, operation);
  const limited = abortable.pipeThrough(new LimitedBytesTransformStream(limit, { error: true }));

  try {
    return await readStreamBytes(limited);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new FileSystemError(
      "too-large",
      operation,
      path,
      [
        `${operation} for '${path}' requires more than ${limit} buffered bytes.`,
        "Select a streaming adapter or raise maxBufferedWriteBytes.",
      ].join(" "),
      error,
    );
  }
}

/**
 * Underlying source that binds one open byte reader to an AbortSignal.
 *
 * The class owns only the reader lock. It does not own the original stream.
 * Terminal close, consumer cancellation, producer failure, and signal abort all
 * pass through {@link close} so the reader is canceled at most once and its
 * lock is always released.
 */
class AbortByteSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Reader lock acquired from the caller's stream. */
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  /** Signal that can end the already-open stream. */
  readonly #signal: AbortSignal;
  /** Filesystem operation name retained for normalized cancellation errors. */
  readonly #operation: string;
  /** Canonical path retained for normalized cancellation errors. */
  readonly #path: string;
  /** Controller becomes available when the wrapper stream starts. */
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  /** Prevents duplicate reader cancellation and duplicate lock release. */
  #closed = false;

  /** Acquires the source reader immediately so no second consumer can race it. */
  constructor(source: ReadableStream<Uint8Array>, signal: AbortSignal, operation: string, path: string) {
    this.#reader = source.getReader();
    this.#signal = signal;
    this.#operation = operation;
    this.#path = path;
  }

  /** Registers cancellation before the wrapper begins pulling source bytes. */
  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#controller = controller;
    this.#signal.addEventListener("abort", this.#abort, { once: true });
    if (this.#signal.aborted) this.#abort();
  }

  /** Reads one source chunk and releases the reader as soon as EOF is observed. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    throwIfAborted(this.#signal, this.#operation, this.#path);
    try {
      const next = await this.#reader.read();
      if (next.done) {
        controller.close();
        await this.close();
      } else {
        controller.enqueue(next.value);
      }
    } catch (error) {
      controller.error(error);
      await this.close(error);
    }
  }

  /** Propagates consumer cancellation to the source producer. */
  async cancel(reason: unknown): Promise<void> {
    await this.close(reason);
  }

  /**
   * Cancels the source reader once and releases its lock.
   *
   * `ReadableStreamDefaultReader.cancel()` is awaited so a native producer can
   * finish its cancellation work before the wrapper reports cleanup complete.
   */
  async close(reason?: unknown): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#signal.removeEventListener("abort", this.#abort);
    try {
      await this.#reader.cancel(reason);
    } finally {
      this.#reader.releaseLock();
    }
  }

  /** Converts an AbortSignal into the package's stable filesystem failure. */
  readonly #abort = (): void => {
    const error = new FileSystemError(
      "aborted",
      this.#operation,
      this.#path,
      `${this.#operation} was aborted for '${this.#path}'.`,
      this.#signal.reason,
    );
    this.#controller?.error(error);
    void this.close(error);
  };
}

/**
 * Wraps a stream so an AbortSignal cancels an already-open producer.
 *
 * Opening a stream and then aborting before its next pull must release the
 * underlying reader. Otherwise native file descriptors and browser resources
 * can remain alive until garbage collection.
 */
export function withAbortSignal(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  path: string,
  operation = "read",
): ReadableStream<Uint8Array> {
  if (signal === undefined) return source;
  return new ReadableStream(new AbortByteSource(source, signal, operation, path));
}
