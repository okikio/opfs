@utils/runtime public API usage
===============================

Purpose
-------

This reference maps every public export target declared by `@utils/runtime` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/runtime
--------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `.agents/tests/public-api-matrix.test.ts:106` uses `catalog`. |
| `compose` | function | Compose runtime definitions, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/production-e2e.test.ts:154` uses `compose`. |
| `define` | function | Define one immutable logical runtime. | `define(...)` | `.agents/support/production-fixture.ts:141` uses `define`. |
| `Definition` | interface | Stable logical location where activities may execute. | `value: Definition` | `utils/activity/types.ts:22` uses `Definition`. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `document` | function | Create deterministic runtime documentation. | `document(...)` | `.agents/tests/production-e2e.test.ts:154` uses `document`. |
| `Document` | interface | JSON-safe runtime documentation. | `value: Document` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `runtimeCatalog` | function | Create a named immutable runtime catalog. | `runtimeCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RuntimeCatalog` | type | Named runtime catalog. | `value: RuntimeCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RuntimeSelection` | type | Key-preserving runtime catalog selection. | `value: RuntimeSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select a key-preserving runtime catalog subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:107` uses `select`. |

Detected uses
~~~~~~~~~~~~~

`define` appears in `.agents/support/production-fixture.ts:141`:

~~~~ typescript
const AnalysisRuntime = runtime.define({ id: 'validation.analysis-thread', description: 'Synthetic analysis-thread runtime.' });
const DomainRejected = failure.define({
	id: 'validation.domain-rejected',
	description: 'The supplied domain was rejected by page admission policy.',
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:107`:

~~~~ typescript
assert.equal(runtime.select(runtimes, ['RuntimeA']).RuntimeA, RuntimeA);
	assert.deepEqual(runtime.compose(RuntimeA, runtime.select(runtimes, ['RuntimeB'])), [RuntimeA, RuntimeB]);
	assert.equal(runtime.document(runtimes).length, 2);
~~~~

`compose` appears in `.agents/tests/production-e2e.test.ts:154`:

~~~~ typescript
assert.deepEqual(runtime.document(runtime.compose(runtime.define({ id: 'validation.inline', description: 'Inline runtime.' }))), [
			{ id: 'validation.inline', description: 'Inline runtime.' },
		]);
		const Retry = resilience.retry({ maximumAttempts: 3, jitter: false });
~~~~

`document` appears in `.agents/tests/production-e2e.test.ts:154`:

~~~~ typescript
assert.deepEqual(runtime.document(runtime.compose(runtime.define({ id: 'validation.inline', description: 'Inline runtime.' }))), [
			{ id: 'validation.inline', description: 'Inline runtime.' },
		]);
		const Retry = resilience.retry({ maximumAttempts: 3, jitter: false });
~~~~

`catalog` appears in `.agents/tests/public-api-matrix.test.ts:106`:

~~~~ typescript
const runtimes = runtime.catalog('matrix.runtimes', { RuntimeA, RuntimeB });
	assert.equal(runtime.select(runtimes, ['RuntimeA']).RuntimeA, RuntimeA);
	assert.deepEqual(runtime.compose(RuntimeA, runtime.select(runtimes, ['RuntimeB'])), [RuntimeA, RuntimeB]);
	assert.equal(runtime.document(runtimes).length, 2);
~~~~

`Definition` appears in `utils/activity/types.ts:22`:

~~~~ typescript
readonly runtimes: CatalogDefinitionInput<RuntimeDefinition>;
	readonly resources?: CatalogDefinitionInput<ResourceDefinition>;
	readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly resilience?: ResilienceInput;
~~~~

@utils/runtime/types
--------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `Definition` | interface | Stable logical location where activities may execute. | `value: Definition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Document` | interface | JSON-safe runtime documentation. | `value: Document` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RuntimeCatalog` | type | Named runtime catalog. | `value: RuntimeCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RuntimeSelection` | type | Key-preserving runtime catalog selection. | `value: RuntimeSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 16 public names across 2 package export targets. 6 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

