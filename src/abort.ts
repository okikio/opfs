/** Private cancellation observation provenance; no transport or retry imports. @module */

/** The actual first event kept by one request invocation. */
export type CancellationPrimaryType =
  | { readonly kind: "abort" }
  | { readonly kind: "deadline"; readonly reason: unknown }
  | { readonly kind: "operation"; readonly stage: "prepare" | "fetch"; readonly reason: unknown };

/**
 * Observed caller cancellation beside the request's first event and extra faults.
 * An operation rejection can propagate the abort reason. This tuple records
 * observations and does not infer independent causes from their values.
 */
export interface CancellationType {
  /** Exact caller signal whose abort event this invocation observed. */
  readonly signal: AbortSignal;
  /** Reason captured when that caller event was observed. */
  readonly reason: unknown;
  /** Owned winner or actual operation rejection; normalizers preserve its category. */
  readonly primary: CancellationPrimaryType;
  /** Additional owned observer/retirement faults; these cannot be clean cancellation. */
  readonly extra: readonly unknown[];
}

/** Provenance belongs only to a newly composed failure, never a borrowed reason. */
const cancellations = new WeakMap<object, CancellationType>();

/** Snapshots observation metadata without freezing caller-owned signals or reasons. */
export function createCancellation(
  signal: AbortSignal,
  reason: unknown,
  primary: CancellationPrimaryType,
  extra: readonly unknown[] = [],
): CancellationType {
  return Object.freeze({ signal, reason, primary: Object.freeze({ ...primary }), extra: Object.freeze([...extra]) });
}

/** Attaches exact invocation evidence to a new owner-created aggregate only. */
export function retainCancellation(failure: AggregateError, observation: CancellationType): AggregateError {
  cancellations.set(failure, observation);
  return failure;
}

/** Inspects only this module's attached tuple; borrowed cause trees are not searched. */
export function getCancellation(failure: unknown): CancellationType | undefined {
  return typeof failure === "object" && failure !== null ? cancellations.get(failure) : undefined;
}

/**
 * Settles with `promise`, or rejects with `signal.reason` as soon as `signal`
 * aborts, whichever happens first.
 *
 * Socket clients use it around one pending read or write:
 * `await raceAbort(socket.read(), signal)`. It does not cancel the work behind
 * `promise`; the caller still owns that and must close the socket on abort.
 * A late rejection of `promise` after the abort is observed, so it is never
 * reported as unhandled.
 */
export function raceAbort<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const pending = Promise.resolve(promise);
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    if (signal.aborted) {
      pending.catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort)).catch(() => {});
  });
}
