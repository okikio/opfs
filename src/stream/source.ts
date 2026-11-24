/**
 * Byte stream sources for write input.
 *
 * `toByteStream` turns any write input into a Web byte stream, and `collectBytes`
 * reads a stream into one bounded buffer. The underlying sources here own the
 * iterator or buffer they wrap and retire it once.
 *
 * @module
 */
import { withAbortSignal } from "./abort.ts";
import { isAsyncIterable, isReadableStream, toBytes, type WriteDataType } from "./input.ts";
import { openBytes, type OutcomeType, settle } from "./reader.ts";
import { FileSystemError } from "../error.ts";
import { close } from "../close.ts";
import { isBytes, toView } from "../bytes.ts";

/** Underlying source that exposes one async iterable as a Web byte stream. */
export class AsyncIterableByteSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Iterator whose lifetime follows the returned Web stream. */
  readonly #iterator: AsyncIterator<Uint8Array>;
  /** One return event shared by cancellation and a failed conversion. */
  #retirement: Promise<OutcomeType<void>> | undefined;
  /** Consumer cancellation prevents a late next result from publishing bytes. */
  #cancelled = false;
  /** Reserved before next lookup; includes borrowed result effects but never the active pull's cleanup wait. */
  #pending: Promise<OutcomeType<IteratorResult<Uint8Array>>> | undefined;

  /** Acquires exactly one iterator from the caller-supplied iterable. */
  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Pulls one item and closes the Web stream when the iterable reaches EOF. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let next: IteratorResult<Uint8Array>;
    try {
      const reading = Promise.withResolvers<IteratorResult<Uint8Array>>();
      this.#pending = settle(reading.promise);
      void this.#read().then(reading.resolve, reading.reject);
      const pending = await this.#pending;
      if (!pending.ok) throw pending.reason;
      next = pending.value;
      if (this.#cancelled) return;
      if (next.done) {
        controller.close();
        return;
      }
      if (!isBytes(next.value)) throw new TypeError("A byte iterable must yield Uint8Array chunks.");
      controller.enqueue(toView(next.value));
    } catch (reason) {
      if (this.#cancelled) return;
      const retired = await this.#retire([reason], true);
      if (!this.#cancelled && !retired.ok) controller.error(retired.reason);
    }
  }

  /**
   * Snapshots one fallible iterator result while cancellation owns every admitted effect.
   *
   * Reservation happens in pull before lookup, so a next/done/value getter can
   * reenter cancellation without escaping its retirement ledger. Checkpoints
   * prevent a terminal winner from starting another borrowed effect. EOF does
   * not require reading value. Retirement joins this transaction, not the pull
   * which is itself awaiting that same retirement.
   */
  async #read(): Promise<IteratorResult<Uint8Array>> {
    const next = this.#iterator.next;
    if (this.#cancelled) return { done: true, value: undefined };
    const result: IteratorResult<Uint8Array> = await Reflect.apply(next, this.#iterator, []);
    if (this.#cancelled) return { done: true, value: undefined };
    const done = result.done;
    if (this.#cancelled || done) return { done: true, value: undefined };
    const value = result.value;
    if (this.#cancelled) return { done: true, value: undefined };
    return { done: false, value };
  }

  /** Propagates consumer cancellation to an iterable that supports `return()`. */
  async cancel(): Promise<void> {
    this.#cancelled = true;
    const retired = await this.#retire();
    if (!retired.ok) throw retired.reason;
  }

  /** An arbitrary pending iterator next/return has no invented interruption capability. */
  #retire(primary: readonly unknown[] = [], readObserved = false): Promise<OutcomeType<void>> {
    return this.#retirement ??= settle(
      Promise.resolve().then(() =>
        close([
          () => this.#iterator.return?.(),
          async () => {
            if (!readObserved && this.#pending !== undefined) {
              const pending = await this.#pending;
              if (!pending.ok) throw pending.reason;
            }
          },
        ], primary)
      ),
    );
  }
}

/** Underlying source that materializes one non-stream write value exactly once. */
export class MaterializedByteSource implements UnderlyingDefaultSource<Uint8Array> {
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
  if (isAsyncIterable(data)) return new ReadableStream(new AsyncIterableByteSource(data), { highWaterMark: 0 });
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
  const reader = openBytes(abortable);
  const chunks: Uint8Array[] = [];
  let size = 0;
  let terminal = false;
  let primary: readonly unknown[] = [];
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (reason) {
        terminal = true;
        throw reason;
      }
      if (next.done) {
        terminal = true;
        break;
      }
      if (!isBytes(next.value)) throw new TypeError("A byte stream must yield Uint8Array chunks.");
      const chunk = toView(next.value);
      if (chunk.byteLength > limit - size) {
        throw new FileSystemError(
          "too-large",
          operation,
          path,
          `${operation} for '${path}' requires more than ${limit} buffered bytes. ` +
            "Select a streaming adapter or raise maxBufferedWriteBytes.",
        );
      }
      size += chunk.byteLength;
      if (chunk.byteLength !== 0) chunks.push(chunk);
    }
  } catch (reason) {
    primary = [reason];
  }
  // Native EOF/read rejection is terminal proof. A limit or conversion failure
  // instead owns cancellation, including all cleanup faults before rejection.
  await close([
    ...(!terminal ? [() => reader.cancel(primary[0])] : []),
    () => reader.releaseLock(),
  ], primary);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
