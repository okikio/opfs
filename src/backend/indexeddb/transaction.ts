/**
 * IndexedDB request and transaction completion for the IndexedDB record driver.
 *
 * IndexedDB reports completion through events that fire once and cannot be replayed. This module turns
 * those events into awaited results while it keeps every observed failure, including failures raised while
 * listeners are removed. The driver and its browser test fixture import it directly; no public subpath
 * exports it.
 *
 * Call `waitForRequest(request)` for one request's value and `committed(transaction)` for the commit
 * boundary. A completed request does not mean its transaction committed.
 *
 * @module
 */
import { throwIfAborted } from "../../error.ts";
import { aggregate } from "../../close.ts";
import type { PathType } from "../../path.ts";

/** One observed failure occurrence; equal values do not establish a shared event. */
interface FailureType {
  readonly reason: unknown;
}

/** Private transfer of an already-recorded event across an awaited request. */
export class Refusal {
  readonly owner: Listeners;
  readonly failure: FailureType;

  constructor(owner: Listeners, failure: FailureType) {
    this.owner = owner;
    this.failure = failure;
  }
}

/**
 * Owns listener installation and removal, including partial borrowed setup.
 *
 * Reserve removal before calling addEventListener: a borrowed method can install
 * the listener and then throw. Removal is claimed before its effect, so reentry
 * cannot repeat it. Every listener is attempted even if an earlier removal fails.
 */
export class Listeners {
  readonly failures: FailureType[] = [];
  readonly #releases: Array<() => void> = [];
  readonly #work = new Set<Promise<void>>();
  #retired = false;

  note(reason: unknown): FailureType {
    const failure = { reason };
    this.failures.push(failure);
    return failure;
  }

  listen(target: EventTarget, type: string, callback: EventListener): boolean {
    this.#releases.push(() => target.removeEventListener(type, callback));
    try {
      target.addEventListener(type, callback);
      return true;
    } catch (reason) {
      this.note(reason);
      return false;
    }
  }

  /**
   * Keeps a declared on* channel when listener installation is refused.
   *
   * Both callbacks can receive the very same native Event after install-then-
   * throw. Event receipt identity correlates that delivery; error value identity
   * never does. The original attribute handler runs with its original receiver
   * and its return value is preserved, including false for event cancellation.
   */
  observe(target: EventTarget, type: string, callback: EventListener): boolean {
    const delivered = new WeakSet<Event>();
    const once = (event: Event) => {
      if (delivered.has(event)) return;
      delivered.add(event);
      callback(event);
    };
    if (this.listen(target, type, once)) return true;
    const key = `on${type}`;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(target, key);
      const previous: unknown = Reflect.get(target, key);
      this.#releases.push(() => {
        try {
          if (!Reflect.set(target, key, previous)) {
            throw new TypeError("IndexedDB event handler restoration was refused.");
          }
        } catch (reason) {
          this.note(reason);
        }
        try {
          if (descriptor) Object.defineProperty(target, key, descriptor);
          else if (!Reflect.deleteProperty(target, key)) {
            throw new TypeError("IndexedDB event descriptor restoration was refused.");
          }
        } catch (reason) {
          this.note(reason);
        }
      });
      const observer = (event: Event) => {
        let returned: unknown;
        if (typeof previous === "function") {
          try {
            returned = Reflect.apply(previous, target, [event]);
            this.#observe(returned);
          } catch (reason) {
            this.note(reason);
          }
        }
        once(event);
        return returned;
      };
      if (!Reflect.set(target, key, observer)) throw new TypeError("IndexedDB event handler installation was refused.");
      return true;
    } catch (reason) {
      this.note(reason);
      return false;
    }
  }

  /**
   * Observe explicitly returned PromiseLike work without replacing its value.
   *
   * This is package retirement ownership, not native event dispatch waiting.
   * Reserve before the borrowed then getter and invocation; a callback rejection
   * and an invocation that throws after settling are distinct occurrences.
   */
  #observe(value: unknown): void {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
    const pending = Promise.withResolvers<unknown>();
    const work = pending.promise.then(() => undefined, (reason) => {
      this.note(reason);
    });
    this.#work.add(work);
    void work.then(() => {
      this.#work.delete(work);
    });
    let settled = false;
    const resolve = (value?: unknown) => {
      if (settled) return;
      settled = true;
      // Native resolution adopts the first value, including nested PromiseLike
      // settlement. A later reject or resolve cannot replace that choice.
      pending.resolve(value);
    };
    const reject = (reason: unknown) => {
      if (settled) return;
      this.note(reason);
      resolve();
    };
    try {
      const then: unknown = Reflect.get(value, "then");
      if (typeof then === "function") Reflect.apply(then, value, [resolve, reject]);
      else resolve();
    } catch (reason) {
      this.note(reason);
      resolve();
    }
  }

  /** Join only the actual saved-handler work, after physical detach and close. */
  async join(): Promise<void> {
    while (this.#work.size > 0) await Promise.all(this.#work);
  }

  retire(): void {
    if (this.#retired) return;
    this.#retired = true;
    for (const release of this.#releases) {
      try {
        release();
      } catch (reason) {
        this.note(reason);
      }
    }
  }

  finish(): void {
    const reasons = this.failures.map((failure) => failure.reason);
    if (reasons.length === 1) throw reasons[0];
    if (reasons.length > 1) {
      throw aggregate(reasons, "IndexedDB operation and retirement failed.");
    }
  }
}

/** Physical observation admission, kept private to unpublished database rollback. */
export interface ObservationType {
  observed?: boolean;
  terminal?: Promise<void>;
  late?: () => void;
}

/**
 * Observes one request without replacing caller-owned on* handlers.
 *
 * Callbacks resolve an owned receipt instead of throwing into event dispatch.
 * A failed installation is retained even when the fallback observes completion.
 * If both channels refuse, logical failure can precede actual completion; any
 * admitted late callback remains observed through its owner's retirement.
 */
export function requested<T>(
  request: IDBRequest<T>,
  listeners: Listeners,
  acquired?: (value: T) => void,
  observation?: ObservationType,
): Promise<T> {
  const pending = Promise.withResolvers<{ value: T } | { failure: FailureType }>();
  let settled = false;
  let stateReceipt = false;
  const terminal = Promise.withResolvers<void>();
  if (observation) observation.terminal = terminal.promise;
  const settle = (read: () => T) => {
    if (settled) {
      if (!stateReceipt) {
        try {
          const value = read();
          acquired?.(value);
        } catch (reason) {
          listeners.note(reason);
        }
      }
      terminal.resolve();
      if (observation?.observed === false) observation.late?.();
      return;
    }
    settled = true;
    try {
      const value = read();
      acquired?.(value);
      pending.resolve({ value });
    } catch (reason) {
      pending.resolve({ failure: listeners.note(reason) });
    }
    terminal.resolve();
  };
  const success = listeners.observe(request, "success", () => settle(() => request.result));
  const error = listeners.observe(request, "error", () => {
    if (stateReceipt) return;
    // A setup refusal can win before native request failure. Retain that later
    // observation while the transaction is still physically retiring.
    settled = true;
    let failure: FailureType;
    try {
      failure = listeners.note(request.error ?? new Error("IndexedDB request failed."));
    } catch (reason) {
      failure = listeners.note(reason);
    }
    pending.resolve({ failure });
    terminal.resolve();
    if (observation?.observed === false) observation.late?.();
  });
  if (observation) observation.observed = success && error;
  if (!success || !error) {
    settled = true;
    pending.resolve({ failure: listeners.failures[0]! });
  }
  // This acquired request's final fields replay its terminal state after its
  // event has passed. Cache that receipt only after field admission succeeds;
  // replay of the same request state does not reread fields or add a new error.
  try {
    const state = request.readyState;
    if (!settled && state === "done") {
      const reason = request.error;
      if (reason !== null) {
        settled = true;
        stateReceipt = true;
        pending.resolve({ failure: listeners.note(reason) });
        terminal.resolve();
      } else {
        const value = request.result;
        acquired?.(value);
        stateReceipt = true;
        settled = true;
        pending.resolve({ value });
        terminal.resolve();
      }
    }
  } catch (reason) {
    // A field-admission fault is not a certified native request error. The
    // transaction/open owner still joins and observes an actual later event.
    const failure = listeners.note(reason);
    settled = true;
    pending.resolve({ failure });
  }
  return pending.promise.then((outcome) => {
    if ("failure" in outcome) throw new Refusal(listeners, outcome.failure);
    return outcome.value;
  });
}

/**
 * Converts an IDBRequest completion to a Promise and releases its observation.
 *
 * This does not certify transaction commit. Use committed(transaction) for that
 * boundary. A completed request can be acquired after its native event using
 * its final readyState/error/result receipt. Request field and observation
 * retirement faults are retained in order.
 */
export async function waitForRequest<T>(request: IDBRequest<T>): Promise<T> {
  const listeners = new Listeners();
  let value!: T;
  try {
    value = await requested(request, listeners);
  } catch (reason) {
    if (!(reason instanceof Refusal && reason.owner === listeners)) listeners.note(reason);
  }
  listeners.retire();
  await listeners.join();
  listeners.finish();
  return value;
}

/**
 * Acquired transaction owner. Only complete and abort are terminal events.
 *
 * A bubbling request error can be canceled by the caller and followed by a
 * successful commit. Abort requested by this owner is rollback acknowledgement;
 * its null transaction.error is not an additional failure occurrence. A non-null
 * terminal error remains an observation even when it resembles a request error.
 */
export class Transaction {
  readonly listeners = new Listeners();
  readonly #transaction: IDBTransaction;
  readonly #done = Promise.withResolvers<void>();
  readonly #observed: boolean;
  #terminal = false;
  #aborting = false;
  #retirement: Promise<void> | undefined;

  constructor(transaction: IDBTransaction) {
    this.#transaction = transaction;
    const complete = this.listeners.observe(transaction, "complete", () => this.#settle(false));
    const abort = this.listeners.observe(transaction, "abort", () => this.#settle(true));
    this.#observed = complete && abort;
  }

  #settle(aborted: boolean): void {
    if (this.#terminal) return;
    this.#terminal = true;
    try {
      if (aborted) {
        const reason = this.#transaction.error;
        if (reason !== null) this.listeners.note(reason);
        else if (!this.#aborting) this.listeners.note(new Error("IndexedDB transaction aborted."));
      }
    } catch (reason) {
      this.listeners.note(reason);
    }
    this.#done.resolve();
  }

  abort(): void {
    if (this.#terminal || this.#aborting) return;
    this.#aborting = true;
    try {
      this.#transaction.abort();
    } catch (reason) {
      this.listeners.note(reason);
    }
  }

  /** The signal event claims its refusal before invoking borrowed transaction.abort. */
  signal(signal: AbortSignal | undefined, path: PathType): void {
    if (!signal) return;
    let admitted = false;
    const abort = () => {
      if (admitted) return;
      try {
        throwIfAborted(signal, "write", path);
      } catch (reason) {
        admitted = true;
        this.listeners.note(reason);
        this.abort();
      }
    };
    this.listeners.listen(signal, "abort", abort);
    try {
      if (signal.aborted) abort();
    } catch (reason) {
      this.listeners.note(reason);
    }
  }

  request<T>(request: IDBRequest<T>): Promise<T> {
    const count = this.listeners.failures.length;
    const pending = requested(request, this.listeners);
    if (this.listeners.failures.length > count) this.abort();
    return pending;
  }

  /** Cache before effects, join native terminal, then attempt every owned detach. */
  retire(): Promise<void> {
    if (this.#retirement) return this.#retirement;
    const pending = Promise.withResolvers<void>();
    this.#retirement = pending.promise;
    void (async () => {
      if (this.listeners.failures.length > 0) this.abort();
      // If terminal observation itself was refused, there is no honest Promise
      // with which to certify terminal delivery. Abort is still attempted and
      // every possibly installed listener is removed; success is never published.
      if (this.#observed) await this.#done.promise;
      this.listeners.retire();
      await this.listeners.join();
      this.listeners.finish();
    })().then(pending.resolve, pending.reject);
    return pending.promise;
  }

  async run<T>(action: () => T | Promise<T>): Promise<T> {
    let value!: T;
    if (this.listeners.failures.length === 0) {
      try {
        value = await action();
      } catch (reason) {
        if (!(reason instanceof Refusal && reason.owner === this.listeners)) this.listeners.note(reason);
      }
    }
    await this.retire();
    return value;
  }
}

/**
 * Waits for transaction completion, then releases its terminal observation.
 *
 * Completion certifies commit under the browser's selected durability policy;
 * it does not universally imply strict disk flushing. This function does not
 * overwrite caller handlers or treat a canceled request error as terminal.
 * Install before terminal dispatch: transactions expose no completion replay.
 */
export function committed(transaction: IDBTransaction): Promise<void> {
  return new Transaction(transaction).retire();
}
