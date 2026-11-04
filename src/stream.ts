import { FileSystemError } from "./error.ts";
import { close } from "./close.ts";
import { isBytes, toView } from "./bytes.ts";

/** Exact native acquisition binds the returned reader to this precise source. */
const nativeGetReader = ReadableStream.prototype.getReader;

/** Captured local native prototype limits proof to lookup paths without borrowed intermediaries. */
const nativeReader = ReadableStreamDefaultReader.prototype;
/** Exact local native read identity grants stored source-event correlation only. */
const nativeRead = nativeReader.read;
/** Exact local native cancellation identity proves delivery of a stored source rejection. */
const nativeCancel = nativeReader.cancel;

/** Captured local native settlement method; borrowed then methods remain invoked. */
const nativePromise = Promise.prototype;
const nativeThen = nativePromise.then;
/** Captured native closed accessor proves state only on a successfully branded receiver. */
const nativeClosed = Object.getOwnPropertyDescriptor(nativeReader, "closed")?.get;

/**
 * Snapshots native accessor provenance without traversing a borrowed prototype chain.
 * A Proxy intermediary can advertise a native descriptor but execute another get
 * effect. Its declared access remains usable, but cannot certify native state.
 */
function accessor(value: object, name: PropertyKey): (() => unknown) | undefined {
  const own = Object.getOwnPropertyDescriptor(value, name);
  if (own !== undefined) return own.get;
  const prototype = Object.getPrototypeOf(value);
  return prototype === nativeReader ? Object.getOwnPropertyDescriptor(prototype, name)?.get : undefined;
}

/**
 * Captures a local native data method before declared access can run a borrowed getter.
 *
 * Native invocation remains separate from this proof. An accessor can release its
 * receiver, delete itself and return a native method, so later descriptor lookup
 * cannot certify a stored source event. Unknown prototype chains stay usable
 * without correlation. A branded receiver is established by native acquisition
 * for private delivery, and by the independent closed receipt for closed/read.
 */
function dataMethod(reader: object, name: PropertyKey, method: object, expected: object = nativeReader): boolean {
  const own = Object.getOwnPropertyDescriptor(reader, name);
  if (own !== undefined) return Object.hasOwn(own, "value") && own.value === method;
  const prototype = Object.getPrototypeOf(reader);
  if (prototype !== expected) return false;
  const inherited = Object.getOwnPropertyDescriptor(prototype, name);
  return inherited !== undefined && Object.hasOwn(inherited, "value") && inherited.value === method;
}

/** Private read rejection, acquisition binding and native closed-access provenance. */
const reads = new WeakMap<ByteReaderType, {
  native: boolean;
  readonly bound: boolean;
  eligible: boolean;
  closed: { readonly promise: Promise<void>; readonly native: boolean } | undefined;
}>();

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
      this.#pending = outcome(reading.promise);
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
 * Native closed settlement proves terminal state; a borrowed read rejection
 * alone cannot. Signal abort and consumer cancellation join one physical retirement.
 * A pending pull cannot publish cancel-induced EOF or late bytes while retiring.
 * Read/cancel/release observations remain unless exact receipts prove correlation.
 */
class AbortByteSource implements UnderlyingDefaultSource<Uint8Array> {
  /** Reader acquired once; an already borrowed source lock is never stolen. */
  readonly #reader: ByteReaderType;
  /** Exact upstream capability; only first-party owned stream identities can join this chain. */
  readonly #upstream: AbortByteSource | undefined;
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
  /** Native closed settlement, rather than a borrowed read rejection or locked flag. */
  #sourceTerminal = false;
  /** Actual exact-native read rejection and native closed can observe one stored source event. */
  #readNative = false;
  /** Native or conservative borrowed closed rejection retains its provenance. */
  #closedFailure: { readonly reason: unknown; readonly native: boolean } | undefined;
  /** Returned observer work is joined after physical release, including release-dependent work. */
  #registration: { readonly outcome: Promise<OutcomeType<unknown>>; observed: boolean } | undefined;
  /** Reader release can reject closed; that rejection is not producer failure. */
  #released = false;
  /** Listener rollback is owed even when a borrowed add method installs then throws. */
  #listening = false;
  /** A setup fault after reentrant abort remains an independent event. */
  #setupFailure: { readonly reason: unknown } | undefined;
  /** An observer which reenters retirement then throws still owns this later fault. */
  #effectFailure: { readonly reason: unknown } | undefined;
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
    this.#upstream = owners.get(source);
    this.#signal = signal;
    this.#operation = operation;
    this.#path = path;
    this.#observe = observe;
  }

  /**
   * Proves that this live first-party reader chain already owns this exact signal.
   *
   * Observation owners preserve a source-bound chain without another abort actor.
   * Borrowed acquisition can select another reader, so it stops inherited proof.
   * A retiring owner breaks coverage, even when an upstream listener is still
   * present while cancellation joins. Neither reason equality nor stream shape
   * grants coverage. Iteration avoids recursive stack growth for deep chains.
   */
  coversSignal(signal: AbortSignal): boolean {
    if (this.#retirement !== undefined || this.#released) return false;
    if (this.#signal === signal) return true;
    if (!reads.get(this.#reader)?.bound) return false;
    let owner = this.#upstream;
    while (owner !== undefined) {
      if (owner.#retirement !== undefined || owner.#released) return false;
      if (owner.#signal === signal) return true;
      if (!reads.get(owner.#reader)?.bound) return false;
      owner = owner.#upstream;
    }
    return false;
  }

  /** Detects a claimed terminal actor before another observation layer publishes. */
  #stopping(): boolean {
    if (this.#retirement !== undefined) return true;
    if (!reads.get(this.#reader)?.bound) return false;
    let owner = this.#upstream;
    while (owner !== undefined) {
      if (owner.#retirement !== undefined) return true;
      if (!reads.get(owner.#reader)?.bound) return false;
      owner = owner.#upstream;
    }
    return false;
  }

  /** Registers abort before any source pull, including an already aborted signal. */
  async start(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    this.#controller = controller;
    try {
      // The lazy acquired-reader capability puts closed getter/then effects
      // inside this owner's rollback transaction, before a source pull.
      const closed = this.#reader.closed;
      const acquired = reads.get(this.#reader);
      const declared = dataMethod(closed, "then", nativeThen, nativePromise);
      if (!declared && acquired !== undefined) acquired.eligible = false;
      const then = closed.then;
      const receipt = acquired?.closed;
      const native = declared && receipt !== undefined && receipt.promise === closed && receipt.native &&
        acquired?.eligible === true && then === nativeThen;
      const operation: unknown = Reflect.apply(then, closed, [
        () => {
          if (!this.#released && native && acquired?.eligible === true) this.#sourceTerminal = true;
        },
        (reason: unknown) => {
          const proven = native && acquired?.eligible === true;
          if (!this.#released || !proven) {
            if (proven) this.#sourceTerminal = true;
            this.#closedFailure = { reason, native: proven };
          }
        },
      ]);
      this.#register(operation);
      if (this.#signal !== undefined) {
        this.#listening = true;
        this.#signal.addEventListener("abort", this.#abort, { once: true });
        if (this.#signal.aborted) this.#abort();
      }
    } catch (reason) {
      // A borrowed setup effect can synchronously abort and then throw. Keep
      // that second event without manufacturing another abort observation.
      if (this.#retirement !== undefined) {
        this.#setupFailure = { reason };
        await this.#completion;
      } else await this.#end([reason]);
    }
  }

  /** Admits actual PromiseLike observer work without inventing authority from its return value. */
  #register(operation: unknown): void {
    if ((typeof operation !== "object" || operation === null) && typeof operation !== "function") return;
    const then: unknown = Reflect.get(operation, "then");
    if (typeof then !== "function") return;
    const pending = Promise.withResolvers<unknown>();
    const receipt = { outcome: outcome(pending.promise), observed: false };
    this.#registration = receipt;
    void receipt.outcome.then((result) => {
      if (!result.ok && this.#retirement === undefined) {
        receipt.observed = true;
        void this.#end([result.reason]);
      }
    });
    let settled = false;
    try {
      Reflect.apply(then, operation, [
        (value: unknown) => {
          if (settled) return;
          settled = true;
          pending.resolve(value);
        },
        (reason: unknown) => {
          if (settled) return;
          settled = true;
          pending.reject(reason);
        },
      ]);
    } catch (reason) {
      if (!settled) {
        // The same subscription refusal also reaches start's setup catch.
        // A rejection callback followed by a throw instead owns two events.
        settled = true;
        receipt.observed = true;
        pending.reject(reason);
      }
      throw reason;
    }
  }

  /** Admits actual byte chunks and waits for retirement before EOF or rejection. */
  async pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    if (this.#stopping()) {
      await this.#end([]);
      return;
    }
    let next: OutcomeType<ReadableStreamReadResult<Uint8Array>>;
    try {
      this.#pending = outcome(this.#reader.read()).then((result) => {
        this.#readNative = reads.get(this.#reader)?.native ?? false;
        return result;
      });
      next = await this.#pending;
    } catch (reason) {
      await this.#end([reason], true);
      return;
    }
    if (this.#stopping()) {
      await this.#end([]);
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
    let chunk: Uint8Array;
    try {
      const value = next.value.value;
      if (!isBytes(value)) throw new TypeError("A byte stream must yield Uint8Array chunks.");
      chunk = toView(value);
      this.#observe?.(chunk);
    } catch (reason) {
      // Synchronous effects finish before deferred retirement actions run.
      // The cached owner consumes a later fault rather than discarding it or
      // awaiting pull completion while pull itself awaits retirement.
      if (this.#stopping()) {
        this.#effectFailure = { reason };
        await this.#end([], true);
      } else await this.#end([reason], true);
      return;
    }
    // An observer may stop this owner or an exactly bound upstream owner.
    // Neither terminal actor permits this later chunk to publish.
    if (this.#stopping()) {
      await this.#end([], true);
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
    // Join the immediate source-bound owner when its chain has a terminal
    // actor. Joining only the deepest owner would leave intermediate locks held.
    const bound = reads.get(this.#reader)?.bound ?? false;
    const upstream = bound && this.#upstream !== undefined && this.#upstream.#stopping() ? this.#upstream : undefined;
    // Defer effects until the cached outcome exists, including reentrant setup
    // and synchronous observers. Never await this owner's active pull here.
    this.#retirement = outcome(
      Promise.resolve().then(async () => {
        let joined: OutcomeType<void> | undefined;
        if (upstream !== undefined) {
          void upstream.#end([], false, reason);
          joined = await upstream.#retire([], false, reason);
          if (upstream.#completion !== undefined) await upstream.#completion;
        }
        // A bound exact-native rejected read of an actual owner publication is
        // that same owned terminal event. Unknown acquisition/read methods do
        // not grant this correlation, even when their reasons are equal.
        const publication = bound && upstream !== undefined && upstream.#published;
        const readPublication = publication && this.#readNative;
        const admitted = readObserved && readPublication ? [] : primary;
        const failures = joined !== undefined && !joined.ok ? [...admitted, joined.reason] : admitted;
        await close([
          () => {
            if (!this.#listening) return;
            this.#listening = false;
            this.#signal?.removeEventListener("abort", this.#abort);
          },
          () => {
            if (this.#setupFailure !== undefined) throw this.#setupFailure.reason;
          },
          () => {
            if (this.#effectFailure !== undefined) throw this.#effectFailure.reason;
          },
          () =>
            (bound && upstream !== undefined) || this.#sourceTerminal
              ? undefined
              : this.#reader.cancel(failures.length > 0 ? failures[0] : reason),
          async () => {
            if (!readObserved && this.#pending !== undefined) {
              const pending = await this.#pending;
              if (!pending.ok && !(publication && this.#readNative)) throw pending.reason;
            }
          },
          () => {
            this.#released = true;
            this.#reader.releaseLock();
          },
          async () => {
            if (this.#registration === undefined) return;
            // A borrowed registration may need release to finish. It is not
            // the active pull, and its rejection never proves producer EOF.
            const registered = await this.#registration.outcome;
            if (!registered.ok && !this.#registration.observed) throw registered.reason;
          },
          async () => {
            if (this.#closedFailure === undefined || (publication && this.#closedFailure.native)) return;
            const pending = this.#pending === undefined ? undefined : await this.#pending;
            // Exact-native read and closed observe one acquired-reader event.
            // This local correlation does not prove a borrowed reader belongs
            // to the declared source or to its private publication.
            if (pending !== undefined && !pending.ok && this.#readNative && this.#closedFailure.native) return;
            throw this.#closedFailure.reason;
          },
        ], failures);
      }),
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
  /** Declared reader terminal observation; native authority requires a separate private receipt. */
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
 * The borrowed read/cancel methods remain authoritative for invocation. Only an
 * actual exact-native operation rejection grants stored-event delivery authority;
 * successful read-result field effects do not. Private source delivery also
 * requires the exact native getReader method invoked on this source. Borrowed
 * acquisition can select another reader and grants no original-source authority.
 * Foreign and replaced methods keep uncertain correlations as separate observations. Fields are snapshotted once
 * inside the pending read, so an acquired owner's retirement also owns their faults.
 */
export function openBytes(source: ReadableStream<Uint8Array>): ByteReaderType {
  const acquire = source.getReader;
  const reader = Reflect.apply(acquire, source, []) as ReadableStreamDefaultReader<Uint8Array>;
  const owner = owners.get(source);
  const receipt: {
    native: boolean;
    readonly bound: boolean;
    eligible: boolean;
    closed: { readonly promise: Promise<void>; readonly native: boolean } | undefined;
  } = { native: false, bound: acquire === nativeGetReader, eligible: true, closed: undefined };
  let released = false;
  const bytes: ByteReaderType = {
    get closed() {
      receipt.closed = undefined;
      // Snapshot provenance before a borrowed accessor can delete or replace
      // itself. Reflection and declared access both belong to start's rollback.
      const getter = accessor(reader, "closed");
      if (getter !== nativeClosed || nativeClosed === undefined) receipt.eligible = false;
      const declared = reader.closed;
      let native = false;
      if (nativeClosed !== undefined && getter === nativeClosed) {
        try {
          // This branded identity probe does not substitute another promise or
          // bypass the caller's access. A valid borrowed capability needs no proof.
          const state: unknown = Reflect.apply(nativeClosed, reader, []);
          // Some native getters return a rejected Promise for an incompatible
          // receiver rather than throwing. Observe this pure probe immediately
          // through the captured intrinsic, without another declared then lookup.
          // A nonidentical result is not the caller's closed/source event.
          Reflect.apply(nativeThen, state, [() => {}, () => {}]);
          native = state === declared;
        } catch { /* Native state authority is unavailable on this receiver. */ }
      }
      if (!native) receipt.eligible = false;
      receipt.closed = { promise: declared, native: native && receipt.eligible };
      return declared;
    },
    async read(): Promise<ReadableStreamReadResult<Uint8Array>> {
      let native = false;
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        receipt.native = false;
        const declared = dataMethod(reader, "read", nativeRead);
        if (!declared) receipt.eligible = false;
        const read = reader.read;
        native = receipt.eligible && declared && read === nativeRead;
        if (read !== nativeRead) receipt.eligible = false;
        next = await Reflect.apply(read, reader, []);
      } catch (reason) {
        receipt.native = native;
        if (!released && receipt.bound && native) owner?.delivered();
        throw reason;
      }
      // Borrowed result getters are part of the pending read transaction.
      // Their fault is not an actual native operation rejection, and their
      // effects cannot escape again through a later field access in pull.
      const done = next.done;
      return done ? { done: true, value: next.value } : { done: false, value: next.value };
    },
    async cancel(reason) {
      let native = false;
      try {
        const declared = dataMethod(reader, "cancel", nativeCancel);
        if (!declared) receipt.eligible = false;
        const cancel = reader.cancel;
        native = receipt.eligible && declared && cancel === nativeCancel;
        if (cancel !== nativeCancel) receipt.eligible = false;
        await Reflect.apply(cancel, reader, [reason]);
      } catch (failure) {
        if (!released && receipt.bound && native) owner?.delivered();
        throw failure;
      }
    },
    releaseLock() {
      released = true;
      reader.releaseLock();
    },
  };
  reads.set(bytes, receipt);
  return bytes;
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
 * can remain alive until garbage collection. A live first-party wrapper chain
 * that already owns this exact signal is reused, including byte observers. This
 * keeps one signal event from becoming two synthetic filesystem failures when
 * facade, adapter and driver compose. Different signals retain separate owners;
 * a completed or retiring chain does not grant new cancellation coverage.
 */
export function withAbortSignal(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  path: string,
  operation = "read",
): ReadableStream<Uint8Array> {
  if (signal !== undefined && owners.get(source)?.coversSignal(signal)) return source;
  return owned(source, signal, path, operation);
}
