import { retry as retryAsync, RetryError } from '@std/async/retry';
import type { EmptyEndpointHost } from '@utils/server/endpoint';
import type { RetryPolicy, ResiliencePolicy } from '@utils/resilience';

import type {
	ServiceConcernValues,
	ServiceRequestState,
	ServiceResilienceRuntime,
	ServiceStageResult,
} from './types.ts';

/**
 * Error wrapper used when a caller deliberately classifies an operation failure
 * as safe to retry.
 *
 * Ordinary errors are not retried by default. A provider adapter may either
 * throw this wrapper or supply an explicit classifier to {@link standardRetry}.
 */
export class RetryableOperationError extends Error {
	readonly code?: string;

	constructor(cause: Error, options: Readonly<{ readonly code?: string; readonly message?: string }> = {}) {
		super(options.message ?? cause.message, { cause });
		this.name = 'RetryableOperationError';
		if (options.code !== undefined) this.code = options.code;
	}
}

/** Configuration for the standard-library-backed retry runtime. */
export interface StandardRetryOptions<
	Host extends object = EmptyEndpointHost,
	Concerns extends ServiceConcernValues = ServiceConcernValues,
> {
	/**
	 * Override retry classification for provider/domain-specific errors.
	 * Returning `true` asserts that replaying the wrapped operation is safe.
	 */
	readonly isRetriable?: (
		error: Error,
		policy: RetryPolicy,
		state: ServiceRequestState<Host, Concerns>,
	) => boolean;
}

/**
 * Create a service resilience runtime backed by `@std/async/retry`.
 *
 * This runtime supports only `retry` policies. Compose it with a durable
 * idempotency, rate-limit, circuit-breaker, or bulkhead runtime through
 * {@link composeRuntimes} when an operation declares several policies.
 */
export function standardRetry<
	Host extends object = EmptyEndpointHost,
	Concerns extends ServiceConcernValues = ServiceConcernValues,
>(options: StandardRetryOptions<Host, Concerns> = {}): ServiceResilienceRuntime<Host, Concerns> {
	return Object.freeze({
		/**
		 * Checks whether supports is supported by the compiled service runtime.
		 *
		 * @internal
		 */
		supports(policy: ResiliencePolicy): boolean {
			return policy.type === 'retry';
		},

		/**
		 * Executes work as one finite phase of the module runtime.
		 *
		 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
		 *
		 * @internal
		 */
		async execute(
			policies: readonly ResiliencePolicy[],
			state: ServiceRequestState<Host, Concerns>,
			next: () => Promise<ServiceStageResult>,
		): Promise<ServiceStageResult> {
			const policy = exactlyOneRetry(policies);
			try {
				return await retryAsync(next, {
					maxAttempts: policy.maximumAttempts,
					minTimeout: durationMilliseconds(policy.initialDelay),
					maxTimeout: durationMilliseconds(policy.maximumDelay),
					multiplier: policy.multiplier,
					jitter: policy.jitter ? 1 : 0,
					signal: state.ctx.signal,
					isRetriable: (reason) => {
						const error = normalizeError(reason);
						return options.isRetriable?.(error, policy, state) ?? defaultRetryDecision(error, policy);
					},
				});
			} catch (reason) {
				if (reason instanceof RetryError) throw normalizeError(reason.cause);
				throw normalizeError(reason);
			}
		},
	});
}

/**
 * Compose focused resilience runtimes into one deterministic onion.
 *
 * Every delegated policy must be owned by exactly one runtime. Runtimes execute
 * in the order of the first policy they own; their after-work unwinds in reverse
 * order, matching middleware and resource-lifecycle expectations.
 */
export function composeRuntimes<
	Host extends object = EmptyEndpointHost,
	Concerns extends ServiceConcernValues = ServiceConcernValues,
>(
	...runtimes: readonly ServiceResilienceRuntime<Host, Concerns>[]
): ServiceResilienceRuntime<Host, Concerns> {
	return Object.freeze({
		/**
		 * Checks whether supports is supported by the compiled service runtime.
		 *
		 * @internal
		 */
		supports(policy: ResiliencePolicy): boolean {
			return owners(policy, runtimes).length === 1;
		},

		/**
		 * Executes work as one finite phase of the module runtime.
		 *
		 * It links service definitions to exact implementations before traffic and keeps request-stage ownership visible at runtime.
		 *
		 * @internal
		 */
		async execute(
			policies: readonly ResiliencePolicy[],
			state: ServiceRequestState<Host, Concerns>,
			next: () => Promise<ServiceStageResult>,
		): Promise<ServiceStageResult> {
			const plans: Array<Readonly<{
				readonly runtime: ServiceResilienceRuntime<Host, Concerns>;
				readonly policies: ResiliencePolicy[];
			}>> = [];
			const byRuntime = new Map<ServiceResilienceRuntime<Host, Concerns>, ResiliencePolicy[]>();

			for (const policy of policies) {
				const matched = owners(policy, runtimes);
				if (matched.length !== 1) {
					throw new TypeError(
						matched.length === 0
							? `No resilience runtime supports ${policy.type}.`
							: `More than one resilience runtime claims ${policy.type}.`,
					);
				}
				const runtime = matched[0]!;
				let owned = byRuntime.get(runtime);
				if (owned === undefined) {
					owned = [];
					byRuntime.set(runtime, owned);
					plans.push(Object.freeze({ runtime, policies: owned }));
				}
				owned.push(policy);
			}

			let invoke = next;
			for (let index = plans.length - 1; index >= 0; index -= 1) {
				const plan = plans[index]!;
				const inner = invoke;
				invoke = async () => await plan.runtime.execute(Object.freeze([...plan.policies]), state, inner);
			}
			return await invoke();
		},
	});
}

/**
 * Collects the resilience policy owners that contribute to one effective operation without applying a policy twice.
 *
 * @internal
 */
function owners<Host extends object, Concerns extends ServiceConcernValues>(
	policy: ResiliencePolicy,
	runtimes: readonly ServiceResilienceRuntime<Host, Concerns>[],
): readonly ServiceResilienceRuntime<Host, Concerns>[] {
	return runtimes.filter((runtime) => runtime.supports(policy));
}

/**
 * Requires one retry policy owner when retry behavior must have a single unambiguous runtime authority.
 *
 * @internal
 */
function exactlyOneRetry(policies: readonly ResiliencePolicy[]): RetryPolicy {
	if (policies.length !== 1 || policies[0]?.type !== 'retry') {
		throw new TypeError('The standard retry runtime requires exactly one retry policy.');
	}
	return policies[0];
}

/**
 * Creates the fallback retry decision used when the compiled service runtime receives no explicit value.
 *
 * @internal
 */
function defaultRetryDecision(error: Error, policy: RetryPolicy): boolean {
	if (!(error instanceof RetryableOperationError)) return false;
	return policy.retryOn === undefined || (error.code !== undefined && policy.retryOn.includes(error.code));
}

/**
 * Converts duration into the millisecond value used by the compiled service runtime.
 *
 * @internal
 */
function durationMilliseconds(duration: Temporal.Duration): number {
	return duration.total({ unit: 'milliseconds', relativeTo: Temporal.PlainDate.from('2000-01-01') });
}

/**
 * Normalizes error into the canonical internal form used by later phases.
 *
 * @internal
 */
function normalizeError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error(String(reason));
}
