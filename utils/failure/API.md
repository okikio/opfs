@utils/failure public API usage
===============================

Purpose
-------

This reference maps every public export target declared by `@utils/failure` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/failure
--------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `.agents/tests/public-api-matrix.test.ts:111` uses `catalog`. |
| `compose` | function | Compose direct failure definitions, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:113` uses `compose`. |
| `create` | function | Create one schema-validated failure occurrence. | `create(...)` | `.agents/support/production-fixture.ts:415` uses `create`. |
| `Data` | type | Data output represented by a failure definition. | `value: Data` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `decode` | function | Decode and validate a durable occurrence through a trusted failure catalog. | `decode(...)` | `.agents/tests/production-e2e.test.ts:212` uses `decode`. |
| `define` | function | Define one immutable expected failure contract. | `define(...)` | `.agents/support/production-fixture.ts:142` uses `define`. |
| `Definition` | interface | Immutable declaration of one expected failure family. | `value: Definition` | `utils/activity/types.ts:21` uses `Definition`. |
| `encode` | function | Encode an occurrence after revalidating its durable data. | `encode(...)` | `.agents/support/production-fixture.ts:509` uses `encode`. |
| `Encoded` | interface | Durable representation of an expected failure occurrence. | `value: Encoded` | `utils/queue/mod.ts:75` uses `Encoded`. |
| `failureCatalog` | function | Create a named immutable failure catalog. | `failureCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FailureCatalog` | type | Named failure catalog. | `value: FailureCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FailureSelection` | type | Key-preserving failure catalog selection. | `value: FailureSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `is` | function | Return whether a value is an occurrence of one exact failure definition. | `is(...)` | `.agents/support/production-fixture.ts:585` uses `is`. |
| `isOccurrence` | function | Return whether a value is any failure occurrence created by this package. | `isOccurrence(...)` | `.agents/support/production-fixture.ts:508` uses `isOccurrence`. |
| `match` | function | Match a failure occurrence by stable definition ID. | `match(...)` | `.agents/tests/public-api-matrix.test.ts:164` uses `match`. |
| `Occurrence` | interface | In-process occurrence of one exact expected failure definition. | `value: Occurrence` | `utils/activity/types.ts:56` uses `Occurrence`. |
| `select` | function | Select a key-preserving failure catalog subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:112` uses `select`. |
| `UnknownFailureDefinitionError` | class | Error raised when durable failure data references an unknown definition. | `new UnknownFailureDefinitionError(...)` | `.agents/tests/public-api-matrix.test.ts:166` uses `UnknownFailureDefinitionError`. |

Detected uses
~~~~~~~~~~~~~

`UnknownFailureDefinitionError` appears in `.agents/tests/public-api-matrix.test.ts:166`:

~~~~ typescript
await assert.rejects(failure.decode({ id: 'missing', data: 'x', message: 'x' }, [FailureA]), failure.UnknownFailureDefinitionError);
		await assert.rejects(failure.decode({ id: 'missing', data: 'x', message: 'x' }, [FailureA]), failure.UnknownFailureDefinitionError);
		assert.equal(new activity.InvalidRuntimeError('activity', 'runtime').name, 'InvalidRuntimeError');
		assert.equal(new activity.InvalidRuntimeError('activity-2', 'runtime-2').name, 'InvalidRuntimeError');
~~~~

`define` appears in `.agents/support/production-fixture.ts:142`:

~~~~ typescript
const DomainRejected = failure.define({
	id: 'validation.domain-rejected',
	description: 'The supplied domain was rejected by page admission policy.',
	data: FailureDataSchema,
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:112`:

~~~~ typescript
assert.equal(failure.select(failures, ['FailureA']).FailureA, FailureA);
	assert.deepEqual(failure.compose(FailureA, failure.select(failures, ['FailureB'])), [FailureA, FailureB]);

	const resources = resource.catalog('matrix.resources', { ResourceA, ResourceB });
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:113`:

~~~~ typescript
assert.deepEqual(failure.compose(FailureA, failure.select(failures, ['FailureB'])), [FailureA, FailureB]);

	const resources = resource.catalog('matrix.resources', { ResourceA, ResourceB });
	assert.equal(resource.select(resources, ['ResourceB']).ResourceB, ResourceB);
~~~~

`create` appears in `.agents/support/production-fixture.ts:415`:

~~~~ typescript
throw await failure.create(DomainRejected, { data: { domain: ctx.input.domain, reason: 'policy' } });
			}
			const normalized = ctx.input.domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
			await trace.record('activity', 'normalize-completed', { domain: ctx.input.domain, normalized });
~~~~

`isOccurrence` appears in `.agents/support/production-fixture.ts:508`:

~~~~ typescript
if (failure.isOccurrence(error)) {
									await taskQueue.fail(ctx, claim, await failure.encode(error));
									return workflow.failed(error);
								}
~~~~

`is` appears in `.agents/support/production-fixture.ts:585`:

~~~~ typescript
if (failure.is(error, DomainRejected)) {
				return problem.create(ImportRejected, { detail: error.message, instance: new URL(ctx.id, 'https://validation.invalid').pathname });
			}
			throw error;
~~~~

`match` appears in `.agents/tests/public-api-matrix.test.ts:164`:

~~~~ typescript
assert.equal(failure.match(occurrence, { [FailureA.id]: () => 'matched' }), 'matched');
		assert.equal(failure.match(occurrence, {}, () => 'fallback'), 'fallback');
		await assert.rejects(failure.decode({ id: 'missing', data: 'x', message: 'x' }, [FailureA]), failure.UnknownFailureDefinitionError);
		await assert.rejects(failure.decode({ id: 'missing', data: 'x', message: 'x' }, [FailureA]), failure.UnknownFailureDefinitionError);
~~~~

`encode` appears in `.agents/support/production-fixture.ts:509`:

~~~~ typescript
await taskQueue.fail(ctx, claim, await failure.encode(error));
									return workflow.failed(error);
								}
								await taskQueue.retry(ctx, claim);
~~~~

`decode` appears in `.agents/tests/production-e2e.test.ts:212`:

~~~~ typescript
assert.equal((await failure.decode(encoded, [Rejected])).definition, Rejected);
	});
});
~~~~

`catalog` appears in `.agents/tests/public-api-matrix.test.ts:111`:

~~~~ typescript
const failures = failure.catalog('matrix.failures', { FailureA, FailureB });
	assert.equal(failure.select(failures, ['FailureA']).FailureA, FailureA);
	assert.deepEqual(failure.compose(FailureA, failure.select(failures, ['FailureB'])), [FailureA, FailureB]);
~~~~

`Definition` appears in `utils/activity/types.ts:21`:

~~~~ typescript
readonly failures?: CatalogDefinitionInput<FailureDefinition>;
	readonly runtimes: CatalogDefinitionInput<RuntimeDefinition>;
	readonly resources?: CatalogDefinitionInput<ResourceDefinition>;
	readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
~~~~

`Occurrence` appears in `utils/activity/types.ts:56`:

~~~~ typescript
? FailureOccurrence<Failure_>
	: never;

/** One concrete activity execution context. */
~~~~

`Encoded` appears in `utils/queue/mod.ts:75`:

~~~~ typescript
readonly failure: EncodedFailure;

	constructor(itemId: string, failure: EncodedFailure) {
		super(`Queue item ${JSON.stringify(itemId)} failed: ${failure.message}`);
~~~~

@utils/failure/types
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Data` | type | Data output represented by a failure definition. | `value: Data` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Definition` | interface | Immutable declaration of one expected failure family. | `value: Definition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Encoded` | interface | Durable representation of an expected failure occurrence. | `value: Encoded` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FailureCatalog` | type | Named failure catalog. | `value: FailureCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FailureSelection` | type | Key-preserving failure catalog selection. | `value: FailureSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Occurrence` | interface | In-process occurrence of one exact expected failure definition. | `value: Occurrence` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 24 public names across 2 package export targets. 14 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

