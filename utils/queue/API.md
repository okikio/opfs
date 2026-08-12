@utils/queue public API usage
=============================

Purpose
-------

This reference maps every public export target declared by `@utils/queue` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/queue
------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `AddOptions` | interface | Options used while adding one item. | `value: AddOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Claim` | interface | Temporary durable ownership of one queue item. | `value: Claim` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ClaimOptions` | interface | Options used while claiming available items. | `value: ClaimOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Event` | type | Authoritative queue event emitted after one committed state change. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `memory` | function | Create a process-local queue that implements the same ownership contract as durable adapters. | `memory(...)` | `.agents/support/production-fixture.ts:399` uses `memory`. |
| `MemoryOptions` | interface | Inputs accepted by the memory queue. | `value: MemoryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Queue` | interface | At-least-once work transport with explicit claim ownership. | `value: Queue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueueCapacityError` | class | Queue active-item capacity was exhausted. | `new QueueCapacityError(...)` | `.agents/tests/public-api-matrix.test.ts:357` uses `QueueCapacityError`. |
| `QueueClosedError` | class | Operation attempted after a queue stopped accepting work. | `new QueueClosedError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `QueueItemCancelledError` | class | Result wait failed because the queue item was cancelled. | `new QueueItemCancelledError(...)` | `.agents/tests/public-api-matrix.test.ts:360` uses `QueueItemCancelledError`. |
| `QueueItemFailedError` | class | Result wait failed because the queue item reached a failed state. | `new QueueItemFailedError(...)` | `.agents/tests/public-api-matrix.test.ts:359` uses `QueueItemFailedError`. |
| `QueueItemNotFoundError` | class | A queue reference does not identify a known item. | `new QueueItemNotFoundError(...)` | `.agents/tests/public-api-matrix.test.ts:356` uses `QueueItemNotFoundError`. |
| `Ref` | interface | Stable reference to one queue item. | `value: Ref` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RetryOptions` | interface | Options used while releasing a claim for retry. | `value: RetryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `StaleClaimError` | class | A queue claim no longer owns the referenced item. | `new StaleClaimError(...)` | `.agents/tests/public-api-matrix.test.ts:358` uses `StaleClaimError`. |
| `Stats` | interface | Current queue counters. | `value: Stats` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`QueueCapacityError` appears in `.agents/tests/public-api-matrix.test.ts:357`:

~~~~ typescript
assert.equal(new queue.QueueCapacityError(index + 1).capacity, index + 1);
			assert.equal(new queue.StaleClaimError('item', `claim-${index}`).claimId, `claim-${index}`);
			assert.equal(new queue.QueueItemFailedError('item', { id: 'failure', data: {}, message: 'failed' }).failure.id, 'failure');
			assert.equal(new queue.QueueItemCancelledError('item', 'cancelled').reason, 'cancelled');
~~~~

`QueueItemNotFoundError` appears in `.agents/tests/public-api-matrix.test.ts:356`:

~~~~ typescript
assert.equal(new queue.QueueItemNotFoundError(`item-${index}`).itemId, `item-${index}`);
			assert.equal(new queue.QueueCapacityError(index + 1).capacity, index + 1);
			assert.equal(new queue.StaleClaimError('item', `claim-${index}`).claimId, `claim-${index}`);
			assert.equal(new queue.QueueItemFailedError('item', { id: 'failure', data: {}, message: 'failed' }).failure.id, 'failure');
~~~~

`StaleClaimError` appears in `.agents/tests/public-api-matrix.test.ts:358`:

~~~~ typescript
assert.equal(new queue.StaleClaimError('item', `claim-${index}`).claimId, `claim-${index}`);
			assert.equal(new queue.QueueItemFailedError('item', { id: 'failure', data: {}, message: 'failed' }).failure.id, 'failure');
			assert.equal(new queue.QueueItemCancelledError('item', 'cancelled').reason, 'cancelled');
			assert.equal(new pool.PoolAcquireTimeoutError(Temporal.Duration.from({ milliseconds: index + 1 })).name, 'PoolAcquireTimeoutError');
~~~~

`QueueItemFailedError` appears in `.agents/tests/public-api-matrix.test.ts:359`:

~~~~ typescript
assert.equal(new queue.QueueItemFailedError('item', { id: 'failure', data: {}, message: 'failed' }).failure.id, 'failure');
			assert.equal(new queue.QueueItemCancelledError('item', 'cancelled').reason, 'cancelled');
			assert.equal(new pool.PoolAcquireTimeoutError(Temporal.Duration.from({ milliseconds: index + 1 })).name, 'PoolAcquireTimeoutError');
			assert.equal(new worker.WorkerFailureError({ id: 'failure', data: {}, message: 'failed' }).name, 'WorkerFailureError');
~~~~

`QueueItemCancelledError` appears in `.agents/tests/public-api-matrix.test.ts:360`:

~~~~ typescript
assert.equal(new queue.QueueItemCancelledError('item', 'cancelled').reason, 'cancelled');
			assert.equal(new pool.PoolAcquireTimeoutError(Temporal.Duration.from({ milliseconds: index + 1 })).name, 'PoolAcquireTimeoutError');
			assert.equal(new worker.WorkerFailureError({ id: 'failure', data: {}, message: 'failed' }).name, 'WorkerFailureError');
			assert.equal(new worker.WorkerFaultError('fault').name, 'WorkerFaultError');
~~~~

`memory` appears in `.agents/support/production-fixture.ts:399`:

~~~~ typescript
const taskQueue = queue.memory<Readonly<{ readonly activityId: string; readonly input: unknown; readonly path: string }>, unknown>({
		capacity: 128,
		id: (() => {
			let sequence = 0;
~~~~

@utils/queue/types
------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `AddOptions` | interface | Options used while adding one item. | `value: AddOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Claim` | interface | Temporary durable ownership of one queue item. | `value: Claim` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ClaimOptions` | interface | Options used while claiming available items. | `value: ClaimOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Event` | type | Authoritative queue event emitted after one committed state change. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MemoryOptions` | interface | Inputs accepted by the memory queue. | `value: MemoryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Queue` | interface | At-least-once work transport with explicit claim ownership. | `value: Queue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Ref` | interface | Stable reference to one queue item. | `value: Ref` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RetryOptions` | interface | Options used while releasing a claim for retry. | `value: RetryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Stats` | interface | Current queue counters. | `value: Stats` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 25 public names across 2 package export targets. 6 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

