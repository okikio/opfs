@utils/workflow public API usage
================================

Purpose
-------

This reference maps every public export target declared by `@utils/workflow` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/workflow
---------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `activity` | function | Create an activity command without importing the activity package. | `activity(...)` | `utils/activity/mod.ts:123` uses `activity`. |
| `ActivityCommand` | interface | Activity execution command. | `value: ActivityCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ActivityReference` | interface | Structural activity contract referenced by workflow instructions. | `value: ActivityReference` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ActivityRunOptions` | interface | Public options accepted by activity operations and simple commands. | `value: ActivityRunOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Annotations` | type | Instruction annotations safe to persist or expose to operators. | `value: Annotations` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `AnyCompletion` | type | Runtime-erased completion. | `value: AnyCompletion` | `.agents/support/production-fixture.ts:55` uses `AnyCompletion`. |
| `cancelled` | function | Create a cancelled completion. | `cancelled(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CancelledCompletion` | interface | Cancelled instruction completion. | `value: CancelledCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CancelledError` | class | Cancellation reported by a workflow interpreter. | `new CancelledError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `.agents/tests/public-api-matrix.test.ts:127` uses `catalog`. |
| `child` | function | Start or await one child workflow. | `child(...)` | `.agents/tests/public-api-matrix.test.ts:136` uses `child`. |
| `ChildOptions` | interface | Public options accepted by child workflow operations. | `value: ChildOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ChildWorkflowCommand` | interface | Start or await one child workflow. | `value: ChildWorkflowCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CleanupFailureError` | class | Lifecycle defect containing primary work and one or more cleanup failures. | `new CleanupFailureError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Command` | type | Leaf instructions requesting one interpreter-owned action. | `value: Command` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CommandBase` | interface | Shared leaf-command metadata. | `value: CommandBase` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CommandHandler` | type | Leaf-command execution supplied by a live runtime host. | `value: CommandHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Completion` | type | Completion returned by an interpreter for one suspended instruction. | `value: Completion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `compose` | function | Compose workflows, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:129` uses `compose`. |
| `Context` | interface | Runtime workflow context. | `value: Context` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `continue` | export | Public contract documented by the source declaration. | `continue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `continueAsNew` | function | End the current run and request an atomic continuation with new input. | `continueAsNew(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ContinueAsNewError` | class | Terminal continue-as-new request surfaced by an interpreter. | `new ContinueAsNewError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ContinueCommand` | interface | End the current run and atomically continue with new input. | `value: ContinueCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Contributions` | interface | Cross-cutting definitions retained by a workflow contract for compilation. | `value: Contributions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ControlInstruction` | type | Instructions coordinating nested operations. | `value: ControlInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ControlInstructionBase` | interface | Shared control-instruction metadata. | `value: ControlInstructionBase` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `createContext` | function | Create a validated workflow context by deriving local cancellation from a parent context. | `createContext(...)` | `.agents/support/production-fixture.ts:461` uses `createContext`. |
| `CreateContextOptions` | interface | Inputs accepted while creating one validated workflow context. | `value: CreateContextOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one immutable workflow contract. | `define(...)` | `.agents/support/production-fixture.ts:248` uses `define`. |
| `Definition` | interface | Immutable workflow contract independent from a concrete interpreter. | `value: Definition` | `utils/server/service/types.ts:74` uses `Definition`. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `describeInstruction` | function | Describe one yielded instruction as JSON-safe durable history data. | `describeInstruction(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `document` | function | Create deterministic JSON-safe workflow documentation. | `document(...)` | `.agents/tests/production-e2e.test.ts:182` uses `document`. |
| `Document` | interface | JSON-safe workflow documentation. | `value: Document` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DurableValue` | type | JSON-safe value that can be persisted as workflow history. | `value: DurableValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `emit` | function | Emit one declared progress or projection event. | `emit(...)` | `.agents/support/production-fixture.ts:259` uses `emit`. |
| `EmitCommand` | interface | Emit one declared event. | `value: EmitCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Engine` | interface | Interpreter interface used by live and durable workflow implementations. | `value: Engine` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ensure` | function | Register a cleanup operation that executes when the workflow scope closes. | `ensure(...)` | `.agents/support/production-fixture.ts:260` uses `ensure`. |
| `EnsureCommand` | interface | Register one cleanup operation for the current workflow scope. | `value: EnsureCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `event` | function | Define one immutable progress-event contract. | `event(...)` | `.agents/support/production-fixture.ts:239` uses `event`. |
| `Event` | interface | Stable event definition used by workflow progress projections. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `execute` | function | Execute one workflow program through an instruction interpreter. | `execute(...)` | `.agents/support/production-fixture.ts:552` uses `execute`. |
| `executeOperation` | function | Execute one author-facing operation outside a complete workflow program. | `executeOperation(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ExecuteOptions` | interface | Inputs accepted while executing one workflow implementation. | `value: ExecuteOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `failed` | function | Create a declared-failure completion. | `failed(...)` | `.agents/support/production-fixture.ts:510` uses `failed`. |
| `FailureCompletion` | interface | Declared instruction failure completion. | `value: FailureCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Failures` | type | Declared failure occurrence union inferred from a workflow definition. | `value: Failures` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `fault` | function | Create an unexpected-fault completion. | `fault(...)` | `.agents/support/production-fixture.ts:466` uses `fault`. |
| `FaultCompletion` | interface | Unexpected interpreter or implementation fault completion. | `value: FaultCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FaultError` | class | Unexpected fault reported by a workflow interpreter. | `new FaultError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FinalizerInstructionError` | class | Invalid workflow program behavior discovered while closing a generator. | `new FinalizerInstructionError(...)` | `.agents/tests/public-api-matrix.test.ts:366` uses `FinalizerInstructionError`. |
| `identifyInstruction` | function | Create the stable SHA-256 identity used to compare replayed instructions. | `identifyInstruction(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `implement` | function | Bind one exact workflow definition to its deterministic generator program. | `implement(...)` | `.agents/support/production-fixture.ts:258` uses `implement`. |
| `Implementation` | interface | Exact workflow implementation. | `value: Implementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Input` | type | Input value inferred from a workflow definition. | `value: Input` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Instruction` | type | Any instruction understood by a workflow interpreter. | `value: Instruction` | `utils/activity/mod.ts:138` uses `Instruction`. |
| `InstructionBase` | interface | Shared instruction metadata. | `value: InstructionBase` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionDescription` | interface | Serializable description of one yielded workflow instruction. | `value: InstructionDescription` | `.agents/support/production-fixture.ts:68` uses `InstructionDescription`. |
| `InstructionHandler` | type | Wrapper used by durable engines to record every instruction and completion. | `value: InstructionHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionHandlerInput` | interface | Input passed to an instruction lifecycle wrapper. | `value: InstructionHandlerInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionIdentity` | interface | Stable persisted identity material for one yielded workflow instruction. | `value: InstructionIdentity` | `.agents/support/production-fixture.ts:59` uses `InstructionIdentity`. |
| `live` | function | Create a live in-memory interpreter that coordinates controls and delegates leaf commands. | `live(...)` | `.agents/support/production-fixture.ts:462` uses `live`. |
| `LiveOptions` | interface | Inputs accepted by the live instruction interpreter. | `value: LiveOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `map` | function | Create either fail-fast or settled bounded mapping after overload resolution. | `map(...)` | `.agents/support/production-fixture.ts:261` uses `map`. |
| `MapEntry` | interface | One keyed operation created for a mapped input. | `value: MapEntry` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MapInstruction` | interface | Bounded keyed mapping coordination. | `value: MapInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MapOptions` | interface | Public options accepted by bounded mapping. | `value: MapOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `operation` | function | Create an author-facing operation backed by one instruction. | `operation(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Operation` | interface | Author-facing yieldable workflow value. | `value: Operation` | `utils/activity/mod.ts:131` uses `Operation`. |
| `OperationFailure` | type | Extract the failure value from an operation. | `value: OperationFailure` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationFailures` | type | Union of failures represented by a keyed operation record. | `value: OperationFailures` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Operations` | type | Keyed operation record. | `value: Operations` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationValue` | type | Extract the success value from an operation. | `value: OperationValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationValues` | type | Key-preserving operation success values. | `value: OperationValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `parallel` | function | Create either fail-fast or settled parallel coordination after overload resolution. | `parallel(...)` | `.agents/support/production-fixture.ts:267` uses `parallel`. |
| `ParallelInstruction` | interface | Keyed parallel child-operation coordination. | `value: ParallelInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ParallelOptions` | interface | Public options accepted by parallel coordination. | `value: ParallelOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `policy` | function | Define one immutable workflow activity-placement policy. | `policy(...)` | `.agents/tests/public-api-matrix.test.ts:126` uses `policy`. |
| `Policy` | interface | Immutable activity-placement policy attached to one workflow. | `value: Policy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PolicyInput` | interface | Input accepted by {@link policy}. | `value: PolicyInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Program` | type | Workflow generator program. | `value: Program` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `race` | function | Return the first terminal keyed branch and cancel the others. | `race(...)` | `.agents/tests/public-api-matrix.test.ts:137` uses `race`. |
| `RaceInstruction` | interface | First-terminal child-operation coordination. | `value: RaceInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RaceOptions` | type | Public options accepted by race coordination. | `value: RaceOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RaceResult` | type | Result returned by a race. | `value: RaceResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Result` | type | Result value inferred from a workflow definition. | `value: Result` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `retry` | function | Repeat one operation according to one explicit maximum-attempt policy. | `retry(...)` | `.agents/support/production-fixture.ts:268` uses `retry`. |
| `RetryInstruction` | interface | Repeat one operation according to one explicit policy. | `value: RetryInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RetryOptions` | interface | Public options accepted by workflow-level retry. | `value: RetryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Schema` | type | Static schema accepted by workflow definitions, signals, and events. | `value: Schema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select a key-preserving workflow catalog subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:128` uses `select`. |
| `SettledOperationValues` | type | Key-preserving settled operation values. | `value: SettledOperationValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `signal` | function | Define one immutable signal contract. | `signal(...)` | `.agents/tests/public-api-matrix.test.ts:133` uses `signal`. |
| `Signal` | interface | Stable signal definition. | `value: Signal` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `sleep` | function | Wait for a durable duration. | `sleep(...)` | `.agents/support/production-fixture.ts:273` uses `sleep`. |
| `SleepCommand` | interface | Durable sleep command. | `value: SleepCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `success` | function | Create a successful completion. | `success(...)` | `.agents/support/production-fixture.ts:499` uses `success`. |
| `SuccessCompletion` | interface | Successful instruction completion. | `value: SuccessCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `wait` | function | Wait for one matching signal value. | `wait(...)` | `.agents/tests/public-api-matrix.test.ts:135` uses `wait`. |
| `WaitCommand` | interface | Wait for one matching signal value. | `value: WaitCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `workflowCatalog` | function | Create a named immutable workflow catalog. | `workflowCatalog(...)` | `.agents/tests/production-e2e.test.ts:181` uses `workflowCatalog`. |
| `WorkflowCatalog` | type | Named workflow catalog. | `value: WorkflowCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkflowReference` | interface | Structural workflow contract referenced by child-workflow instructions. | `value: WorkflowReference` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkflowSelection` | type | Key-preserving workflow catalog selection. | `value: WorkflowSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`FinalizerInstructionError` appears in `.agents/tests/public-api-matrix.test.ts:366`:

~~~~ typescript
assert.equal(new workflow.FinalizerInstructionError(finalizerInstruction).instruction, finalizerInstruction);
		}
	});
});
~~~~

`define` appears in `.agents/support/production-fixture.ts:248`:

~~~~ typescript
const ImportWorkflow = workflow.define({
	id: 'validation.import',
	version: '1',
	description: 'Durable synthetic import workflow.',
~~~~

`implement` appears in `.agents/support/production-fixture.ts:258`:

~~~~ typescript
const ImportWorkflowImplementation = workflow.implement(ImportWorkflow, function* (ctx) {
	yield* workflow.emit(ImportProgress, { stage: 'started' }, { key: 'progress-started' });
	yield* workflow.ensure(activity.run(CleanupImport, { id: ctx.runId }, { key: 'cleanup' }), { key: 'ensure-cleanup' });
	const normalized = yield* workflow.map(
~~~~

`policy` appears in `.agents/tests/public-api-matrix.test.ts:126`:

~~~~ typescript
const placement = workflow.policy({ id: 'matrix.policy', activities: [ActivityA], runtime: RuntimeA });
	const workflows = workflow.catalog('matrix.workflows', { WorkflowA, WorkflowB });
	assert.equal(workflow.select(workflows, ['WorkflowA']).WorkflowA, WorkflowA);
	assert.deepEqual(workflow.compose(WorkflowA, workflow.select(workflows, ['WorkflowB'])), [WorkflowA, WorkflowB]);
~~~~

`workflowCatalog` appears in `.agents/tests/production-e2e.test.ts:181`:

~~~~ typescript
const WorkflowCatalog = workflow.workflowCatalog('validation.workflows', fixtureWorkflowDefinitions());
		assert.equal(workflow.document(WorkflowCatalog)[0]?.id, 'validation.document-workflow');
	});
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:128`:

~~~~ typescript
assert.equal(workflow.select(workflows, ['WorkflowA']).WorkflowA, WorkflowA);
	assert.deepEqual(workflow.compose(WorkflowA, workflow.select(workflows, ['WorkflowB'])), [WorkflowA, WorkflowB]);
	assert.equal(workflow.document(workflows).length, 2);
	assert.equal(placement.runtime, RuntimeA);
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:129`:

~~~~ typescript
assert.deepEqual(workflow.compose(WorkflowA, workflow.select(workflows, ['WorkflowB'])), [WorkflowA, WorkflowB]);
	assert.equal(workflow.document(workflows).length, 2);
	assert.equal(placement.runtime, RuntimeA);
~~~~

`signal` appears in `.agents/tests/public-api-matrix.test.ts:133`:

~~~~ typescript
const signal = workflow.signal({ id: 'matrix.signal', value: StringSchema });
	const event = workflow.event({ id: 'matrix.event', value: StringSchema });
	assert.equal(instructionOf(workflow.wait(signal, { id: 'input' })).type, 'wait');
	assert.equal(instructionOf(workflow.child(WorkflowB, 'child')).type, 'child-workflow');
~~~~

`event` appears in `.agents/support/production-fixture.ts:239`:

~~~~ typescript
const ImportProgress = workflow.event({
	id: 'validation.import-progress',
	description: 'Synthetic import workflow progress.',
	value: schema<Readonly<{ readonly stage: string }>>((value) => {
~~~~

`activity` appears in `utils/activity/mod.ts:123`:

~~~~ typescript
return workflow.activity<Result<ActivityDefinition>, Failures<ActivityDefinition>>(definition, input, options);
}

/** Create a durable activity operation that returns an explicit declared-failure result. */
~~~~

`sleep` appears in `.agents/support/production-fixture.ts:273`:

~~~~ typescript
settledAt: workflow.sleep({ milliseconds: 1 }, { key: 'settle-delay' }),
	}, { concurrency: 2, key: 'finalize' });
	yield* workflow.emit(ImportProgress, { stage: 'completed' }, { key: 'progress-completed' });
	return Object.freeze({ ...work.persisted, normalizedDomains });
~~~~

`wait` appears in `.agents/tests/public-api-matrix.test.ts:135`:

~~~~ typescript
assert.equal(instructionOf(workflow.wait(signal, { id: 'input' })).type, 'wait');
	assert.equal(instructionOf(workflow.child(WorkflowB, 'child')).type, 'child-workflow');
	assert.equal(instructionOf(workflow.race({ one: workflow.emit(event, 'value'), two: workflow.sleep('PT0.001S') })).type, 'race');
}
~~~~

`child` appears in `.agents/tests/public-api-matrix.test.ts:136`:

~~~~ typescript
assert.equal(instructionOf(workflow.child(WorkflowB, 'child')).type, 'child-workflow');
	assert.equal(instructionOf(workflow.race({ one: workflow.emit(event, 'value'), two: workflow.sleep('PT0.001S') })).type, 'race');
}
~~~~

`emit` appears in `.agents/support/production-fixture.ts:259`:

~~~~ typescript
yield* workflow.emit(ImportProgress, { stage: 'started' }, { key: 'progress-started' });
	yield* workflow.ensure(activity.run(CleanupImport, { id: ctx.runId }, { key: 'cleanup' }), { key: 'ensure-cleanup' });
	const normalized = yield* workflow.map(
		ctx.input.domains,
~~~~

`ensure` appears in `.agents/support/production-fixture.ts:260`:

~~~~ typescript
yield* workflow.ensure(activity.run(CleanupImport, { id: ctx.runId }, { key: 'cleanup' }), { key: 'ensure-cleanup' });
	const normalized = yield* workflow.map(
		ctx.input.domains,
		(domain) => activity.run(NormalizeDomain, { domain, mode: ctx.input.mode }),
~~~~

`parallel` appears in `.agents/support/production-fixture.ts:267`:

~~~~ typescript
const work = yield* workflow.parallel({
		persisted: workflow.retry(activity.run(PersistImport, {
			id: ctx.runId,
			request: ctx.input,
~~~~

`race` appears in `.agents/tests/public-api-matrix.test.ts:137`:

~~~~ typescript
assert.equal(instructionOf(workflow.race({ one: workflow.emit(event, 'value'), two: workflow.sleep('PT0.001S') })).type, 'race');
}

function runDefinitionErrorAssertions(): void {
~~~~

`map` appears in `.agents/support/production-fixture.ts:261`:

~~~~ typescript
const normalized = yield* workflow.map(
		ctx.input.domains,
		(domain) => activity.run(NormalizeDomain, { domain, mode: ctx.input.mode }),
		{ concurrency: 3, key: (domain, index) => `${index}:${domain}`, instructionKey: 'normalize-domains' },
~~~~

`retry` appears in `.agents/support/production-fixture.ts:268`:

~~~~ typescript
persisted: workflow.retry(activity.run(PersistImport, {
			id: ctx.runId,
			request: ctx.input,
			normalizedDomains,
~~~~

`createContext` appears in `.agents/support/production-fixture.ts:461`:

~~~~ typescript
await using workflowContext = await workflow.createContext({ definition: ImportWorkflow, runId: id, input: request, ctx: parentContext });
				const engine = workflow.live({
					async command(ctx, command, path) {
						if (command.type === 'activity') {
~~~~

`execute` appears in `.agents/support/production-fixture.ts:552`:

~~~~ typescript
return await workflow.execute({ ctx: workflowContext, implementation: ImportWorkflowImplementation, engine });
			};
			try {
				return await run();
~~~~

`live` appears in `.agents/support/production-fixture.ts:462`:

~~~~ typescript
const engine = workflow.live({
					async command(ctx, command, path) {
						if (command.type === 'activity') {
							if (request.mode === 'crash-once' && crashed && !recovering && command.activity === CleanupImport) {
~~~~

`success` appears in `.agents/support/production-fixture.ts:499`:

~~~~ typescript
const completion = workflow.success(result);
								durableTasks.set(durableTaskKey, Object.freeze({ completion }));
								return completion;
							} catch (error) {
~~~~

`failed` appears in `.agents/support/production-fixture.ts:510`:

~~~~ typescript
return workflow.failed(error);
								}
								await taskQueue.retry(ctx, claim);
								return workflow.fault(error);
~~~~

`fault` appears in `.agents/support/production-fixture.ts:466`:

~~~~ typescript
return workflow.fault(new Error('Synthetic coordinator is unavailable during crash recovery.'));
							}
							const durableTaskKey = executionKey(id, path);
							const cached = durableTasks.get(durableTaskKey);
~~~~

`document` appears in `.agents/tests/production-e2e.test.ts:182`:

~~~~ typescript
assert.equal(workflow.document(WorkflowCatalog)[0]?.id, 'validation.document-workflow');
	});

	it('uses the same utility contracts in pathological scenarios and preserves typed failure behavior', async () => {
~~~~

`catalog` appears in `.agents/tests/public-api-matrix.test.ts:127`:

~~~~ typescript
const workflows = workflow.catalog('matrix.workflows', { WorkflowA, WorkflowB });
	assert.equal(workflow.select(workflows, ['WorkflowA']).WorkflowA, WorkflowA);
	assert.deepEqual(workflow.compose(WorkflowA, workflow.select(workflows, ['WorkflowB'])), [WorkflowA, WorkflowB]);
	assert.equal(workflow.document(workflows).length, 2);
~~~~

`Definition` appears in `utils/server/service/types.ts:74`:

~~~~ typescript
readonly workflows: readonly WorkflowDefinition[];
	readonly policies: readonly ServicePolicy[];
}
~~~~

`InstructionDescription` appears in `.agents/support/production-fixture.ts:68`:

~~~~ typescript
readonly description: workflow.InstructionDescription;
	readonly completion: Readonly<Record<string, unknown>>;
}
~~~~

`InstructionIdentity` appears in `.agents/support/production-fixture.ts:59`:

~~~~ typescript
readonly identity: workflow.InstructionIdentity;
	readonly completion: workflow.AnyCompletion;
}
~~~~

`Instruction` appears in `utils/activity/mod.ts:138`:

~~~~ typescript
*[Symbol.iterator](): Generator<workflow.Instruction, TryResult<ActivityDefinition>, workflow.AnyCompletion> {
			try {
				return resultCore.ok(yield* run(definition, input, options));
			} catch (reason) {
~~~~

`AnyCompletion` appears in `.agents/support/production-fixture.ts:55`:

~~~~ typescript
readonly completion: workflow.AnyCompletion;
}

interface JournalEntry {
~~~~

`Operation` appears in `utils/activity/mod.ts:131`:

~~~~ typescript
): workflow.Operation<TryResult<ActivityDefinition>, never> {
	return Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
~~~~

@utils/workflow/types
---------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `ActivityCommand` | interface | Activity execution command. | `value: ActivityCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ActivityReference` | interface | Structural activity contract referenced by workflow instructions. | `value: ActivityReference` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ActivityRunOptions` | interface | Public options accepted by activity operations and simple commands. | `value: ActivityRunOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Annotations` | type | Instruction annotations safe to persist or expose to operators. | `value: Annotations` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `AnyCompletion` | type | Runtime-erased completion. | `value: AnyCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CancelledCompletion` | interface | Cancelled instruction completion. | `value: CancelledCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ChildOptions` | interface | Public options accepted by child workflow operations. | `value: ChildOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ChildWorkflowCommand` | interface | Start or await one child workflow. | `value: ChildWorkflowCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Command` | type | Leaf instructions requesting one interpreter-owned action. | `value: Command` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CommandBase` | interface | Shared leaf-command metadata. | `value: CommandBase` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CommandHandler` | type | Leaf-command execution supplied by a live runtime host. | `value: CommandHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Completion` | type | Completion returned by an interpreter for one suspended instruction. | `value: Completion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Context` | interface | Runtime workflow context. | `value: Context` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ContinueCommand` | interface | End the current run and atomically continue with new input. | `value: ContinueCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Contributions` | interface | Cross-cutting definitions retained by a workflow contract for compilation. | `value: Contributions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ControlInstruction` | type | Instructions coordinating nested operations. | `value: ControlInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ControlInstructionBase` | interface | Shared control-instruction metadata. | `value: ControlInstructionBase` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CreateContextOptions` | interface | Inputs accepted while creating one validated workflow context. | `value: CreateContextOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Definition` | interface | Immutable workflow contract independent from a concrete interpreter. | `value: Definition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinitionInput` | interface | Input accepted by {@link define}. | `value: DefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Document` | interface | JSON-safe workflow documentation. | `value: Document` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DurableValue` | type | JSON-safe value that can be persisted as workflow history. | `value: DurableValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmitCommand` | interface | Emit one declared event. | `value: EmitCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Engine` | interface | Interpreter interface used by live and durable workflow implementations. | `value: Engine` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EnsureCommand` | interface | Register one cleanup operation for the current workflow scope. | `value: EnsureCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Event` | interface | Stable event definition used by workflow progress projections. | `value: Event` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ExecuteOptions` | interface | Inputs accepted while executing one workflow implementation. | `value: ExecuteOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FailureCompletion` | interface | Declared instruction failure completion. | `value: FailureCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Failures` | type | Declared failure occurrence union inferred from a workflow definition. | `value: Failures` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `FaultCompletion` | interface | Unexpected interpreter or implementation fault completion. | `value: FaultCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Implementation` | interface | Exact workflow implementation. | `value: Implementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Input` | type | Input value inferred from a workflow definition. | `value: Input` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Instruction` | type | Any instruction understood by a workflow interpreter. | `value: Instruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionBase` | interface | Shared instruction metadata. | `value: InstructionBase` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionDescription` | interface | Serializable description of one yielded workflow instruction. | `value: InstructionDescription` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionHandler` | type | Wrapper used by durable engines to record every instruction and completion. | `value: InstructionHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionHandlerInput` | interface | Input passed to an instruction lifecycle wrapper. | `value: InstructionHandlerInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InstructionIdentity` | interface | Stable persisted identity material for one yielded workflow instruction. | `value: InstructionIdentity` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `LiveOptions` | interface | Inputs accepted by the live instruction interpreter. | `value: LiveOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MapEntry` | interface | One keyed operation created for a mapped input. | `value: MapEntry` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MapInstruction` | interface | Bounded keyed mapping coordination. | `value: MapInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MapOptions` | interface | Public options accepted by bounded mapping. | `value: MapOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Operation` | interface | Author-facing yieldable workflow value. | `value: Operation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationFailure` | type | Extract the failure value from an operation. | `value: OperationFailure` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationFailures` | type | Union of failures represented by a keyed operation record. | `value: OperationFailures` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Operations` | type | Keyed operation record. | `value: Operations` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationValue` | type | Extract the success value from an operation. | `value: OperationValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationValues` | type | Key-preserving operation success values. | `value: OperationValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ParallelInstruction` | interface | Keyed parallel child-operation coordination. | `value: ParallelInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ParallelOptions` | interface | Public options accepted by parallel coordination. | `value: ParallelOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Policy` | interface | Immutable activity-placement policy attached to one workflow. | `value: Policy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PolicyInput` | interface | Input accepted by {@link policy}. | `value: PolicyInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Program` | type | Workflow generator program. | `value: Program` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RaceInstruction` | interface | First-terminal child-operation coordination. | `value: RaceInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RaceOptions` | type | Public options accepted by race coordination. | `value: RaceOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RaceResult` | type | Result returned by a race. | `value: RaceResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Result` | type | Result value inferred from a workflow definition. | `value: Result` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RetryInstruction` | interface | Repeat one operation according to one explicit policy. | `value: RetryInstruction` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RetryOptions` | interface | Public options accepted by workflow-level retry. | `value: RetryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Schema` | type | Static schema accepted by workflow definitions, signals, and events. | `value: Schema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SettledOperationValues` | type | Key-preserving settled operation values. | `value: SettledOperationValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `Signal` | interface | Stable signal definition. | `value: Signal` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SleepCommand` | interface | Durable sleep command. | `value: SleepCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SuccessCompletion` | interface | Successful instruction completion. | `value: SuccessCompletion` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WaitCommand` | interface | Wait for one matching signal value. | `value: WaitCommand` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkflowCatalog` | type | Named workflow catalog. | `value: WorkflowCatalog` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkflowReference` | interface | Structural workflow contract referenced by child-workflow instructions. | `value: WorkflowReference` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `WorkflowSelection` | type | Key-preserving workflow catalog selection. | `value: WorkflowSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 174 public names across 2 package export targets. 33 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

