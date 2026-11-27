/**
 * Cancellation and retirement for byte streams.
 *
 * `withAbortSignal` wraps a stream so an abort signal cancels it with a
 * `FileSystemError`. `retire` cancels a stream once and reports each fault once.
 * `observeBytes` hands each chunk to a callback as it passes, which the facade
 * uses for its byte counters.
 *
 * @module
 */
import {
  type ByteReaderType,
  isNativeMethod,
  nativePromise,
  nativeThen,
  openBytes,
  type OutcomeType,
  owners,
  reads,
  settle,
} from "./reader.ts";
import { FileSystemError } from "../error.ts";
import { close } from "../close.ts";
import { isBytes, toView } from "../bytes.ts";

/**
 * Owns one byte reader through terminal consumption or awaited cancellation.
 *
 * Native closed settlement proves terminal state; a borrowed read rejection
 * alone cannot. Signal abort and consumer cancellation join one physical retirement.
 * A pending pull cannot publish cancel-induced EOF or late bytes while retiring.
 * Read/cancel/release observations remain unless exact receipts prove correlation.
 */
export class AbortByteSource implements UnderlyingDefaultSource<Uint8Array> {
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
      const declared = isNativeMethod(closed, "then", nativeThen, nativePromise);
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
    const receipt = { outcome: settle(pending.promise), observed: false };
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
      this.#pending = settle(this.#reader.read()).then((result) => {
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
    this.#retirement = settle(
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

/** Constructs an import-safe byte owner and retains only its exact stream capability. */
export function owned(
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
