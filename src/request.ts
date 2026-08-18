import { retry } from "@std/async/retry";
import { z } from "zod";

/**
 * Retry and timeout policy shared by direct HTTP storage clients.
 *
 * Values are optional so protocol clients can apply repository defaults without
 * copying a second default object into every public options type.
 */
export const RequestPolicySchema = z.object({
  /** Additional attempts after the first request. Defaults to 3. */
  retries: z.number().int().nonnegative().optional(),
  /** Base retry delay in milliseconds. Defaults to 200. */
  minDelayMs: z.number().int().nonnegative().optional(),
  /** Maximum retry delay in milliseconds. Defaults to 20 seconds. */
  maxDelayMs: z.number().int().nonnegative().optional(),
  /** Exponential delay multiplier. Defaults to 2. */
  multiplier: z.number().min(1).optional(),
  /** Random delay proportion accepted by `@std/async/retry`. Defaults to 0.5. */
  jitter: z.number().min(0).max(1).optional(),
  /** Per-attempt deadline in milliseconds. `false` or omission leaves Fetch's own timeout policy unchanged. */
  timeoutMs: z.union([z.number().int().positive(), z.literal(false)]).optional(),
}).strict();

/** A validated direct-client request policy. */
export type RequestPolicyType = z.output<typeof RequestPolicySchema>;

/** Detached counters for one direct protocol client. */
export interface RequestMetricsType {
  /** Total HTTP requests actually sent, including retries. */
  readonly requests: number;
  /** Additional HTTP attempts after an initial failure/status. */
  readonly retries: number;
  /** Terminal request failures after retry policy is exhausted. */
  readonly failures: number;
  /** Responses returned to the protocol layer, including non-2xx service responses. */
  readonly responses: number;
  /** Total wall-clock milliseconds spent inside Fetch when timing is enabled. */
  readonly durationMs: number;
}

/** Mutable low-cost counters owned by one direct client. */
export class RequestMetrics {
  /** Whether monotonic duration is measured. */
  readonly #timing: boolean;
  /** Concrete Fetch attempts, including retries. */
  #requests = 0;
  /** Fetch attempts made after the first attempt for one logical request. */
  #retries = 0;
  /** Logical requests that exhausted retry policy or were canceled. */
  #failures = 0;
  /** HTTP responses received, including service error status codes. */
  #responses = 0;
  /** Accumulated Fetch wall-clock time when timing is enabled. */
  #durationMs = 0;

  /** Enables timing only when the caller explicitly requests it. */
  constructor(timing = false) {
    this.#timing = timing;
  }

  /** Records one concrete Fetch call and returns a start timestamp when needed. */
  request(retryAttempt: boolean): number {
    this.#requests += 1;
    if (retryAttempt) this.#retries += 1;
    return this.#timing ? performance.now() : 0;
  }

  /** Records one Fetch response. */
  response(started: number): void {
    this.#responses += 1;
    if (started !== 0) this.#durationMs += Math.max(0, performance.now() - started);
  }

  /** Records elapsed Fetch time for an attempt that rejected before a response arrived. */
  rejected(started: number): void {
    if (started !== 0) this.#durationMs += Math.max(0, performance.now() - started);
  }

  /** Records one terminal request failure after retry policy is exhausted or canceled. */
  failure(): void {
    this.#failures += 1;
  }

  /** Returns a detached snapshot that callers cannot use to mutate live counters. */
  snapshot(): RequestMetricsType {
    return {
      requests: this.#requests,
      retries: this.#retries,
      failures: this.#failures,
      responses: this.#responses,
      durationMs: this.#durationMs,
    };
  }
}

/** Marker for a failure thrown by the concrete Fetch transport after request construction succeeded. */
export class RequestTransportError extends Error {
  constructor(cause: unknown) {
    super("Storage request transport failed.");
    this.name = "RequestTransportError";
    this.cause = cause;
  }
}

/** Internal marker used to make retryable HTTP responses flow through `retry()`. */
class RetryResponseError extends Error {
  /** Response retained so the final retry can return it to the protocol parser. */
  readonly response: Response;

  constructor(response: Response) {
    super(`HTTP ${response.status} is retryable.`);
    this.name = "RetryResponseError";
    this.response = response;
  }
}

/** Validates integer policy values once before a request loop starts. */
function integer(value: number | undefined, fallback: number, name: string, minimum: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}.`);
  }
  return resolved;
}

/** Resolves and validates the shared request policy. */
export function getRequestPolicy(
  policy: RequestPolicyType | undefined,
): Required<Omit<RequestPolicyType, "timeoutMs">> & {
  readonly timeoutMs?: number | false;
} {
  const parsed = RequestPolicySchema.parse(policy ?? {});
  const retries = integer(parsed.retries, 3, "retries", 0);
  const minDelayMs = integer(parsed.minDelayMs, 200, "minDelayMs", 0);
  const maxDelayMs = integer(parsed.maxDelayMs, 20_000, "maxDelayMs", minDelayMs);
  const multiplier = parsed.multiplier ?? 2;
  const jitter = parsed.jitter ?? 0.5;
  if (!Number.isFinite(multiplier) || multiplier < 1) throw new RangeError("multiplier must be a finite number >= 1.");
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new RangeError("jitter must be between 0 and 1.");
  const timeoutMs = parsed.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== false && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw new RangeError("timeoutMs must be a positive integer, false, or omitted.");
  }
  return {
    retries,
    minDelayMs,
    maxDelayMs,
    multiplier,
    jitter,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

/** Returns whether an HTTP response is safe to retry at the transport-policy layer. */
export function isRetryStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Combines caller cancellation with one per-attempt deadline.
 *
 * The helper creates listeners only when a timeout is configured. Cleanup is
 * returned explicitly so long-lived clients do not accumulate abort listeners.
 */
function getSignal(signal: AbortSignal | undefined, timeoutMs: number | false | undefined): {
  readonly signal?: AbortSignal;
  readonly cleanup: () => void;
} {
  if (timeoutMs === undefined || timeoutMs === false) {
    return { ...(signal === undefined ? {} : { signal }), cleanup() {} };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Request timed out after ${timeoutMs} ms.`, "TimeoutError")),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Extracts the original error from `@std/async/retry` without coupling to its error class. */
function cause(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "cause" in error) {
    return (error as { cause?: unknown }).cause ?? error;
  }
  return error;
}

/**
 * Sends a replayable request through `@std/async/retry` while preserving the final HTTP response.
 *
 * `create` runs for every attempt. This is essential for signed storage
 * protocols because credentials and timestamps can change between attempts.
 * A non-replayable stream must pass `replayable: false`; it receives exactly
 * one attempt rather than risking a second request with an already-consumed body.
 *
 * Request construction, credential, and signing failures are deterministic at
 * this layer and are not retried. A client that reaches Fetch and gets a
 * transport failure wraps that failure in {@link RequestTransportError}. This
 * distinction prevents a malformed signature or invalid request option from
 * consuming the retry budget as if it were a transient network failure.
 */
export async function sendRequest(
  create: (signal?: AbortSignal) => Promise<Response>,
  options: {
    readonly policy?: RequestPolicyType;
    readonly signal?: AbortSignal;
    readonly replayable?: boolean;
    readonly metrics?: RequestMetrics;
  } = {},
): Promise<Response> {
  const policy = getRequestPolicy(options.policy);
  const attempts = options.replayable === false ? 1 : policy.retries! + 1;
  let attempt = 0;
  let lastStarted = 0;

  try {
    return await retry(async () => {
      attempt += 1;
      const scoped = getSignal(options.signal, policy.timeoutMs);
      const started = options.metrics?.request(attempt > 1) ?? 0;
      lastStarted = started;
      try {
        const response = await create(scoped.signal);
        options.metrics?.response(started);
        lastStarted = 0;
        if (attempt < attempts && isRetryStatus(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          throw new RetryResponseError(response);
        }
        return response;
      } catch (error) {
        // RetryResponseError already has a concrete response and its duration was
        // recorded above. Network/timeout failures have no Response, so record
        // the failed Fetch attempt here without counting it as a terminal failure.
        if (!(error instanceof RetryResponseError)) options.metrics?.rejected(started);
        lastStarted = 0;
        throw error;
      } finally {
        scoped.cleanup();
      }
    }, {
      maxAttempts: attempts,
      minTimeout: policy.minDelayMs!,
      maxTimeout: policy.maxDelayMs!,
      multiplier: policy.multiplier!,
      jitter: policy.jitter!,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      isRetriable: (error: unknown) => error instanceof RetryResponseError || error instanceof RequestTransportError,
    });
  } catch (error) {
    const original = cause(error);
    if (original instanceof RetryResponseError) return original.response;
    if (lastStarted !== 0) options.metrics?.rejected(lastStarted);
    options.metrics?.failure();
    throw original instanceof RequestTransportError ? original.cause : original;
  }
}
