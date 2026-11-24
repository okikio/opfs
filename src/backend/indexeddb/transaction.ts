/**
 * IndexedDB request and transaction completion for the IndexedDB record driver.
 *
 * IndexedDB reports completion through events that fire once and cannot be replayed. This module turns
 * those events into awaited results while it keeps every observed failure, including failures raised while
 * listeners are removed.
 *
 * Published at `@okikio/opfs/driver/indexeddb/_transaction` for code that runs its own IndexedDB requests
 * beside the driver. Most callers never need it: the IndexedDB driver uses it internally.
 *
 * Call `waitForRequest(request)` for one request's value and `committed(transaction)` for the commit
 * boundary. A completed request does not mean its transaction committed.
 *
 * @module
 */
import { throwIfAborted } from "../../error.ts";
import type { PathType } from "../../path.ts";

export type { PathType };
import { Listeners, Refusal, requested } from "./observe.ts";

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
 * Owns one `IDBTransaction` from creation until it completes or aborts, and reports every failure it saw.
 *
 * Create it right after `database.transaction(...)`, before the transaction can finish, then run the work
 * through it:
 *
 * ```ts
 * const transaction = database.transaction("files", "readwrite");
 * const owner = new Transaction(transaction);
 * owner.signal(signal, path);
 * await owner.run(async () => {
 *   const value = await owner.request(transaction.objectStore("files").get(path));
 *   if (owner.failed) return;
 *   await owner.request(transaction.objectStore("files").put(next));
 * });
 * ```
 *
 * `run()` resolves only after the transaction is terminal, and throws if any request, the signal, or the
 * transaction itself failed. Only `complete` and `abort` are terminal: a request error that the caller cancels
 * can still be followed by a successful commit. An abort this owner requested is the rollback it asked for,
 * not an extra failure.
 */
export class Transaction {
  readonly #listeners = new Listeners();
  readonly #transaction: IDBTransaction;
  readonly #done = Promise.withResolvers<void>();
  readonly #observed: boolean;
  #terminal = false;
  #aborting = false;
  #retirement: Promise<void> | undefined;

  /** Starts observing `complete` and `abort`. Call it before the transaction can finish; IndexedDB has no replay. */
  constructor(transaction: IDBTransaction) {
    this.#transaction = transaction;
    const complete = this.#listeners.observe(transaction, "complete", () => this.#settle(false));
    const abort = this.#listeners.observe(transaction, "abort", () => this.#settle(true));
    this.#observed = complete && abort;
  }

  #settle(aborted: boolean): void {
    if (this.#terminal) return;
    this.#terminal = true;
    try {
      if (aborted) {
        const reason = this.#transaction.error;
        if (reason !== null) this.#listeners.note(reason);
        else if (!this.#aborting) this.#listeners.note(new Error("IndexedDB transaction aborted."));
      }
    } catch (reason) {
      this.#listeners.note(reason);
    }
    this.#done.resolve();
  }

  /** True once any request, the signal or the transaction has failed; later requests are pointless. */
  get failed(): boolean {
    return this.#listeners.failures.length > 0;
  }

  /** Aborts the transaction once. Safe to call after it finished or while an abort is already pending. */
  abort(): void {
    if (this.#terminal || this.#aborting) return;
    this.#aborting = true;
    try {
      this.#transaction.abort();
    } catch (reason) {
      this.#listeners.note(reason);
    }
  }

  /**
   * Aborts the transaction when `signal` aborts, recording the cancellation as this owner's failure.
   *
   * `path` names the file in the resulting `AbortError`. The listener is removed when the owner retires.
   */
  signal(signal: AbortSignal | undefined, path: PathType): void {
    if (!signal) return;
    let admitted = false;
    const abort = () => {
      if (admitted) return;
      try {
        throwIfAborted(signal, "write", path);
      } catch (reason) {
        admitted = true;
        this.#listeners.note(reason);
        this.abort();
      }
    };
    this.#listeners.listen(signal, "abort", abort);
    try {
      if (signal.aborted) abort();
    } catch (reason) {
      this.#listeners.note(reason);
    }
  }

  /** Waits for one request in this transaction. A request that cannot be observed aborts the transaction. */
  request<T>(request: IDBRequest<T>): Promise<T> {
    const count = this.#listeners.failures.length;
    const pending = requested(request, this.#listeners);
    if (this.#listeners.failures.length > count) this.abort();
    return pending;
  }

  /**
   * Waits for the transaction to finish, removes every listener, and throws if anything failed.
   *
   * Repeated calls return the same promise. If a failure was already recorded, the transaction is aborted first.
   */
  retire(): Promise<void> {
    if (this.#retirement) return this.#retirement;
    const pending = Promise.withResolvers<void>();
    this.#retirement = pending.promise;
    void (async () => {
      if (this.#listeners.failures.length > 0) this.abort();
      // If terminal observation itself was refused, there is no honest Promise
      // with which to certify terminal delivery. Abort is still attempted and
      // every possibly installed listener is removed; success is never published.
      if (this.#observed) await this.#done.promise;
      this.#listeners.retire();
      await this.#listeners.join();
      this.#listeners.finish();
    })().then(pending.resolve, pending.reject);
    return pending.promise;
  }

  /**
   * Runs `action` inside the transaction, then retires the owner and returns the action's value.
   *
   * If the owner had already failed, `action` is skipped. A failure inside `action` is recorded rather than
   * thrown immediately, so the transaction still reaches a terminal state before `run()` throws.
   */
  async run<T>(action: () => T | Promise<T>): Promise<T> {
    let value!: T;
    if (this.#listeners.failures.length === 0) {
      try {
        value = await action();
      } catch (reason) {
        if (!(reason instanceof Refusal && reason.owner === this.#listeners)) this.#listeners.note(reason);
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
