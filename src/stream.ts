import { FileSystemError } from "./error.ts";
import { close } from "./close.ts";
import { isBytes, toView } from "./bytes.ts";

/** A settled event, including an actual rejection with null or undefined. */
type OutcomeType<Value> = { readonly ok: true; readonly value: Value } | {
  readonly ok: false;
  readonly reason: unknown;
};

/** Observes both outcomes immediately without using reason identity as authority. */
function outcome<Value>(pending: PromiseLike<Value>): Promise<OutcomeType<Value>> {
  return Promise.resolve(pending).then(
    (value) => ({ ok: true, value }),
    (reason: unknown) => ({ ok: false, reason }),
  );
}

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
  return toView(data);
}

/** Underlying source that exposes one async iterable as a Web byte stream. */
class AsyncIterableByteSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Iterator whose lifetime follows the returned Web stream. */
  readonly #iterator: AsyncIterator<Uint8Array>;
  /** One return event shared by cancellation and a failed conversion. */
  #retirement: Promise<OutcomeType<void>> | undefined;
  /** Consumer cancellation prevents a late next result from publishing bytes. */
  #cancelled = false;
  /** Tracks the actual next event so concurrent cancellation also drains it. */
  #pending: Promise<OutcomeType<IteratorResult<Uint8Array>>> | undefined;

  /** Acquires exactly one iterator from the caller-supplied iterable. */
  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  /** Pulls one item and closes the Web stream when the iterable reaches EOF. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    let next: IteratorResult<Uint8Array>;
    try {
      this.#pending = outcome(this.#iterator.next());
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

  /** Propagates consumer cancellation to an iterable that supports `return()`. */
  async cancel(): Promise<void> {
    this.#cancelled = true;
    const retired = await this.#retire();
    if (!retired.ok) throw retired.reason;
  }

  /** An arbitrary pending iterator next/return has no invented interruption capability. */
  #retire(primary: readonly unknown[] = [], readObserved = false): Promise<OutcomeType<void>> {
    return this.#retirement ??= outcome(
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

/**
 * Owns one byte reader through terminal consumption or awaited cancellation.
 *
 * EOF and a native read rejection are terminal proof and need no second cancel.
 * Signal abort and consumer cancellation instead join one physical retirement.
 * A pending pull cannot publish cancel-induced EOF or late bytes while retiring.
 * Every independent read/cancel/release fault is retained, even equal values.
 */
class AbortByteSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Reader acquired once; an already borrowed source lock is never stolen. */
  readonly #reader: ByteReaderType;
  /** Optional signal adds no listener when the caller supplies none. */
  readonly #signal: AbortSignal | undefined;
  /** Stable filesystem error context. */
  readonly #operation: string;
  /** Canonical path retained by a signal cancellation. */
  readonly #path: string;
  /** Controller receives a terminal result only after owned retirement. */
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  /** Actual native read outcome observed independently from cancellation. */
  #pending: Promise<OutcomeType<ReadableStreamReadResult<Uint8Array>>> | undefined;
  /** Native EOF/read failure, rather than a disturbed or merely locked flag. */
  #sourceTerminal = false;
  /** Native closed rejection is a stored source event, not another cancel fault. */
  #closedFailure: { readonly reason: unknown } | undefined;
  /** Reader release can reject closed; that rejection is not producer failure. */
  #released = false;
  /** One physical cancellation/release outcome shared by every terminal actor. */
  #retirement: Promise<OutcomeType<void>> | undefined;
  /** One outward terminal publication; it cannot race another pull's close. */
  #completion: Promise<void> | undefined;
  /** Web consumer cancellation already owns its wrapper's outward closure. */
  #cancelled = false;
  /** Optional byte observation runs before publishing each admitted chunk. */
  readonly #observe: ((chunk: Uint8Array) => void) | undefined;
  /** Terminal faults already delivered by this owner are not a second event. */
  #reported = false;
  /** Identifies an actual owner error publication before a native read rejects. */
  #published = false;
  /** Consumer cancel and explicit retirement retain their own stable promises. */
  #cancellation: Promise<void> | undefined;
  /** Joins physical retirement without repeating a published read failure. */
  #joined: Promise<void> | undefined;

  constructor(
    source: ReadableStream<Uint8Array>,
    signal: AbortSignal | undefined,
    operation: string,
    path: string,
    observe?: (chunk: Uint8Array) => void,
  ) {
    this.#reader = openBytes(source);
    this.#signal = signal;
    this.#operation = operation;
    this.#path = path;
    this.#observe = observe;
    // Observe native terminal state at acquisition, before an abort can request
    // cancellation. Read delivery can have additional Promise reactions; a
    // fixed microtask checkpoint cannot certify that stored-error distinction.
    void this.#reader.closed.then(undefined, (reason: unknown) => {
      if (!this.#released) {
        this.#sourceTerminal = true;
        this.#closedFailure = { reason };
      }
    });
  }

  /** Registers abort before any source pull, including an already aborted signal. */
  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.#controller = controller;
    this.#signal?.addEventListener("abort", this.#abort, { once: true });
    if (this.#signal?.aborted) this.#abort();
  }

  /** Admits actual byte chunks and waits for retirement before EOF or rejection. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.#retirement !== undefined) {
      await this.#completion;
      return;
    }
    let next: OutcomeType<ReadableStreamReadResult<Uint8Array>>;
    try {
      this.#pending = outcome(this.#reader.read()).then((result) => {
        if (!result.ok || result.value.done) this.#sourceTerminal = true;
        return result;
      });
      next = await this.#pending;
    } catch (reason) {
      this.#sourceTerminal = true;
      await this.#end([reason], true);
      return;
    }
    if (this.#retirement !== undefined) {
      await this.#completion;
      return;
    }
    if (!next.ok) {
      await this.#end([next.reason], true);
      return;
    }
    if (next.value.done) {
      await this.#end([], true);
      return;
    }
    if (!isBytes(next.value.value)) {
      await this.#end([new TypeError("A byte stream must yield Uint8Array chunks.")], true);
      return;
    }
    let chunk: Uint8Array;
    try {
      chunk = toView(next.value.value);
      this.#observe?.(chunk);
    } catch (reason) {
      await this.#end([reason], true);
      return;
    }
    // An observer may synchronously abort or retire this owner. Do not publish
    // its chunk after that terminal actor has acquired physical retirement.
    if (this.#retirement !== undefined) {
      await this.#completion;
      return;
    }
    controller.enqueue(chunk);
  }

  /** Consumer cancel awaits the same physical retirement as a simultaneous abort. */
  cancel(reason: unknown): Promise<void> {
    this.#cancelled = true;
    return this.#cancellation ??= this.#retire([], false, reason).then((retired) => {
      if (!retired.ok) {
        this.#reported = true;
        throw retired.reason;
      }
    });
  }

  /** Reuses exact owned retirement instead of recancelling an errored stream. */
  retire(reason?: unknown): Promise<void> {
    return this.#joined ??= (async () => {
      if (this.#retirement === undefined) this.#end([], false, reason);
      const retired = await this.#retire([], false, reason);
      if (this.#completion !== undefined) await this.#completion;
      if (this.#cancellation !== undefined) {
        try {
          await this.#cancellation;
        } catch { /* Its actual event is already reported to the cancel caller. */ }
      }
      if (!retired.ok && !this.#reported) throw retired.reason;
    })();
  }

  /** An exact acquired reader records delivery; a matching reason value does not. */
  delivered(): void {
    if (this.#published) this.#reported = true;
  }

  /** Starts one owned retirement before any producer cancellation can reenter it. */
  #retire(
    primary: readonly unknown[] = [],
    readObserved = false,
    reason?: unknown,
  ): Promise<OutcomeType<void>> {
    if (this.#retirement !== undefined) return this.#retirement;
    this.#signal?.removeEventListener("abort", this.#abort);
    // Defer native actions until the cached outcome has been published. An
    // underlying cancel callback may synchronously trigger another terminal actor.
    this.#retirement = outcome(
      Promise.resolve().then(() =>
        close([
          () => this.#sourceTerminal ? undefined : this.#reader.cancel(primary.length > 0 ? primary[0] : reason),
          async () => {
            // A read already classified by pull is one event. A pending read that
            // rejects during signal/cancel retirement is independently observed here.
            if (!readObserved && this.#pending !== undefined) {
              const pending = await this.#pending;
              if (!pending.ok) throw pending.reason;
            } else if (!readObserved && this.#closedFailure !== undefined) {
              // No read delivered this native stored source event. Keep it
              // beside acquisition/abort failure without issuing cancel again.
              throw this.#closedFailure.reason;
            }
          },
          () => {
            this.#released = true;
            this.#reader.releaseLock();
          },
        ], primary)
      ),
    );
    return this.#retirement;
  }

  /** Publishes one classified terminal outcome after physical cleanup settles. */
  #end(primary: readonly unknown[], readObserved = false, reason?: unknown): Promise<void> {
    const retirement = this.#retire(primary, readObserved, reason);
    return this.#completion ??= retirement.then((retired) => {
      if (this.#cancelled) return;
      if (retired.ok) this.#controller?.close();
      else {
        this.#published = true;
        this.#controller?.error(retired.reason);
      }
    });
  }

  /** Signal reason remains the cause of the stable aborted filesystem failure. */
  readonly #abort = (): void => {
    const error = new FileSystemError(
      "aborted",
      this.#operation,
      this.#path,
      `${this.#operation} was aborted for '${this.#path}'.`,
      this.#signal?.reason,
    );
    void this.#end([error]);
  };
}

/** Exact wrapper identity owns retirement; a structural or borrowed stream does not. */
const owners = new WeakMap<ReadableStream<Uint8Array>, AbortByteSource>();

/** Internal reader capability bound to one exact acquired stream. */
export interface ByteReaderType {
  /** Exact native terminal-state observation; fulfillment need not drain queued bytes. */
  readonly closed: Promise<void>;
  /** Reads one native chunk, observing an actual terminal rejection. */
  read(): Promise<ReadableStreamReadResult<Uint8Array>>;
  /** Requests cancellation and awaits its native retirement result. */
  cancel(reason?: unknown): Promise<void>;
  /** Releases this acquired reader's lock; it never takes a borrowed lock. */
  releaseLock(): void;
}

/**
 * Acquires one reader and observes real rejection delivery from that exact stream.
 *
 * Already-errored Web streams reject read without invoking another source pull.
 * First-party owners use this capability so retire does not report that event
 * again. A released-reader misuse cannot mark an undelivered stream fault. This
 * does not patch native stream methods or infer delivery from error identity.
 */
export function openBytes(source: ReadableStream<Uint8Array>): ByteReaderType {
  const reader = source.getReader();
  const owner = owners.get(source);
  let released = false;
  return {
    closed: reader.closed,
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      try {
        const next = await reader.read();
        // Host declarations differ on the presence of the terminal value.
        // Publish one native read-result shape without changing byte ownership.
        return next.done ? { done: true, value: next.value } : next;
      } catch (reason) {
        if (!released) owner?.delivered();
        throw reason;
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } catch (failure) {
        if (!released) owner?.delivered();
        throw failure;
      }
    },
    releaseLock() {
      released = true;
      reader.releaseLock();
    },
  };
}

/** Constructs an import-safe byte owner and retains only its exact stream capability. */
function owned(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  path: string,
  operation: string,
  observe?: (chunk: Uint8Array) => void,
): ReadableStream<Uint8Array> {
  const owner = new AbortByteSource(source, signal, operation, path, observe);
  const stream = new ReadableStream(owner, { highWaterMark: 0 });
  owners.set(stream, owner);
  return stream;
}

/**
 * Observes admitted bytes without detaching error publication from physical cleanup.
 * This internal capability is used for facade counters, not resource authority.
 */
export function observeBytes(
  source: ReadableStream<Uint8Array>,
  observe: (chunk: Uint8Array) => void,
  path: string,
  operation = "read",
): ReadableStream<Uint8Array> {
  return owned(source, undefined, path, operation, observe);
}

/**
 * Joins one exact owned byte stream's retirement after an operation failure.
 *
 * A terminal fault delivered through openBytes or consumer cancel is that operation's
 * existing event, not a second cancellation failure. An error without an
 * admitted read remains undelivered and is retained beside acquisition failure.
 * First retirement failures remain
 * observable and the joining promise is cached. An unowned stream can only be
 * cancelled when unlocked; this never takes another consumer's borrowed lock.
 */
export function retire(source: ReadableStream<Uint8Array>, reason?: unknown): Promise<void> {
  const owner = owners.get(source);
  if (owner !== undefined) return owner.retire(reason);
  if (source.locked) return Promise.reject(new TypeError("The byte stream has a borrowed reader."));
  return source.cancel(reason);
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
  return owned(source, signal, path, operation);
}
