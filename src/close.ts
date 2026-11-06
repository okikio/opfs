/** Internal terminal cleanup preserves every independently owned failure. @module */

/** An operation-owned aggregate's actual first reason, including undefined. */
const primary = new WeakMap<AggregateError, { readonly reason: unknown }>();

/** Creates an inspectable aggregate without granting authority to foreign errors. */
export function aggregate(reasons: readonly unknown[], message: string): AggregateError {
  const error = new AggregateError(reasons, message, { cause: reasons[0] });
  if (reasons.length > 0) primary.set(error, Object.freeze({ reason: reasons[0] }));
  return error;
}

/** Returns primary authority only for an aggregate created by this module. */
export function getPrimary(reason: unknown): { readonly reason: unknown } | undefined {
  return reason instanceof AggregateError ? primary.get(reason) : undefined;
}

/**
 * Attempts each owned release and retains the already-observed primary reasons.
 *
 * Null and undefined are actual reasons. Equal values from different actions are
 * different events; no error class, message, or identity removes an observation.
 * The caller owns action order and must not submit the same release event twice.
 */
export async function close(
  actions: readonly (() => void | PromiseLike<unknown>)[],
  primary: readonly unknown[] = [],
): Promise<void> {
  const failures = [...primary];
  for (const action of actions) {
    try {
      await action();
    } catch (reason) {
      failures.push(reason);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw aggregate(failures, "The operation and owned cleanup failed.");
  }
}
