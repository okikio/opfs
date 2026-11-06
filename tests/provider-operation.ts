import { close } from "./close.ts";
import { getCancellation } from "../src/abort.ts";

/**
 * Admits only a successful uploaded part of this scenario's exact key.
 * A rejected part, seed write, multipart creation or unrelated request cannot
 * serve as evidence that the provider accepted bytes before cancellation.
 */
export function isPart(provider: "s3" | "azure", key: string, url: URL, method: string, status: number): boolean {
  if (method !== "PUT" || !url.pathname.endsWith(`/${key}`)) return false;
  return provider === "s3"
    ? url.searchParams.has("partNumber") && status === 200
    : url.searchParams.get("comp") === "block" && status === 201;
}

/**
 * Recognizes only an already-observed cancellation rejection for this scenario.
 *
 * The exact caller signal must actually be aborted. Its reason can be delivered
 * directly or by one sole mapper envelope. Request-owned observation metadata
 * can also prove that concrete Fetch rejected with the forwarded caller reason
 * while the same invocation observed this signal's abort. Those two observations
 * stay in the actual error; this predicate infers no independent causal origins.
 * Preparation, deadline, another signal and extra observer/retirement faults
 * cannot become clean cancellation. Callers must first observe actual rejection;
 * successful undefined is not cancellation evidence.
 */
export function isCancellation(reason: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const expected: unknown = signal.reason;
  const matches = (failure: unknown): boolean => {
    if (failure === expected) return true;
    const observed = getCancellation(failure);
    return observed !== undefined && observed.signal === signal && observed.reason === expected &&
      observed.extra.length === 0 && observed.primary.kind === "operation" &&
      observed.primary.stage === "fetch" && observed.primary.reason === expected;
  };
  if (matches(reason)) return true;
  if (getCancellation(reason) !== undefined) return false;
  // This is exactly one pool envelope, not a recursive aggregate search.
  if (!(reason instanceof AggregateError)) return false;
  const failures: readonly unknown[] = reason.errors;
  return failures.length === 1 && matches(failures[0]) &&
    (!("cause" in reason) || reason.cause === failures[0]);
}

/**
 * Starts an operational watchdog and returns its retirement action.
 * Tests inject a manual alarm so cancellation proofs do not depend on elapsed time.
 */
export type DeadlineType = (expire: () => void) => () => void;

/** Starts a 60 second safety alarm; this is not a provider latency requirement. */
function startDeadline(expire: () => void): () => void {
  const timer = setTimeout(expire, 60_000);
  return () => clearTimeout(timer);
}

/**
 * Owns the deadline of one admitted upload, after its setup has completed.
 *
 * Expiry aborts the caller signal with a distinct failure. It never closes a
 * producer or reports successful cancellation. The operation must settle its
 * owned reader and requests before returning or throwing; this function awaits
 * that settlement even after expiry. An outer test-runner deadline remains the
 * final bound when an implementation fails to honor cancellation at all.
 * Independent operation, deadline and alarm-retirement failures are retained.
 */
export async function settle<Value>(
  controller: AbortController,
  action: () => Promise<Value>,
  start: DeadlineType = startDeadline,
): Promise<Value> {
  let expired: Error | undefined;
  const retire = start(() => {
    expired = new Error("Provider upload exceeded its operational deadline.");
    controller.abort(expired);
  });
  let failed = false;
  let primary: unknown;
  try {
    const value = await action();
    if (expired !== undefined) throw expired;
    return value;
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    const failures = failed ? [primary] : [];
    if (expired !== undefined && (!failed || primary !== expired)) failures.unshift(expired);
    await close([retire], failures);
  }
}
