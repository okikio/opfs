import { close } from "./close.ts";

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
