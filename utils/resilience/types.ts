/** HTTP method safety class used when validating retry policy. */
export type ResilienceOperationSafety = 'safe' | 'idempotent' | 'unsafe';

/** Absolute request timeout policy. */
export interface TimeoutPolicy {
	readonly kind: 'resilience';
	readonly type: 'timeout';
	readonly duration: Temporal.Duration;
}

/** Request idempotency protocol. */
export interface IdempotencyPolicy {
	readonly kind: 'resilience';
	readonly type: 'idempotency';
	readonly header: string;
	readonly required: boolean;
	readonly ttl?: Temporal.Duration;
}

/** Bounded automatic retry policy. */
export interface RetryPolicy {
	readonly kind: 'resilience';
	readonly type: 'retry';
	readonly maximumAttempts: number;
	readonly initialDelay: Temporal.Duration;
	readonly maximumDelay: Temporal.Duration;
	readonly multiplier: number;
	readonly jitter: boolean;
	readonly retryOn?: readonly string[];
}

/** Circuit-breaker policy around a provider/resource capability. */
export interface CircuitBreakerPolicy {
	readonly kind: 'resilience';
	readonly type: 'circuit-breaker';
	readonly failureThreshold: number;
	readonly resetAfter: Temporal.Duration;
	readonly halfOpenPermits: number;
}

/** Concurrency-admission policy. */
export interface BulkheadPolicy {
	readonly kind: 'resilience';
	readonly type: 'bulkhead';
	readonly concurrency: number;
	readonly queue: number;
}

/** Request-rate admission policy. */
export interface RateLimitPolicy {
	readonly kind: 'resilience';
	readonly type: 'rate-limit';
	readonly limit: number;
	readonly window: Temporal.Duration;
	readonly key?: string;
}

/** Maximum accepted request-body size. */
export interface BodyLimitPolicy {
	readonly kind: 'resilience';
	readonly type: 'body-limit';
	readonly bytes: number;
}

/** Runtime stage that owns one service-level resilience policy. */
export type ResilienceStage = 'admission' | 'operation';

/** Any static resiliency policy. */
export type ResiliencePolicy =
	| TimeoutPolicy
	| IdempotencyPolicy
	| RetryPolicy
	| CircuitBreakerPolicy
	| BulkheadPolicy
	| RateLimitPolicy
	| BodyLimitPolicy;

/** Recursive authoring input accepted by resiliency fields. */
export type ResilienceInput = ResiliencePolicy | readonly ResilienceInput[];

/** Deterministic validation issue. */
export interface ResilienceValidationIssue {
	readonly code:
		| 'invalid-policy'
		| 'duplicate-policy'
		| 'conflicting-policy'
		| 'unsafe-retry';
	readonly message: string;
	readonly policy?: ResiliencePolicy;
}

/** Validation result for one composed resiliency plan. */
export type ResilienceValidationResult =
	| Readonly<{ readonly valid: true; readonly policies: readonly ResiliencePolicy[] }>
	| Readonly<{ readonly valid: false; readonly issues: readonly ResilienceValidationIssue[] }>;

/** JSON-safe policy documentation. */
export interface ResilienceDocument {
	readonly type: ResiliencePolicy['type'];
	readonly configuration: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}
