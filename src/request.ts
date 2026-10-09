import { retry, RetryError } from "@std/async/retry";
import { aggregate } from "./close.ts";
import { createCancellation, retainCancellation } from "./abort.ts";
import type { CancellationPrimaryType, CancellationType } from "./abort.ts";
import { readResponse } from "./response.ts";
import { z } from "zod";

/**
 * Retry and timeout policy shared by direct HTTP storage clients.
 *
 * Values are optional so protocol clients can apply repository defaults without
 * copying a second default object into every public options type.
 */
export const RequestPolicySchema: z.ZodType<RequestPolicyType, RequestPolicyType> = z.object({
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
export type RequestPolicyType = import("./_schema_types.ts").RequestPolicyType;

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
  /** Fully prepared initialization, including the supplied attempt signal when Fetch must observe cancellation. */
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

/** One actual signal event; its origin is independent of reason identity. */
interface AbortEventType {
  readonly origin: "caller" | "deadline";
  readonly reason: unknown;
}

/** Scoped signal plus the observed events owned by this attempt. */
interface RequestSignalType {
  readonly signal?: AbortSignal;
  event(): AbortEventType | undefined;
  caller(): { readonly signal: AbortSignal; readonly reason: unknown } | undefined;
  cleanup(): void;
}

/**
 * Records concrete caller/deadline events before request preparation starts.
 * First scoped abort wins signal composition. A later caller event remains an
 * observation even if this attempt's timer already expired. Cleanup retires the
 * timer/listener; neither error classes nor equal values establish an event.
 */
function getSignal(signal: AbortSignal | undefined, timeoutMs: number | false | undefined): RequestSignalType {
  const controller = typeof timeoutMs === "number" ? new AbortController() : undefined;
  let event: AbortEventType | undefined;
  let caller: { readonly signal: AbortSignal; readonly reason: unknown } | undefined;
  const onAbort = () => {
    if (signal === undefined) return;
    caller ??= { signal, reason: signal.reason };
    if (event === undefined) {
      event = { origin: "caller", reason: caller.reason };
      controller?.abort(caller.reason);
    }
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = controller === undefined || typeof timeoutMs !== "number" ? undefined : setTimeout(() => {
    if (event !== undefined) return;
    const reason = new DOMException(`Request timed out after ${timeoutMs} ms.`, "TimeoutError");
    event = { origin: "deadline", reason };
    controller.abort(reason);
  }, timeoutMs);
  const scoped = controller?.signal ?? signal;
  return {
    ...(scoped === undefined ? {} : { signal: scoped }),
    event: () => event,
    caller: () => caller,
    cleanup() {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/** Preparation's own abort winner is distinct from a concrete callback failure. */
type PreparationType =
  | { readonly kind: "prepared"; readonly value: RequestAttemptType }
  | { readonly kind: "operation"; readonly reason: unknown }
  | { readonly kind: "abort"; readonly event: AbortEventType };

/**
 * Uses an opaque attempt-local abort token while preserving native race order.
 * The original create promise is the first race input. Its rejected value is
 * never interpreted as cancellation, even when equal to the signal's reason.
 * Uncooperative preparation remains observed after abort but cannot dispatch;
 * this scope cannot interrupt or join an arbitrary credential callback forever.
 */
async function prepare(
  create: (signal?: AbortSignal) => Promise<RequestAttemptType>,
  scoped: RequestSignalType,
): Promise<PreparationType> {
  const signal = scoped.signal;
  const prior = scoped.event();
  if (prior !== undefined) return { kind: "abort", event: prior };
  if (signal === undefined) {
    try {
      return { kind: "prepared", value: await create() };
    } catch (reason) {
      return { kind: "operation", reason };
    }
  }
  const token = Object.freeze({});
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(token);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // If create throws synchronously, the abort branch still has an immediate
  // observer. Promise.race observes both outcomes of a returned create promise.
  void aborted.catch(() => {});
  try {
    const value = await Promise.race([create(signal), aborted]);
    const event = scoped.event();
    return event === undefined ? { kind: "prepared", value } : { kind: "abort", event };
  } catch (reason) {
    if (reason === token) {
      const event = scoped.event();
      if (event === undefined) throw new Error("An owned abort winner has no observed signal event.");
      return { kind: "abort", event };
    }
    return { kind: "operation", reason };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/**
 * Sends one storage request through a shared retry and timeout policy.
 *
 * `create` prepares a new URL and `RequestInit` for every attempt. This is
 * required for signed protocols because credentials and timestamps can change
 * between attempts. The shared layer owns the actual Fetch call so metrics count
 * concrete network attempts instead of deterministic signing failures.
 * `create` must forward its supplied signal in `RequestInit.signal` for Fetch to
 * observe the caller cancellation and attempt deadline. Preparation is raced
 * against that signal; this layer does not rewrite the fully prepared Fetch init.
 * Observer callbacks cannot grant retries. If a response observer fails, this
 * layer retires the acquired response before rejecting. Independent Fetch,
 * observer, and retirement faults retain their original identities in order.
 * Preparation records an owned abort winner separately from actual callback
 * rejection. Fetch rejection and a caller abort are retained as two observations
 * even if Fetch forwards the same reason; this does not infer independent causes.
 * The original operation remains primary, while an abort-winning preparation
 * keeps its exact scalar reason. No reason-value equality grants retry authority.
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
    /** Optional HTTP counters. Throwing observer overrides refuse retry and retain acquired-body ownership. */
    readonly metrics?: RequestMetrics;
  },
): Promise<Response> {
  const policy = getRequestPolicy(options.policy);
  const attempts = options.replayable === false ? 1 : policy.retries! + 1;
  let attempt = 0;
  let fetches = 0;
  let cancellation: CancellationType | undefined;
  // Only this attempt's acquired HTTP response, Fetch rejection, or owned
  // deadline can grant replay authority. Callback-thrown markers from another
  // request remain ordinary reasons, including externally supplied RetryError.
  let admission: { readonly reason: RequestTransportError | RetryResponseError } | undefined;

  /** Observers report work; their failures cannot authorize another attempt. */
  const observe = <Value>(read: () => Value): Value => {
    try {
      return read();
    } catch (reason) {
      admission = undefined;
      throw reason;
    }
  };

  /** Admits only a reason created from this attempt's own retryable event. */
  const transport = (reason: unknown): RequestTransportError => {
    const error = new RequestTransportError(reason);
    admission = { reason: error };
    return error;
  };

  /** Composes current invocation observations, including equal-valued events. */
  const retain = (reason: unknown, primary: CancellationPrimaryType, scoped: RequestSignalType): unknown => {
    const caller = scoped.caller();
    if (caller === undefined) return reason;
    cancellation = createCancellation(caller.signal, caller.reason, primary);
    if (primary.kind === "abort") return reason; // One owned scalar event, not a new borrowed-object tag.
    return retainCancellation(
      aggregate([reason, caller.reason], "Request rejection and caller abort were both observed."),
      cancellation,
    );
  };

  /** Observer faults cannot become clean cancellation or grant retry authority. */
  const retainObserver = (reason: unknown, observer: unknown, message: string): AggregateError => {
    const failure = aggregate([reason, observer], message);
    if (cancellation !== undefined) {
      cancellation = createCancellation(cancellation.signal, cancellation.reason, cancellation.primary, [
        ...cancellation.extra,
        observer,
      ]);
      retainCancellation(failure, cancellation);
    }
    return failure;
  };

  const run = async (): Promise<Response> => {
    attempt += 1;
    admission = undefined;
    cancellation = undefined;
    const scoped = getSignal(options.signal, policy.timeoutMs);
    try {
      let prepared = await prepare(create, scoped);
      // An event can arrive after prepare settles and before this owner resumes.
      // Re-admit effects here rather than relying on an earlier signal snapshot.
      const late = scoped.event();
      if (prepared.kind === "prepared" && late !== undefined) prepared = { kind: "abort", event: late };
      if (prepared.kind === "abort") {
        const caller = scoped.caller();
        if (prepared.event.origin === "caller") {
          throw retain(prepared.event.reason, { kind: "abort" }, scoped);
        }
        if (caller !== undefined) {
          throw retain(prepared.event.reason, { kind: "deadline", reason: prepared.event.reason }, scoped);
        }
        throw transport(prepared.event.reason);
      }
      if (prepared.kind === "operation") {
        // The concrete preparation winner stays deterministic even if a later
        // timer fires. Only the owned abort winner can grant deadline replay.
        throw retain(prepared.reason, { kind: "operation", stage: "prepare", reason: prepared.reason }, scoped);
      }
      const request = prepared.value;

      // Resolve injected properties before owning a concrete Fetch invocation.
      // A preparation/getter failure cannot manufacture transport retry authority.
      const fetch = options.fetch;
      const input = request.input;
      const init = request.init;
      const started = observe(() => options.metrics?.request(fetches > 0));
      fetches += 1;
      let response: Response;
      try {
        response = await fetch.call(options, input, init);
      } catch (error) {
        const failure = retain(error, { kind: "operation", stage: "fetch", reason: error }, scoped);
        try {
          observe(() => options.metrics?.rejected(started));
        } catch (observer) {
          throw retainObserver(failure, observer, "Fetch and its rejection observer failed.");
        }
        if (scoped.caller() !== undefined) throw failure;
        throw transport(failure);
      }
      try {
        observe(() => options.metrics?.response(started));
      } catch (observer) {
        // Fetch has already transferred this response to us. The observer did
        // not transfer its body to a caller, so retirement remains our duty.
        return await readResponse(response, () => {
          throw observer;
        });
      }
      if (attempt < attempts && isRetryStatus(response.status)) {
        // Retirement is not Fetch failure. Refuse another attempt when disposing
        // this owned intermediate response fails, retaining its HTTP retry reason.
        return await readResponse(response, () => {
          const reason = new RetryResponseError(response);
          admission = { reason };
          throw reason;
        });
      }
      return response;
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
      isRetriable: (error: unknown) => admission !== undefined && error === admission.reason,
    });
  } catch (error) {
    // Unwrap only our own admitted transport reason and the retry engine's
    // wrapper around it. An external marker must retain its exact identity.
    const original = error instanceof RetryError && admission !== undefined && error.cause === admission.reason
      ? error.cause
      : error;
    const reason = admission !== undefined && original === admission.reason && original instanceof RequestTransportError
      ? original.cause
      : original;
    try {
      observe(() => options.metrics?.failure());
    } catch (observer) {
      throw retainObserver(reason, observer, "Request and its failure observer failed.");
    }
    throw reason;
  }
}
