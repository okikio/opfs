import { diagnostic } from "../.mise/tasks/command.mjs";

/** One untimed setup observation; origins omit credentials, account paths and signed query data. */
export interface ProviderPhaseType {
  /** Internally authored lane and operation, never a provider object key. */
  readonly providerPhase: string;
  /** Start precedes callback admission; pass means the callback returned successfully. */
  readonly state: "start" | "pass" | "fail";
  /** Fixed fixture scheme, host and port only. */
  readonly origin: string;
  /** Bounded inert serialization; the actual thrown reason remains separate authority. */
  readonly failure?: unknown;
}

/** Default evidence stays on stderr, leaving native Mitata JSON on stdout. */
function emit(event: ProviderPhaseType): void {
  console.error(JSON.stringify(event));
}

/**
 * Labels one existing untimed provider operation without changing its transport.
 *
 * Callers supply fixed fixture endpoints and short authored labels. This helper
 * adds no requests, timers, retries or global hooks. Never call it inside a timed
 * benchmark callback. Register any callback-acquired resource with its existing
 * owner before returning, since recording pass can independently fail.
 * A successful callback retains its exact result; a failed
 * callback retains its exact thrown value, including null or undefined. If
 * diagnostics independently fail, both reasons survive. A failed start record
 * refuses callback admission; a failed pass record refuses certification.
 */
export async function phase<T>(
  label: string,
  endpoint: string,
  action: () => T | Promise<T>,
  write: (event: ProviderPhaseType) => void = emit,
): Promise<T> {
  if (label.length === 0 || label.length > 160) throw new RangeError("Provider phase labels must be short.");
  const origin = new URL(endpoint).origin;
  if (origin.length > 512) throw new RangeError("Provider phase origin is too large.");
  const context = { providerPhase: label, origin };
  write({ ...context, state: "start" });
  let result: T;
  try {
    result = await action();
  } catch (reason) {
    try {
      write({ ...context, state: "fail", failure: diagnostic(reason) });
    } catch (failure) {
      throw new AggregateError([reason, failure], "Provider phase and diagnostics failed.", { cause: reason });
    }
    throw reason;
  }
  write({ ...context, state: "pass" });
  return result;
}
