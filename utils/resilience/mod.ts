/**
 * Import-safe resilience policy definitions for service and provider execution.
 *
 * Policies describe required behavior. Concrete stores, counters, semaphores,
 * and provider adapters own the runtime mechanics.
 *
 * @module
 */
import type {
	BodyLimitPolicy,
	BulkheadPolicy,
	CircuitBreakerPolicy,
	IdempotencyPolicy,
	RateLimitPolicy,
	ResilienceDocument,
	ResilienceInput,
	ResilienceOperationSafety,
	ResiliencePolicy,
	ResilienceStage,
	ResilienceValidationIssue,
	ResilienceValidationResult,
	RetryPolicy,
	TimeoutPolicy,
} from './types.ts';

/** Define an absolute request timeout. */
export function timeout(duration: Temporal.Duration | Temporal.DurationLike | string): TimeoutPolicy {
	return Object.freeze({ kind: 'resilience', type: 'timeout', duration: positiveDuration(duration, 'timeout') });
}

/** Define a request idempotency-key protocol. */
export function idempotent(options: Readonly<{
	readonly header?: string;
	readonly required?: boolean;
	readonly ttl?: Temporal.Duration | Temporal.DurationLike | string;
}> = {}): IdempotencyPolicy {
	const header = options.header ?? 'Idempotency-Key';
	assertHeaderName(header);
	return Object.freeze({
		kind: 'resilience',
		type: 'idempotency',
		header,
		required: options.required ?? true,
		...(options.ttl !== undefined ? { ttl: positiveDuration(options.ttl, 'idempotency ttl') } : {}),
	});
}

/** Define bounded automatic retry behavior. */
export function retry(options: Readonly<{
	readonly maximumAttempts?: number;
	readonly initialDelay?: Temporal.Duration | Temporal.DurationLike | string;
	readonly maximumDelay?: Temporal.Duration | Temporal.DurationLike | string;
	readonly multiplier?: number;
	readonly jitter?: boolean;
	readonly retryOn?: readonly string[];
}> = {}): RetryPolicy {
	const maximumAttempts = options.maximumAttempts ?? 3;
	const multiplier = options.multiplier ?? 2;
	assertPositiveInteger(maximumAttempts, 'maximumAttempts');
	if (!Number.isFinite(multiplier) || multiplier < 1) throw new TypeError('Retry multiplier must be at least 1.');
	const initialDelay = positiveDuration(options.initialDelay ?? { milliseconds: 100 }, 'initial retry delay');
	const maximumDelay = positiveDuration(options.maximumDelay ?? { seconds: 5 }, 'maximum retry delay');
	if (durationMilliseconds(maximumDelay) < durationMilliseconds(initialDelay)) {
		throw new TypeError('Maximum retry delay must not be shorter than the initial retry delay.');
	}
	return Object.freeze({
		kind: 'resilience',
		type: 'retry',
		maximumAttempts,
		initialDelay,
		maximumDelay,
		multiplier,
		jitter: options.jitter ?? true,
		...(options.retryOn !== undefined ? { retryOn: Object.freeze([...options.retryOn]) } : {}),
	});
}

/** Define a circuit breaker around a provider or resource capability. */
export function circuitBreaker(options: Readonly<{
	readonly failureThreshold?: number;
	readonly resetAfter?: Temporal.Duration | Temporal.DurationLike | string;
	readonly halfOpenPermits?: number;
}> = {}): CircuitBreakerPolicy {
	const failureThreshold = options.failureThreshold ?? 5;
	const halfOpenPermits = options.halfOpenPermits ?? 1;
	assertPositiveInteger(failureThreshold, 'failureThreshold');
	assertPositiveInteger(halfOpenPermits, 'halfOpenPermits');
	return Object.freeze({
		kind: 'resilience',
		type: 'circuit-breaker',
		failureThreshold,
		resetAfter: positiveDuration(options.resetAfter ?? { seconds: 30 }, 'circuit-breaker reset'),
		halfOpenPermits,
	});
}

/** Define bounded concurrent admission and queueing. */
export function bulkhead(options: Readonly<{
	readonly concurrency: number;
	readonly queue?: number;
}>): BulkheadPolicy {
	assertPositiveInteger(options.concurrency, 'bulkhead concurrency');
	assertNonNegativeInteger(options.queue ?? 0, 'bulkhead queue');
	return Object.freeze({
		kind: 'resilience',
		type: 'bulkhead',
		concurrency: options.concurrency,
		queue: options.queue ?? 0,
	});
}

/** Define request-rate admission. */
export function rateLimit(options: Readonly<{
	readonly limit: number;
	readonly window: Temporal.Duration | Temporal.DurationLike | string;
	readonly key?: string;
}>): RateLimitPolicy {
	assertPositiveInteger(options.limit, 'rate limit');
	return Object.freeze({
		kind: 'resilience',
		type: 'rate-limit',
		limit: options.limit,
		window: positiveDuration(options.window, 'rate-limit window'),
		...(options.key !== undefined ? { key: options.key } : {}),
	});
}

/** Define a maximum accepted request-body size. */
export function bodyLimit(bytes: number): BodyLimitPolicy {
	assertPositiveInteger(bytes, 'body limit');
	return Object.freeze({ kind: 'resilience', type: 'body-limit', bytes });
}

/**
 * Return the service-runtime stage that owns a policy.
 *
 * Admission policies decide whether one validated request may enter the
 * protected operation. Operation policies wrap each individual handler
 * attempt, so retrying also recreates `aroundOperation` middleware such as a
 * database transaction.
 */
export function stage(policy: ResiliencePolicy): ResilienceStage {
	switch (policy.type) {
		case 'idempotency':
		case 'rate-limit':
		case 'bulkhead':
			return 'admission';
		case 'retry':
		case 'circuit-breaker':
			return 'operation';
		case 'timeout':
		case 'body-limit':
			throw new TypeError(`${policy.type} is implemented directly by the HTTP runtime and has no delegated stage.`);
	}
}

/** Flatten nested policy inputs while preserving authored order. */
export function compose(...input: readonly ResilienceInput[]): readonly ResiliencePolicy[] {
	const result: ResiliencePolicy[] = [];
	const visit = (value: ResilienceInput): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		result.push(value as ResiliencePolicy);
	};
	for (const value of input) visit(value);
	return Object.freeze(result);
}

/** Validate and normalize a resilience plan. */
export function validate(
	input: ResilienceInput | undefined,
	options: Readonly<{ readonly safety?: ResilienceOperationSafety }> = {},
): ResilienceValidationResult {
	const contributed = input === undefined ? Object.freeze([]) : compose(input);
	const policies: ResiliencePolicy[] = [];
	const issues: ResilienceValidationIssue[] = [];
	const byType = new Map<ResiliencePolicy['type'], ResiliencePolicy>();
	for (const policy of contributed) {
		if (!is(policy)) {
			issues.push({ code: 'invalid-policy', message: 'Resilience input contains an invalid policy.' });
			continue;
		}
		const existing = byType.get(policy.type);
		// Re-importing the exact same immutable policy is harmless. Contribution
		// layers frequently share one exported policy value.
		if (existing === policy) continue;
		if (existing !== undefined) {
			issues.push({ code: 'conflicting-policy', message: `${policy.type} has more than one effective configuration.`, policy });
			continue;
		}
		byType.set(policy.type, policy);
		policies.push(policy);
	}
	if (byType.has('retry') && options.safety === 'unsafe' && !byType.has('idempotency')) {
		const retryPolicy = byType.get('retry')!;
		issues.push({
			code: 'unsafe-retry',
			message: 'Unsafe operations may not be retried without an explicit idempotency protocol.',
			policy: retryPolicy,
		});
	}
	return issues.length === 0
		? Object.freeze({ valid: true, policies: Object.freeze(policies) })
		: Object.freeze({ valid: false, issues: Object.freeze(issues) });
}

/** Return whether a value is a resiliency policy. */
export function is(value: unknown): value is ResiliencePolicy {
	return typeof value === 'object' && value !== null &&
		(value as { kind?: unknown }).kind === 'resilience' &&
		typeof (value as { type?: unknown }).type === 'string';
}

/** Create deterministic JSON-safe documentation. */
export function document(input: ResilienceInput): readonly ResilienceDocument[] {
	return Object.freeze(compose(input).map((policy) => Object.freeze({
		type: policy.type,
		configuration: Object.freeze(configuration(policy)),
	})));
}

/**
 * Returns the normalized resilience configuration attached to one compiled policy definition.
 *
 * Resilience internals keep retry, timeout, rate, concurrency, and circuit policy data separate from the runtime that applies it.
 *
 * @internal
 */
function configuration(policy: ResiliencePolicy): Record<string, string | number | boolean | readonly string[]> {
	switch (policy.type) {
		case 'timeout': return { duration: policy.duration.toString() };
		case 'idempotency': return {
			header: policy.header,
			required: policy.required,
			...(policy.ttl !== undefined ? { ttl: policy.ttl.toString() } : {}),
		};
		case 'retry': return {
			maximumAttempts: policy.maximumAttempts,
			initialDelay: policy.initialDelay.toString(),
			maximumDelay: policy.maximumDelay.toString(),
			multiplier: policy.multiplier,
			jitter: policy.jitter,
			...(policy.retryOn !== undefined ? { retryOn: policy.retryOn } : {}),
		};
		case 'circuit-breaker': return {
			failureThreshold: policy.failureThreshold,
			resetAfter: policy.resetAfter.toString(),
			halfOpenPermits: policy.halfOpenPermits,
		};
		case 'bulkhead': return { concurrency: policy.concurrency, queue: policy.queue };
		case 'rate-limit': return {
			limit: policy.limit,
			window: policy.window.toString(),
			...(policy.key !== undefined ? { key: policy.key } : {}),
		};
		case 'body-limit': return { bytes: policy.bytes };
	}
}

/**
 * Validates and normalizes positive duration for the timing rules used by resilience policy normalization.
 *
 * @internal
 */
function positiveDuration(
	value: Temporal.Duration | Temporal.DurationLike | string,
	name: string,
): Temporal.Duration {
	const duration = Temporal.Duration.from(value);
	if (!(durationMilliseconds(duration) > 0)) throw new TypeError(`${name} must be positive.`);
	return duration;
}

/**
 * Converts duration into the millisecond value used by resilience policy normalization.
 *
 * @internal
 */
function durationMilliseconds(value: Temporal.Duration): number {
	return value.total({ unit: 'milliseconds', relativeTo: Temporal.PlainDate.from('2000-01-01') });
}

/**
 * Rejects invalid positive integer before it can enter authoritative module state.
 *
 * @internal
 */
function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
}

/**
 * Rejects invalid non negative integer before it can enter authoritative module state.
 *
 * @internal
 */
function assertNonNegativeInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer.`);
}

/**
 * Rejects invalid header name before it can enter authoritative module state.
 *
 * @internal
 */
function assertHeaderName(value: string): void {
	if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value)) throw new TypeError(`Invalid HTTP header name ${JSON.stringify(value)}.`);
}

export type * from './types.ts';
