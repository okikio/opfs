import { concat } from "@std/bytes/concat";

import { isBytes, toView } from "./bytes.ts";
import { aggregate, close } from "./close.ts";
import { openBytes } from "./stream.ts";
import type { ByteReaderType } from "./stream.ts";

/** One owned producer read, including a rejection whose reason is undefined. */
type ReadType =
  | { readonly ok: true; readonly value: ReadableStreamReadResult<Uint8Array> }
  | { readonly ok: false; readonly reason: unknown };

/** An input owner can interrupt its pending acquisition without aborting uploads. */
export interface ChunkSourceType extends AsyncIterableIterator<Uint8Array> {
  /** Adjudicates this input's single acquired-reader retirement. */
  return(): Promise<IteratorResult<Uint8Array>>;
  /** Stops/joins input reads; return() reports the single retirement outcome. */
  interrupt(): Promise<void>;
}

/**
 * Owns one native byte reader, bounded pieces, and its actual terminal evidence.
 *
 * Interrupting this input acts directly on the reader, rather than queuing an
 * async generator return behind a pending next. It never cancels provider work.
 * EOF/read-error avoids a redundant cancel of an already-terminal source. A
 * conversion failure still retires a readable source. Cancellation and release
 * failures remain independent events, including equal-valued failures.
 */
class Chunks implements ChunkSourceType {
  readonly #reader: ByteReaderType;
  readonly #size: number;
  readonly #signal: AbortSignal | undefined;
  #pieces: Uint8Array[] = [];
  #length = 0;
  #buffer: Uint8Array | undefined;
  #offset = 0;
  #terminal = false;
  #stopped = false;
  #reading: Promise<ReadType> | undefined;
  #closing: Promise<void> | undefined;
  #abort: { readonly reason: unknown } | undefined;
  #closedFailure: { readonly reason: unknown } | undefined;
  #readFailureObserved = false;
  #releasing = false;

  /** Local admission precedes acquisition; a failed lock is never stolen. */
  constructor(source: ReadableStream<Uint8Array>, size: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("Chunk size must be a positive integer.");
    signal?.throwIfAborted();
    this.#reader = openBytes(source);
    // A native error rejects closed even before a pending read's wrapper
    // reactions finish. This is stream-state evidence, never an EOF certificate.
    void this.#reader.closed.catch((reason: unknown) => {
      if (!this.#releasing) this.#closedFailure = { reason };
    });
    this.#size = size;
    this.#signal = signal;
    signal?.addEventListener("abort", this.#onAbort, { once: true });
  }

  /** Reads only enough bytes to form one owned part; later bytes remain views. */
  async next(): Promise<IteratorResult<Uint8Array>> {
    while (true) {
      if (this.#abort !== undefined) throw this.#abort.reason;
      if (this.#stopped) return { done: true, value: undefined };
      if (this.#buffer !== undefined) {
        const count = Math.min(this.#size - this.#length, this.#buffer.byteLength - this.#offset);
        this.#pieces.push(this.#buffer.subarray(this.#offset, this.#offset + count));
        this.#length += count;
        this.#offset += count;
        if (this.#offset === this.#buffer.byteLength) {
          this.#buffer = undefined;
          this.#offset = 0;
        }
        if (this.#length === this.#size) {
          const value = concat(this.#pieces);
          this.#pieces = [];
          this.#length = 0;
          return { done: false, value };
        }
        continue;
      }
      if (this.#terminal) {
        if (this.#length > 0) {
          const value = concat(this.#pieces);
          this.#pieces = [];
          this.#length = 0;
          return { done: false, value };
        }
        return { done: true, value: undefined };
      }
      const observed: Promise<ReadType> = this.#reader.read().then(
        (value) => {
          if (value.done) this.#terminal = true;
          return { ok: true, value };
        },
        (reason: unknown) => {
          this.#terminal = true;
          this.#readFailureObserved = true;
          return { ok: false, reason };
        },
      );
      this.#reading = observed;
      const result = await observed;
      this.#reading = undefined;
      const aborted = this.#getAbort();
      if (!result.ok) {
        if (aborted !== undefined) {
          throw aggregate([result.reason, aborted.reason], "Input failure and caller cancellation were both observed.");
        }
        throw result.reason;
      }
      if (aborted !== undefined) throw aborted.reason;
      if (this.#stopped) return { done: true, value: undefined };
      if (result.value.done) continue;
      if (!isBytes(result.value.value)) throw new TypeError("An upload body chunk must be a Uint8Array.");
      this.#buffer = toView(result.value.value);
    }
  }

  /** Returning an input performs the same idempotent owned retirement. */
  async return(): Promise<IteratorResult<Uint8Array>> {
    await this.interrupt();
    await this.#closing;
    return { done: true, value: undefined };
  }

  /** Acquires no new owner when the same iterator is requested. */
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this;
  }

  /** Stops a pending native read, joins its outcome, and always attempts release. */
  interrupt(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing.catch(() => {});
    this.#stopped = true;
    this.#signal?.removeEventListener("abort", this.#onAbort);
    this.#closing = (async () => {
      // Give the immediately registered native state observer its queued turn.
      // Its actual closed rejection, not a number of microtasks, proves error.
      await Promise.resolve();
      await close([
        async () => {
          if (this.#terminal || this.#closedFailure !== undefined) return;
          try {
            await this.#reader.cancel();
          } catch (reason) {
            // Native cancel closes a readable stream before invoking underlying
            // cleanup. A rejected closed state is the stored source error;
            // fulfilled closed plus failed cancel is independent cleanup.
            if (this.#closedFailure === undefined) throw reason;
          }
        },
        async () => {
          await this.#reading;
        },
        () => {
          if (this.#closedFailure !== undefined && !this.#readFailureObserved) throw this.#closedFailure.reason;
        },
        () => {
          this.#releasing = true;
          this.#reader.releaseLock();
        },
      ]);
    })();
    // A caller-abort listener starts retirement before the consuming method can
    // await it. Keep rejection observed now; the owner later reports this exact
    // same retirement outcome once through return/interrupt.
    void this.#closing.catch(() => {});
    return this.#closing.catch(() => {});
  }

  /** Caller cancellation is an observed event, not a later signal-flag inference. */
  readonly #onAbort = (): void => {
    this.#abort = { reason: this.#signal?.reason };
    void this.interrupt();
  };

  /** A native abort listener can change this state while a read is awaited. */
  #getAbort(): { readonly reason: unknown } | undefined {
    return this.#abort;
  }
}

/** Opens an interruptible native input after local byte-size admission. */
export function open(source: ReadableStream<Uint8Array>, size: number, signal?: AbortSignal): ChunkSourceType {
  return new Chunks(source, size, signal);
}

/**
 * Splits a byte stream into owned chunks with a fixed maximum size.
 *
 * Views are retained until one output chunk is complete, then concat copies
 * each byte once into the result. The final chunk can be smaller than size.
 * Consumer return, caller cancellation, or conversion failure awaits the input
 * owner, including independent source cancellation and reader-release faults.
 * Actual EOF or read error is terminal evidence and is not cancelled again.
 *
 * @example Split arbitrary network chunks into 8 MiB upload parts.
 * ```ts
 * for await (const part of split(response.body!, 8 * 1024 * 1024)) {
 *   await uploadPart(part);
 * }
 * ```
 */
export async function* split(
  source: ReadableStream<Uint8Array>,
  size: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const chunks = open(source, size, signal);
  let primary: readonly unknown[] = [];
  try {
    while (true) {
      const result = await chunks.next();
      if (result.done) return;
      yield result.value;
    }
  } catch (reason) {
    primary = [reason];
    throw reason;
  } finally {
    await close([() => chunks.return?.()], primary);
  }
}
