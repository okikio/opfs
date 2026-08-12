@utils/resilience public API usage
==================================

Purpose
-------

This reference maps every public export target declared by `@utils/resilience` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/resilience
-----------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `bodyLimit` | function | Define a maximum accepted request-body size. | `bodyLimit(...)` | `.agents/support/production-fixture.ts:307` uses `bodyLimit`. |
| `BodyLimitPolicy` | interface | Maximum accepted request-body size. | `value: BodyLimitPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `bulkhead` | function | Define bounded concurrent admission and queueing. | `bulkhead(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `BulkheadPolicy` | interface | Concurrency-admission policy. | `value: BulkheadPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `circuitBreaker` | function | Define a circuit breaker around a provider or resource capability. | `circuitBreaker(...)` | `.agents/tests/public-api-repetition.test.ts:77` uses `circuitBreaker`. |
| `CircuitBreakerPolicy` | interface | Circuit-breaker policy around a provider/resource capability. | `value: CircuitBreakerPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `compose` | function | Flatten nested policy inputs while preserving authored order. | `compose(...)` | `utils/activity/mod.ts:67` uses `compose`. |
| `document` | function | Create deterministic JSON-safe documentation. | `document(...)` | `.agents/tests/production-e2e.test.ts:158` uses `document`. |
| `IdempotencyPolicy` | interface | Request idempotency protocol. | `value: IdempotencyPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `idempotent` | function | Define a request idempotency-key protocol. | `idempotent(...)` | `.agents/support/production-fixture.ts:308` uses `idempotent`. |
| `is` | function | Return whether a value is a resiliency policy. | `is(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `rateLimit` | function | Define request-rate admission. | `rateLimit(...)` | `utils/server/service/compile_test.ts:160` uses `rateLimit`. |
| `RateLimitPolicy` | interface | Request-rate admission policy. | `value: RateLimitPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceDocument` | interface | JSON-safe policy documentation. | `value: ResilienceDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceInput` | type | Recursive authoring input accepted by resiliency fields. | `value: ResilienceInput` | `utils/activity/types.ts:25` uses `ResilienceInput`. |
| `ResilienceOperationSafety` | type | HTTP method safety class used when validating retry policy. | `value: ResilienceOperationSafety` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResiliencePolicy` | type | Any static resiliency policy. | `value: ResiliencePolicy` | `utils/activity/types.ts:39` uses `ResiliencePolicy`. |
| `ResilienceStage` | type | Runtime stage that owns one service-level resilience policy. | `value: ResilienceStage` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceValidationIssue` | interface | Deterministic validation issue. | `value: ResilienceValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceValidationResult` | type | Validation result for one composed resiliency plan. | `value: ResilienceValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `retry` | function | Define bounded automatic retry behavior. | `retry(...)` | `.agents/support/production-fixture.ts:309` uses `retry`. |
| `RetryPolicy` | interface | Bounded automatic retry policy. | `value: RetryPolicy` | `utils/server/service/resilience.ts:40` uses `RetryPolicy`. |
| `stage` | function | Return the service-runtime stage that owns a policy. | `stage(...)` | `utils/server/service/runtime.ts:313` uses `stage`. |
| `timeout` | function | Define an absolute request timeout. | `timeout(...)` | `.agents/support/production-fixture.ts:310` uses `timeout`. |
| `TimeoutPolicy` | interface | Absolute request timeout policy. | `value: TimeoutPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `validate` | function | Validate and normalize a resilience plan. | `validate(...)` | `utils/server/service/compile.ts:162` uses `validate`. |

Detected uses
~~~~~~~~~~~~~

`timeout` appears in `.agents/support/production-fixture.ts:310`:

~~~~ typescript
resilience.timeout({ seconds: 2 }),
	],
	responses: [Accepted],
});
~~~~

`idempotent` appears in `.agents/support/production-fixture.ts:308`:

~~~~ typescript
resilience.idempotent(),
		resilience.retry({ maximumAttempts: 2, jitter: false }),
		resilience.timeout({ seconds: 2 }),
	],
~~~~

`retry` appears in `.agents/support/production-fixture.ts:309`:

~~~~ typescript
resilience.retry({ maximumAttempts: 2, jitter: false }),
		resilience.timeout({ seconds: 2 }),
	],
	responses: [Accepted],
~~~~

`circuitBreaker` appears in `.agents/tests/public-api-repetition.test.ts:77`:

~~~~ typescript
assert.equal(resilience.circuitBreaker({ failureThreshold: 2 }).failureThreshold, 2);
		assert.throws(() => resilience.circuitBreaker({ failureThreshold: 0 }), TypeError);
	});
~~~~

`rateLimit` appears in `utils/server/service/compile_test.ts:160`:

~~~~ typescript
resilience.rateLimit({ limit: 10, window: { minutes: 1 } }),
			],
			responses: [Accepted],
		});
~~~~

`bodyLimit` appears in `.agents/support/production-fixture.ts:307`:

~~~~ typescript
resilience.bodyLimit(4_096),
		resilience.idempotent(),
		resilience.retry({ maximumAttempts: 2, jitter: false }),
		resilience.timeout({ seconds: 2 }),
~~~~

`stage` appears in `utils/server/service/runtime.ts:313`:

~~~~ typescript
policy.type !== 'timeout' && policy.type !== 'body-limit' && resilience.stage(policy) === stage
	));
	if (policies.length === 0) return await next();
	return await options.concerns!.resilience!.execute(policies, freezeState(state), next);
~~~~

`compose` appears in `utils/activity/mod.ts:67`:

~~~~ typescript
const resilience = input.resilience === undefined ? Object.freeze([]) : resilienceCore.compose(input.resilience);
	return Object.freeze({
		kind: 'activity',
		id: input.id,
~~~~

`validate` appears in `utils/server/service/compile.ts:162`:

~~~~ typescript
const resiliencyValidation = resilience.validate(
			resiliencyInput,
			{ safety: operationSafety(route.method) },
		);
~~~~

`document` appears in `.agents/tests/production-e2e.test.ts:158`:

~~~~ typescript
assert.equal(resilience.document([Retry])[0]?.type, 'retry');
		const Query = query.define({
			fields: { id: query.field(Text, { sortable: true }) },
			order: [query.asc('id', { tiebreaker: true })],
~~~~

`RetryPolicy` appears in `utils/server/service/resilience.ts:40`:

~~~~ typescript
policy: RetryPolicy,
		state: ServiceRequestState<Host, Concerns>,
	) => boolean;
}
~~~~

`ResiliencePolicy` appears in `utils/activity/types.ts:39`:

~~~~ typescript
readonly resilience: readonly ResiliencePolicy[];
}

/** Input value inferred from an activity definition. */
~~~~

`ResilienceInput` appears in `utils/activity/types.ts:25`:

~~~~ typescript
readonly resilience?: ResilienceInput;
}

/** Immutable external-work contract. */
~~~~

@utils/resilience/types
-----------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `BodyLimitPolicy` | interface | Maximum accepted request-body size. | `value: BodyLimitPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `BulkheadPolicy` | interface | Concurrency-admission policy. | `value: BulkheadPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CircuitBreakerPolicy` | interface | Circuit-breaker policy around a provider/resource capability. | `value: CircuitBreakerPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `IdempotencyPolicy` | interface | Request idempotency protocol. | `value: IdempotencyPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RateLimitPolicy` | interface | Request-rate admission policy. | `value: RateLimitPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceDocument` | interface | JSON-safe policy documentation. | `value: ResilienceDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceInput` | type | Recursive authoring input accepted by resiliency fields. | `value: ResilienceInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceOperationSafety` | type | HTTP method safety class used when validating retry policy. | `value: ResilienceOperationSafety` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResiliencePolicy` | type | Any static resiliency policy. | `value: ResiliencePolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceStage` | type | Runtime stage that owns one service-level resilience policy. | `value: ResilienceStage` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceValidationIssue` | interface | Deterministic validation issue. | `value: ResilienceValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ResilienceValidationResult` | type | Validation result for one composed resiliency plan. | `value: ResilienceValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RetryPolicy` | interface | Bounded automatic retry policy. | `value: RetryPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `TimeoutPolicy` | interface | Absolute request timeout policy. | `value: TimeoutPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 40 public names across 2 package export targets. 13 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

