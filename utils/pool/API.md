@utils/pool public API usage
============================

Purpose
-------

This reference maps every public export target declared by `@utils/pool` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/pool
-----------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `create` | function | Create a bounded reusable-value pool with explicit ownership and fair acquisition waits. | `create(...)` | `.agents/tests/production-e2e.test.ts:169` uses `create`. |
| `CreateOptions` | interface | Inputs accepted while creating a pool. | `value: CreateOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Event` | type | Pool lifecycle event emitted after one state transition. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Lease` | interface | Caller-owned borrow of one reusable value. | `value: Lease` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Pool` | interface | Bounded process-local owner of reusable values. | `value: Pool` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PoolAcquireTimeoutError` | class | Pool acquisition exceeded its configured timeout. | `new PoolAcquireTimeoutError(...)` | `.agents/tests/public-api-matrix.test.ts:361` uses `PoolAcquireTimeoutError`. |
| `PoolUnavailableError` | class | Acquisition attempted while a pool is draining or disposed. | `new PoolUnavailableError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Stats` | interface | Current bounded-capacity counters. | `value: Stats` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`PoolAcquireTimeoutError` appears in `.agents/tests/public-api-matrix.test.ts:361`:

~~~~ typescript
assert.equal(new pool.PoolAcquireTimeoutError(Temporal.Duration.from({ milliseconds: index + 1 })).name, 'PoolAcquireTimeoutError');
			assert.equal(new worker.WorkerFailureError({ id: 'failure', data: {}, message: 'failed' }).name, 'WorkerFailureError');
			assert.equal(new worker.WorkerFaultError('fault').name, 'WorkerFaultError');
			assert.equal(new worker.WorkerProtocolError('invalid').name, 'WorkerProtocolError');
~~~~

`create` appears in `.agents/tests/production-e2e.test.ts:169`:

~~~~ typescript
await using valuesPool = await pool.create({
			ctx,
			maximum: 1,
			create: async () => ++created,
~~~~

@utils/pool/types
-----------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `CreateOptions` | interface | Inputs accepted while creating a pool. | `value: CreateOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Event` | type | Pool lifecycle event emitted after one state transition. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Lease` | interface | Caller-owned borrow of one reusable value. | `value: Lease` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Pool` | interface | Bounded process-local owner of reusable values. | `value: Pool` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Stats` | interface | Current bounded-capacity counters. | `value: Stats` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 13 public names across 2 package export targets. 2 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

