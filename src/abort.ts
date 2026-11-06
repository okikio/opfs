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
