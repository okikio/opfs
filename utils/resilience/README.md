`@utils/resilience`
===================

Purpose
-------

`@utils/resilience` defines import-safe timeout, idempotency, retry,
circuit-breaker, bulkhead, rate-limit, and body-limit policies. Definitions do
not allocate timers, counters, stores, or provider clients.

How it fits
-----------

Endpoints, middleware, services, activities, and provider adapters can
contribute these policies. The runtime that owns the affected operation must
supply the concrete behavior and must reject semantics it cannot support.

Import-safe timeout, idempotency, retry, circuit-breaker, bulkhead, rate-limit, and body-limit policy definitions.

Policies describe required behavior. They never start timers, open stores, allocate distributed counters, or wrap providers at import time.

Runtime ownership
-----------------

The generic Hono service runtime implements two policies directly:

```text
timeout
  Bounds request execution and actively aborts work at the deadline.

body-limit
  Bounds the request body before parsing or endpoint validation.
```

The remaining policies require an explicit host runtime:

```text
idempotency
  Durable operation-key ownership, in-progress coordination, response replay,
  conflict detection, and expiry.

rate-limit
  Distributed or deliberately regional admission accounting and Retry-After.

bulkhead
  Concurrency permits, bounded queues, cancellation, and release.

circuit-breaker
  Failure accounting, open/half-open state, and recovery probes.

retry
  Attempt classification, delay/backoff, cancellation, and retry-safe scope.
```

A service that declares one of those policies fails during runtime creation when no supporting resilience adapter is supplied. Policies never silently become documentation-only no-ops.

```ts
const runtime = service.create(compiled, implementation, {
  host,
  concerns: {
    resilience: {
      supports(policy) {
        return distributedResilience.supports(policy.type);
      },

      async execute(policies, state, next) {
        return await distributedResilience.execute({
          policies,
          request: state.request,
          operation: state.operation,
          signal: state.execution.signal,
          next,
        });
      },
    },
  },
});
```

Policy placement
----------------

Request idempotency, request admission, and operation bulkheads may be declared on service operations. Provider-call retries and provider circuit breakers usually belong on the resource/provider adapter that owns the call; retrying an entire endpoint can repeat unrelated reads or side effects.

The compiler rejects unsafe retry declarations unless the effective operation also has an idempotency policy.


Runtime stages
--------------

Service-level policies are not all wrapped around the same block of work:

```text
validated request
|
+-- afterValidation middleware
|   |
|   +-- admission stage
|       idempotency -> rate limit -> bulkhead
|       |
|       +-- authorization
|       +-- entitlements
|       +-- request-safe billing
|       |
|       +-- operation stage
|           retry -> circuit breaker
|           |
|           +-- aroundOperation middleware
|               transaction/unit of work
|               +-- handler
```

`resilience.stage(policy)` exposes the assignment used by the generic service
runtime. A retry recreates `aroundOperation` middleware for every attempt, so a
transaction does not span several attempts. It does not automatically repeat
billing admission or entitlement evaluation.

```ts
const CreateImportResilience = [
  resilience.timeout({ seconds: 30 }),
  resilience.bodyLimit(5_000_000),
  resilience.idempotent({ ttl: { hours: 24 } }),
  resilience.rateLimit({
    limit: 20,
    window: { minutes: 1 },
    key: 'organization',
  }),
  resilience.bulkhead({ concurrency: 8, queue: 32 }),
  resilience.retry({
    maximumAttempts: 3,
    retryOn: ['serialization-failure'],
  }),
];
```

The policy list may be contributed at service, targeted service-policy,
endpoint-group, endpoint-path, or operation scope. The compiler rejects two
different effective configurations for the same policy type.

Standard retry runtime
----------------------

```ts
const retryRuntime = service.standardRetry({
  isRetriable(error, policy) {
    return error instanceof PostgresSerializationError &&
      policy.retryOn?.includes('serialization-failure') === true;
  },
});
```

The adapter delegates delay, exponential backoff, jitter, attempt limits, and
abort handling to `@std/async/retry`. Ordinary errors are not retryable by
default. An adapter must deliberately classify the failure or throw
`RetryableOperationError`.

Several focused runtimes can be linked without a lowest-common-denominator
implementation:

```ts
const resilienceRuntime = service.composeRuntimes(
  postgresIdempotencyRuntime,
  distributedRateLimitRuntime,
  localBulkheadRuntime,
  service.standardRetry(),
  providerCircuitRuntime,
);
```

Each effective policy must have exactly one runtime owner. Zero owners is a
configuration error; two owners is an ambiguity error.

Generated HTTP contract
-----------------------

The service compiler projects policy-visible transport behavior:

- an idempotency request header for idempotent operations;
- `409` for an idempotency-key conflict;
- `429` plus `Retry-After` for rate-limit admission;
- `503` plus `Retry-After` for bulkhead or circuit-breaker admission;
- timeout and body-limit problem responses.

Provider-specific rate-limit metadata may add fields such as remaining capacity or reset time, but the portable definition does not pretend every store exposes the same counters.

Adapter ownership
-----------------

Database, cache, workflow, and provider packages implement concrete behavior. For example:

- Postgres/Drizzle can own a durable idempotency table and transaction protocol;
- Redis or another distributed counter can own global rate limits;
- an HTTP provider resource can own retry and circuit-breaker state;
- an in-process semaphore can own a deliberately local bulkhead.

Those adapters consume the same immutable policy definitions and must reject unsupported semantics rather than degrading silently.

Progressive usage
-----------------

The package participates in the complete domain-enrichment example in
`docs/implementation/utils-progressive-usage.md`.  Read that guide when the
individual helpers make sense in isolation but their place in a service,
resource graph, runtime host, or workflow is not yet clear.

`API.md` is the exhaustive public-surface map for this package.  It lists every
package export target, explains each exported name, gives a compact use form,
and expands every detected repository use into a source-backed TypeScript
snippet.  An export with no current consumer stays labelled as unproven instead
of receiving an invented production example.

