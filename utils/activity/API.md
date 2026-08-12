@utils/activity public API usage
================================

Purpose
-------

This reference maps every public export target declared by `@utils/activity` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/activity
---------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `activityCatalog` | function | Create a named immutable activity catalog. | `activityCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ActivityCatalog` | type | Named activity catalog. | `value: ActivityCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ActivitySelection` | type | Key-preserving activity catalog selection. | `value: ActivitySelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `.agents/tests/production-e2e.test.ts:178` uses `catalog`. |
| `compose` | function | Compose activities, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:122` uses `compose`. |
| `Context` | interface | One concrete activity execution context. | `value: Context` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one immutable external-work contract. | `define(...)` | `.agents/support/production-fixture.ts:206` uses `define`. |
| `Definition` | interface | Immutable external-work contract. | `value: Definition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `document` | function | Create deterministic JSON-safe activity documentation. | `document(...)` | `.agents/tests/production-e2e.test.ts:180` uses `document`. |
| `Document` | interface | JSON-safe activity documentation. | `value: Document` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `execute` | function | Execute one concrete activity implementation immediately in the current host. | `execute(...)` | `.agents/support/production-fixture.ts:492` uses `execute`. |
| `ExecuteOptions` | interface | Inputs accepted by direct activity execution. | `value: ExecuteOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Failures` | type | Declared failure occurrence union inferred from an activity. | `value: Failures` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `implement` | function | Bind one exact activity to one concrete allowed runtime implementation. | `implement(...)` | `.agents/support/production-fixture.ts:410` uses `implement`. |
| `Implementation` | interface | Concrete implementation bound to one exact activity and runtime. | `value: Implementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ImplementationInput` | interface | Input accepted by {@link implement}. | `value: ImplementationInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Input` | type | Input value inferred from an activity definition. | `value: Input` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InvalidRuntimeError` | class | Error raised when an implementation selects a runtime the activity does not allow. | `new InvalidRuntimeError(...)` | `.agents/tests/public-api-matrix.test.ts:168` uses `InvalidRuntimeError`. |
| `isDeclaredFailure` | function | Return whether a reason is one of an activity's exact declared failures. | `isDeclaredFailure(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Resources` | type | Resource definition union declared by an activity. | `value: Resources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Result` | type | Result value inferred from an activity definition. | `value: Result` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `run` | function | Create a durable workflow operation for one activity. | `run(...)` | `.agents/support/production-fixture.ts:260` uses `run`. |
| `RunOperation` | type | Yieldable activity execution operation. | `value: RunOperation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RunOptions` | interface | Options accepted by {@link run}. | `value: RunOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Runtimes` | type | Runtime definition union allowed by an activity. | `value: Runtimes` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Schema` | type | Static schema accepted by activity definitions. | `value: Schema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select a key-preserving activity catalog subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:121` uses `select`. |
| `try` | export | Public contract documented by the source declaration. | `try` | `.agents/tests/public-api-matrix.test.ts:124` uses `try`. |
| `try_` | function | Create a durable activity operation that returns an explicit declared-failure result. | `try_(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `TryResult` | type | Explicit result returned by activity.try(). | `value: TryResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `UndeclaredFailureError` | class | Error raised when an activity throws an expected failure it did not declare. | `new UndeclaredFailureError(...)` | `.agents/tests/public-api-matrix.test.ts:170` uses `UndeclaredFailureError`. |

Detected uses
~~~~~~~~~~~~~

`InvalidRuntimeError` appears in `.agents/tests/public-api-matrix.test.ts:168`:

~~~~ typescript
assert.equal(new activity.InvalidRuntimeError('activity', 'runtime').name, 'InvalidRuntimeError');
		assert.equal(new activity.InvalidRuntimeError('activity-2', 'runtime-2').name, 'InvalidRuntimeError');
		assert.equal(new activity.UndeclaredFailureError(ActivityA, occurrence).failure, occurrence);
		assert.equal(new activity.UndeclaredFailureError(ActivityA, occurrence).activity, ActivityA);
~~~~

`UndeclaredFailureError` appears in `.agents/tests/public-api-matrix.test.ts:170`:

~~~~ typescript
assert.equal(new activity.UndeclaredFailureError(ActivityA, occurrence).failure, occurrence);
		assert.equal(new activity.UndeclaredFailureError(ActivityA, occurrence).activity, ActivityA);
		assert.equal(new resource.DefinitionConflictError(ResourceA.id, ResourceA, ResourceA).id, ResourceA.id);
		assert.equal(new resource.ImplementationConflictError(ResourceA).definition, ResourceA);
~~~~

`define` appears in `.agents/support/production-fixture.ts:206`:

~~~~ typescript
const NormalizeDomain = activity.define({
	id: 'validation.normalize-domain',
	version: '1',
	description: 'Normalize one domain through a synthetic analysis thread.',
~~~~

`implement` appears in `.agents/support/production-fixture.ts:410`:

~~~~ typescript
const NormalizeDomainLive = activity.implement(NormalizeDomain, {
		runtime: AnalysisRuntime,
		async execute(ctx) {
			await trace.record('activity', 'normalize-started', { domain: ctx.input.domain, jobId: ctx.jobId });
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:121`:

~~~~ typescript
assert.equal(activity.select(activities, ['ActivityA']).ActivityA, ActivityA);
	assert.deepEqual(activity.compose(ActivityA, activity.select(activities, ['ActivityB'])), [ActivityA, ActivityB]);
	assert.equal(activity.document(activities).length, 2);
	assert.equal(activity.try(ActivityA, 'input')[Symbol.iterator]().next().done, false);
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:122`:

~~~~ typescript
assert.deepEqual(activity.compose(ActivityA, activity.select(activities, ['ActivityB'])), [ActivityA, ActivityB]);
	assert.equal(activity.document(activities).length, 2);
	assert.equal(activity.try(ActivityA, 'input')[Symbol.iterator]().next().done, false);
~~~~

`run` appears in `.agents/support/production-fixture.ts:260`:

~~~~ typescript
yield* workflow.ensure(activity.run(CleanupImport, { id: ctx.runId }, { key: 'cleanup' }), { key: 'ensure-cleanup' });
	const normalized = yield* workflow.map(
		ctx.input.domains,
		(domain) => activity.run(NormalizeDomain, { domain, mode: ctx.input.mode }),
~~~~

`execute` appears in `.agents/support/production-fixture.ts:492`:

~~~~ typescript
? await activity.execute({ ...executeOptions, implementation: NormalizeDomainLive })
									: command.activity === PersistImport
									? await activity.execute({ ...executeOptions, implementation: PersistImportLive })
									: command.activity === CleanupImport
~~~~

`document` appears in `.agents/tests/production-e2e.test.ts:180`:

~~~~ typescript
assert.equal(activity.document(ActivityCatalog)[0]?.id, 'validation.document-activity');
		const WorkflowCatalog = workflow.workflowCatalog('validation.workflows', fixtureWorkflowDefinitions());
		assert.equal(workflow.document(WorkflowCatalog)[0]?.id, 'validation.document-workflow');
	});
~~~~

`catalog` appears in `.agents/tests/production-e2e.test.ts:178`:

~~~~ typescript
const ActivityCatalog = activity.catalog('validation.activities', fixtureActivityDefinitions());
		assert.equal(catalog.values(ActivityCatalog).length, 1);
		assert.equal(activity.document(ActivityCatalog)[0]?.id, 'validation.document-activity');
		const WorkflowCatalog = workflow.workflowCatalog('validation.workflows', fixtureWorkflowDefinitions());
~~~~

`try` appears in `.agents/tests/public-api-matrix.test.ts:124`:

~~~~ typescript
assert.equal(activity.try(ActivityA, 'input')[Symbol.iterator]().next().done, false);

	const placement = workflow.policy({ id: 'matrix.policy', activities: [ActivityA], runtime: RuntimeA });
	const workflows = workflow.catalog('matrix.workflows', { WorkflowA, WorkflowB });
~~~~

@utils/activity/types
---------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `ActivityCatalog` | type | Named activity catalog. | `value: ActivityCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ActivitySelection` | type | Key-preserving activity catalog selection. | `value: ActivitySelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Context` | interface | One concrete activity execution context. | `value: Context` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Definition` | interface | Immutable external-work contract. | `value: Definition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Document` | interface | JSON-safe activity documentation. | `value: Document` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ExecuteOptions` | interface | Inputs accepted by direct activity execution. | `value: ExecuteOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Failures` | type | Declared failure occurrence union inferred from an activity. | `value: Failures` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Implementation` | interface | Concrete implementation bound to one exact activity and runtime. | `value: Implementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ImplementationInput` | interface | Input accepted by {@link implement}. | `value: ImplementationInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Input` | type | Input value inferred from an activity definition. | `value: Input` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Resources` | type | Resource definition union declared by an activity. | `value: Resources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Result` | type | Result value inferred from an activity definition. | `value: Result` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RunOperation` | type | Yieldable activity execution operation. | `value: RunOperation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RunOptions` | interface | Options accepted by {@link run}. | `value: RunOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Runtimes` | type | Runtime definition union allowed by an activity. | `value: Runtimes` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Schema` | type | Static schema accepted by activity definitions. | `value: Schema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `TryResult` | type | Explicit result returned by activity.try(). | `value: TryResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 50 public names across 2 package export targets. 11 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

