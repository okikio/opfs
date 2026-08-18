import { RetryError, retry } from "@std/async/retry";
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

/**
 * Callable Web Fetch contract used by storage clients.
 *
 * This intentionally models only the standard call signature. Runtime-specific
 * globals can attach unrelated properties to `fetch`. Bun, for example, adds
 * `fetch.preconnect()`. Using `typeof fetch` here would make that Bun extension
 * part of every injected Fetch implementation while Deno type-checks the same
 * source. A normal test double only needs to be callable.
 */
export type FetchType = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Detached counters for one direct protocol client. */
export interface RequestMetricsType {
  /** Total HTTP requests actually sent, including retries. */
  readonly requests: number;
  /** Additional HTTP attempts after an earlier concrete Fetch attempt. */
  readonly retries: number;
  /** Terminal logical request failures after retry policy is exhausted or canceled. */
  readonly failures: number;
  /** HTTP responses received, including non-2xx service responses. */
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
  /** Fetch attempts made after an earlier concrete Fetch call for one logical request. */
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
  request(retryAttempt: boolean): number | undefined {
    this.#requests += 1;
    if (retryAttempt) this.#retries += 1;
    return this.#timing ? performance.now() : undefined;
  }

  /** Records one Fetch response. */
  response(started: number | undefined): void {
    this.#responses += 1;
    if (started !== undefined) this.#durationMs += Math.max(0, performance.now() - started);
  }

  /** Records elapsed Fetch time for an attempt that rejected before a response arrived. */
  rejected(started: number | undefined): void {
    if (started !== undefined) this.#durationMs += Math.max(0, performance.now() - started);
  }

  /** Records one terminal logical request failure. */
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
class RequestTransportError extends Error {
  constructor(cause: unknown) {
    super("Storage request transport failed.");
    this.name = "RequestTransportError";
    this.cause = cause;
  }
}

/** Internal marker used to make retryable HTTP responses flow through `retry()`. */
class RetryResponseError extends Error {
  /** Response retained for diagnostics while a later attempt is scheduled. */
  readonly response: Response;

  constructor(response: Response) {
    super(`HTTP ${response.status} is retryable.`);
    this.name = "RetryResponseError";
    this.response = response;
  }
}

/** Request values prepared before the shared layer owns the concrete Fetch call. */
interface RequestAttemptType {
  /** Fully prepared URL or RequestInfo for this attempt. */
  readonly input: RequestInfo | URL;
  /** Fully prepared request initialization for this attempt. */
  readonly init?: RequestInit;
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

/**
 * Waits for request preparation while making the scoped attempt signal authoritative.
 *
 * Signing and credential callbacks are normally fast, but they are still part
 * of one request attempt. Racing preparation with the scoped signal means a
 * configured per-attempt timeout also limits a slow credential source. The
 * preparation promise can continue internally if that source has no cancellation
 * API, but its eventual result can no longer publish an HTTP request.
 */
async function prepare(
  create: (signal?: AbortSignal) => Promise<RequestAttemptType>,
  signal: AbortSignal | undefined,
): Promise<RequestAttemptType> {
  if (signal === undefined) return await create();
  signal.throwIfAborted();

  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("The request attempt was aborted.", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([create(signal), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Returns the error callers should observe after one internal retry marker escapes. */
function unwrap(error: unknown): unknown {
  const original = error instanceof RetryError ? error.cause : error;
  return original instanceof RequestTransportError ? original.cause : original;
}

/**
 * Sends one storage request through a shared retry and timeout policy.
 *
 * `create` prepares a new URL and `RequestInit` for every attempt. This is
 * required for signed protocols because credentials and timestamps can change
 * between attempts. The shared layer owns the actual Fetch call so metrics count
 * concrete network attempts instead of deterministic signing failures.
 *
 * A non-replayable body or `retry: false` path passes `replayable: false`. That
 * path bypasses `@std/async/retry` completely and therefore cannot fail because
 * retry-only delay options are invalid for a request that will never retry.
 *
 * A zero-delay retry policy is supported. `@std/async/retry` requires a positive
 * `maxTimeout`, so the shared layer passes `1` as the validation ceiling when the
 * project policy requests `0`. With `minTimeout: 0`, the actual retry delay stays
 * zero because exponential backoff starts from zero.
 */
export async function sendRequest(
  create: (signal?: AbortSignal) => Promise<RequestAttemptType>,
  options: {
    /** Concrete Fetch implementation. Runtime globals and ordinary test doubles both satisfy this callable contract. */
    readonly fetch: FetchType;
    /** Retry, delay, jitter, and optional attempt-timeout policy. */
    readonly policy?: RequestPolicyType;
    /** Caller cancellation authority for the complete logical request. */
    readonly signal?: AbortSignal;
    /** Whether the request can be rebuilt and sent again after a transient failure. */
    readonly replayable?: boolean;
    /** Optional concrete HTTP counters owned by the protocol client. */
    readonly metrics?: RequestMetrics;
  },
): Promise<Response> {
  const policy = getRequestPolicy(options.policy);
  const attempts = options.replayable === false ? 1 : policy.retries! + 1;
  let attempt = 0;
  let fetches = 0;

  const run = async (): Promise<Response> => {
    attempt += 1;
    const scoped = getSignal(options.signal, policy.timeoutMs);
    try {
      const request = await prepare(create, scoped.signal);
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new DOMException("The request was aborted.", "AbortError");
      }
      scoped.signal?.throwIfAborted();

      const started = options.metrics?.request(fetches > 0);
      fetches += 1;
      try {
        const response = await options.fetch(request.input, request.init);
        options.metrics?.response(started);
        if (attempt < attempts && isRetryStatus(response.status)) {
          await response.body?.cancel().catch(() => undefined);
          throw new RetryResponseError(response);
        }
        return response;
      } catch (error) {
        if (!(error instanceof RetryResponseError)) options.metrics?.rejected(started);
        if (options.signal?.aborted) throw error;
        if (error instanceof RetryResponseError) throw error;
        throw new RequestTransportError(scoped.signal?.aborted ? scoped.signal.reason ?? error : error);
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (error instanceof RetryResponseError || error instanceof RequestTransportError) throw error;
      if (scoped.signal?.aborted) throw new RequestTransportError(scoped.signal.reason ?? error);
      // Request preparation, credentials, canonicalization, and signing failures
      // are deterministic at this layer. Do not spend the network retry budget.
      throw error;
    } finally {
      scoped.cleanup();
    }
  };

  try {
    if (attempts === 1) return await run();
    return await retry(run, {
      maxAttempts: attempts,
      minTimeout: policy.minDelayMs!,
      maxTimeout: Math.max(1, policy.maxDelayMs!),
      multiplier: policy.multiplier!,
      jitter: policy.jitter!,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      isRetriable: (error: unknown) => error instanceof RetryResponseError || error instanceof RequestTransportError,
    });
  } catch (error) {
    options.metrics?.failure();
    throw unwrap(error);
  }
}
