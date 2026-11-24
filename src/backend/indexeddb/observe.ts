/**
 * Event observation underneath the IndexedDB request and transaction operations in `transaction.ts`.
 *
 * IndexedDB delivers `success`, `error`, `complete` and `abort` once, to whoever is listening at that moment.
 * `requested()` installs listeners without replacing caller-owned `on*` handlers and turns the event into an
 * owned receipt. `Listeners` records every failure it observes, including failures while listeners are
 * removed, so a cleanup fault can never hide the operation's own failure. `Refusal` carries an already
 * recorded failure across an `await` so it is not recorded twice.
 *
 * Most callers want `waitForRequest()` or `Transaction` from `@okikio/opfs/driver/indexeddb/_transaction`, which are
 * built on these pieces. Use this entry only to write a new owner with the same guarantees. The pieces keep those
 * guarantees only when used together, in this order:
 *
 * ```ts
 * import { Listeners, Refusal, requested } from "@okikio/opfs/driver/indexeddb/_observe";
 *
 * const listeners = new Listeners();
 * let value: unknown;
 * try {
 *   value = await requested(request, listeners);
 * } catch (reason) {
 *   // A Refusal from these listeners is already recorded; anything else is new.
 *   if (!(reason instanceof Refusal && reason.owner === listeners)) listeners.note(reason);
 * }
 * listeners.retire(); // remove every listener and restore every on* handler
 * await listeners.join(); // wait for work returned by saved caller handlers
 * listeners.finish(); // throw the one failure, or an AggregateError of all of them
 * ```
 *
 * Skipping `retire()`, `join()` or `finish()` leaves listeners installed or hides a recorded failure.
 *
 * @module
 */
import { aggregate } from "../../close.ts";

/** One observed failure occurrence; equal values do not establish a shared event. */
export interface FailureType {
  /** The failure value as observed, unchanged. */
  readonly reason: unknown;
}

/** Private transfer of an already-recorded event across an awaited request. */
export class Refusal {
  /** The `Listeners` that already recorded this failure. */
  readonly owner: Listeners;
  /** The recorded occurrence, compared by identity rather than by value. */
  readonly failure: FailureType;

  /** Created by `requested()`; callers only test for it with `instanceof` and `owner`. */
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
  /** Every failure recorded so far, in the order it was observed. */
  readonly failures: FailureType[] = [];
  readonly #releases: Array<() => void> = [];
  readonly #work = new Set<Promise<void>>();
  #retired = false;

  /** Records one failure occurrence and returns it, so a caller can pass it on without recording it twice. */
  note(reason: unknown): FailureType {
    const failure = { reason };
    this.failures.push(failure);
    return failure;
  }

  /**
   * Adds one event listener and reserves its removal first. Returns false, with the failure recorded, when
   * `addEventListener` throws.
   */
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

  /** Removes every listener and restores every replaced `on*` handler. Runs once; later calls do nothing. */
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

  /** Throws the single recorded failure, or an `AggregateError` of all of them. Returns when none was recorded. */
  finish(): void {
    const reasons = this.failures.map((failure) => failure.reason);
    if (reasons.length === 1) throw reasons[0];
    if (reasons.length > 1) {
      throw aggregate(reasons, "IndexedDB operation and retirement failed.");
    }
  }
}

/** Physical observation admission, used by the driver's database-open rollback. */
export interface ObservationType {
  /** Set by `requested()`: true when both success and error channels were installed. */
  observed?: boolean;
  /** Set by `requested()`: settles when the request's terminal event is actually observed. */
  terminal?: Promise<void>;
  /** Called when a terminal event arrives after a failed installation already settled the request. */
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
