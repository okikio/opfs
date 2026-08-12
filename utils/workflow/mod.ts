/**
 * Deterministic iterator workflow definitions, instructions, controls, and interpreter.
 *
 * The generic interpreter owns orchestration semantics. Durable storage, claims,
 * timers, queues, and provider work belong in concrete packages.
 *
 * @module
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import * as catalogCore from '@utils/catalog';
import type { CatalogEntryIdentity, DefinitionInput as CatalogDefinitionInput } from '@utils/catalog';
import * as contextCore from '@utils/context';
import * as result from '@utils/result';
import * as schema from '@utils/schema';
import { Branch as LocalBranch, operation as localOperation, Reducer as LocalReducer, Scope as LocalScope } from './internal/mod.ts';
import type { Cause as LocalCause, Exit as LocalExit } from './internal/mod.ts';

import type {
	ActivityCommand,
	ActivityReference,
	ActivityRunOptions,
	Annotations,
	AnyCompletion,
	CancelledCompletion,
	ChildOptions,
	ChildWorkflowCommand,
	Command,
	Completion,
	Context,
	ControlInstruction,
	CreateContextOptions,
	Definition,
	DefinitionInput,
	Document,
	DurableValue,
	EmitCommand,
	Engine,
	EnsureCommand,
	Event,
	ExecuteOptions,
	FailureCompletion,
	FaultCompletion,
	Implementation,
	LiveOptions,
	Instruction,
	InstructionDescription,
	InstructionIdentity,
	MapEntry,
	MapInstruction,
	MapOptions,
	Operation,
	OperationFailures,
	Operations,
	OperationValues,
	ParallelInstruction,
	ParallelOptions,
	Policy,
	PolicyInput,
	RaceInstruction,
	RaceOptions,
	RaceResult,
	RetryInstruction,
	RetryOptions,
	SettledOperationValues,
	Signal,
	SleepCommand,
	SuccessCompletion,
	WaitCommand,
	WorkflowCatalog,
	WorkflowReference,
	WorkflowSelection,
} from './types.ts';

const builtInInstructionVersion = 1;
const operationInstructions = new WeakMap<object, Instruction>();

/** Unexpected fault reported by a workflow interpreter. */
export class FaultError extends Error {
	readonly fault: unknown;

	constructor(fault: unknown) {
		super(fault instanceof Error ? fault.message : 'Workflow instruction faulted.', { cause: fault });
		this.name = 'FaultError';
		this.fault = fault;
	}
}

/** Cancellation reported by a workflow interpreter. */
export class CancelledError extends Error {
	readonly reason: unknown;

	constructor(reason: unknown) {
		super('Workflow instruction was cancelled.', reason === undefined ? undefined : { cause: reason });
		this.name = 'CancelledError';
		this.reason = reason;
	}
}

/** Terminal continue-as-new request surfaced by an interpreter. */
export class ContinueAsNewError extends Error {
	readonly input: unknown;

	constructor(input: unknown) {
		super('Workflow requested continue as new.');
		this.name = 'ContinueAsNewError';
		this.input = input;
	}
}

/** Lifecycle defect containing primary work and one or more cleanup failures. */
export class CleanupFailureError extends Error {
	readonly primary: unknown;
	readonly cleanupFailures: readonly unknown[];

	constructor(primary: unknown, cleanupFailures: readonly unknown[]) {
		super('Workflow work failed and one or more required cleanups also failed.', { cause: primary });
		this.name = 'CleanupFailureError';
		this.primary = primary;
		this.cleanupFailures = Object.freeze([...cleanupFailures]);
	}
}

/** Invalid workflow program behavior discovered while closing a generator. */
export class FinalizerInstructionError extends Error {
	readonly instruction: Instruction;

	constructor(instruction: Instruction) {
		super('Workflow generator finalizers must not yield instructions. Register external cleanup with workflow.ensure().');
		this.name = 'FinalizerInstructionError';
		this.instruction = instruction;
	}
}

/**
 * Owns the internal sibling cancellation state used by the durable workflow interpreter.
 *
 * @internal
 */
class SiblingCancellation {
	readonly reason: unknown;

	constructor(reason: unknown) {
		this.reason = reason;
	}
}

/** Define one immutable workflow contract. */
export function define<const Authoring extends DefinitionInput>(input: Authoring): Definition<Authoring> {
	assertIdentifier(input.id, 'workflow');
	assertIdentifier(input.version, 'workflow version');
	schema.assert(input.input, 'workflow input schema');
	schema.assert(input.result, 'workflow result schema');
	const failures = input.failures === undefined ? Object.freeze([]) : catalogCore.compose(input.failures);
	const activities = input.activities === undefined ? Object.freeze([]) : catalogCore.compose(input.activities);
	const workflows = input.workflows === undefined ? Object.freeze([]) : catalogCore.compose(input.workflows);
	const policies = Object.freeze([...(input.policies ?? [])]);
	return Object.freeze({
		kind: 'workflow',
		id: input.id,
		version: input.version,
		...(input.description === undefined ? {} : { description: input.description }),
		input: input.input,
		result: input.result,
		failures,
		activities,
		workflows,
		policies,
		...(input.permissions === undefined ? {} : { permissions: snapshotInput(input.permissions) }),
		...(input.entitlements === undefined ? {} : { entitlements: snapshotInput(input.entitlements) }),
		...(input.billing === undefined ? {} : { billing: snapshotInput(input.billing) }),
	}) as Definition<Authoring>;
}

/** Bind one exact workflow definition to its deterministic generator program. */
export function implement<WorkflowDefinition extends Definition>(
	definition: WorkflowDefinition,
	program: Implementation<WorkflowDefinition>['program'],
): Implementation<WorkflowDefinition> {
	if (typeof program !== 'function') throw new TypeError('Workflow implementation must provide a generator program.');
	return Object.freeze({ definition, program });
}

/** Define one immutable workflow activity-placement policy. */
export function policy(input: PolicyInput): Policy {
	assertIdentifier(input.id, 'workflow policy');
	if (input.runtime.kind !== 'runtime') throw new TypeError('Workflow policy runtime must be a runtime definition.');
	return Object.freeze({
		kind: 'workflow-policy',
		id: input.id,
		...(input.description === undefined ? {} : { description: input.description }),
		activities: Object.freeze(catalogCore.compose(input.activities)),
		runtime: input.runtime,
	});
}

/** Create a named immutable workflow catalog. */
export function workflowCatalog<
	const Namespace extends string,
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
>(namespace: Namespace, entries: Entries): WorkflowCatalog<Entries> {
	return catalogCore.create(namespace, entries);
}

/** Select a key-preserving workflow catalog subset. */
export function select<
	const Entries extends Readonly<Record<PropertyKey, Definition>>,
	const Keys extends readonly (keyof Entries & string)[],
>(
	source: WorkflowCatalog<Entries>,
	keys: Keys,
): WorkflowSelection<Entries[keyof Entries], Pick<Entries, Keys[number]>> {
	return catalogCore.select(source, keys);
}

/** Compose workflows, catalogs, selections, and nested arrays. */
export function compose<Entry extends Definition>(...input: readonly CatalogDefinitionInput<Entry>[]): readonly Entry[] {
	return catalogCore.compose(...input);
}

/** Define one immutable signal contract. */
export function signal<Value>(input: Readonly<{
	readonly id: string;
	readonly description?: string;
	readonly value: StandardSchemaV1<unknown, Value>;
}>): Signal<Value> {
	assertIdentifier(input.id, 'workflow signal');
	schema.assert(input.value, 'workflow signal schema');
	return Object.freeze({ kind: 'workflow-signal', ...input });
}

/** Define one immutable progress-event contract. */
export function event<Value>(input: Readonly<{
	readonly id: string;
	readonly description?: string;
	readonly value: StandardSchemaV1<unknown, Value>;
}>): Event<Value> {
	assertIdentifier(input.id, 'workflow event');
	schema.assert(input.value, 'workflow event schema');
	return Object.freeze({ kind: 'workflow-event', ...input });
}

/** Create an author-facing operation backed by one instruction. */
export function operation<Value, Failure = never>(instruction: Instruction): Operation<Value, Failure> {
	assertInstruction(instruction);
	const value = Object.freeze({
		/**
		 * Returns the native iterator view used by synchronous iteration protocols.
		 *
		 * @internal
		 */
		*[Symbol.iterator](): Generator<Instruction, Value, AnyCompletion> {
			const completion = yield instruction;
			if (completion.type === 'success') return completion.value as Value;
			if (completion.type === 'failure') throw completion.failure;
			if (completion.type === 'fault') throw new FaultError(completion.fault);
			throw new CancelledError(completion.reason);
		},
	});
	operationInstructions.set(value, instruction);
	return value;
}

/** Create an activity command without importing the activity package. */
export function activity<Value, Failure>(
	definition: ActivityReference,
	input: unknown,
	options: ActivityRunOptions = {},
): Operation<Value, Failure> {
	const command: ActivityCommand<Value, Failure> = Object.freeze({
		category: 'command',
		type: 'activity',
		version: builtInInstructionVersion,
		activity: definition,
		input: durable(input, 'activity input'),
		options: Object.freeze({ ...options }),
		...instructionMetadata(options),
	});
	return operation(command);
}

/** Wait for a durable duration. */
export function sleep(duration: Temporal.DurationLike | string, options: ActivityRunOptions = {}): Operation<Temporal.Instant> {
	const command: SleepCommand = Object.freeze({
		category: 'command',
		type: 'sleep',
		version: builtInInstructionVersion,
		duration: Temporal.Duration.from(duration),
		...instructionMetadata(options),
	});
	return operation(command);
}

/** Wait for one matching signal value. */
export function wait<Value>(definition: Signal<Value>, input: unknown, options: ActivityRunOptions = {}): Operation<Value> {
	const command: WaitCommand<Value> = Object.freeze({
		category: 'command',
		type: 'wait',
		version: builtInInstructionVersion,
		signal: definition,
		input: durable(input, 'wait input'),
		...instructionMetadata(options),
	});
	return operation(command);
}

/** Start or await one child workflow. */
export function child<WorkflowDefinition extends WorkflowReference>(
	definition: WorkflowDefinition,
	input: import('./types.ts').Input<WorkflowDefinition>,
	options: ChildOptions = {},
): Operation<import('./types.ts').Result<WorkflowDefinition>, import('./types.ts').Failures<WorkflowDefinition>> {
	const command: ChildWorkflowCommand = Object.freeze({
		category: 'command',
		type: 'child-workflow',
		version: builtInInstructionVersion,
		workflow: definition,
		input: durable(input, 'child workflow input'),
		options: Object.freeze({ ...options }),
		...instructionMetadata(options),
	});
	return operation(command);
}

/** Emit one declared progress or projection event. */
export function emit<Value>(definition: Event<Value>, value: Value, options: ActivityRunOptions = {}): Operation<void> {
	const command: EmitCommand = Object.freeze({
		category: 'command',
		type: 'emit',
		version: builtInInstructionVersion,
		event: definition,
		value: durable(value, 'event value'),
		...instructionMetadata(options),
	});
	return operation(command);
}

/** Register a cleanup operation that executes when the workflow scope closes. */
export function ensure(cleanup: Operation<void, unknown>, options: ActivityRunOptions = {}): Operation<void> {
	const cleanupInstruction = createdInstruction(cleanup, 'workflow.ensure cleanup');
	if (cleanupInstruction.category !== 'command' || (cleanupInstruction.type !== 'activity' && cleanupInstruction.type !== 'child-workflow')) {
		throw new TypeError('workflow.ensure cleanup must be one activity or child-workflow operation.');
	}
	const command: EnsureCommand = Object.freeze({
		category: 'command',
		type: 'ensure',
		version: builtInInstructionVersion,
		cleanup: cleanupInstruction,
		...instructionMetadata(options),
	});
	return operation(command);
}

/** End the current run and request an atomic continuation with new input. */
export function continueAsNew<Input>(input: Input, options: ActivityRunOptions = {}): Operation<never> {
	const command: import('./types.ts').ContinueCommand = Object.freeze({
		category: 'command',
		type: 'continue',
		version: builtInInstructionVersion,
		input: durable(input, 'continue-as-new input'),
		...instructionMetadata(options),
	});
	return operation(command);
}

/** Coordinate keyed child operations in parallel. */
export function parallel<Values extends Operations>(
	operations: Values,
	options?: ParallelOptions & Readonly<{ readonly failure?: 'fail-fast' }>,
): Operation<OperationValues<Values>, OperationFailures<Values>>;
/** Coordinate keyed child operations and return explicit results for every branch. */
export function parallel<Values extends Operations>(
	operations: Values,
	options: ParallelOptions & Readonly<{ readonly failure: 'settle' }>,
): Operation<SettledOperationValues<Values>, never>;
/** Create either fail-fast or settled parallel coordination after overload resolution. */
export function parallel<Values extends Operations>(operations: Values, options: ParallelOptions = {}): Operation<unknown, unknown> {
	assertOperations(operations);
	const instruction: ParallelInstruction<Values> = Object.freeze({
		category: 'control',
		type: 'parallel',
		version: builtInInstructionVersion,
		operations: freezeRecord(operations),
		failure: options.failure ?? 'fail-fast',
		...(options.concurrency === undefined ? {} : { concurrency: positiveInteger(options.concurrency, 'parallel concurrency') }),
		...instructionMetadata(options),
	});
	return operation(instruction);
}

/** Return the first terminal keyed branch and cancel the others. */
export function race<Values extends Operations>(operations: Values, options: RaceOptions = {}): Operation<RaceResult<Values>, OperationFailures<Values>> {
	assertOperations(operations);
	const instruction: RaceInstruction<Values> = Object.freeze({
		category: 'control',
		type: 'race',
		version: builtInInstructionVersion,
		operations: freezeRecord(operations),
		...instructionMetadata(options),
	});
	return operation(instruction);
}

/** Create and coordinate one bounded keyed operation for every input item. */
export function map<Item, Value, Failure>(
	items: readonly Item[],
	createOperation: (item: Item, index: number) => Operation<Value, Failure>,
	options: MapOptions<Item> & Readonly<{ readonly failure?: 'fail-fast' }>,
): Operation<readonly Value[], Failure>;
/** Create bounded mapped operations and return explicit results for every item. */
export function map<Item, Value, Failure>(
	items: readonly Item[],
	createOperation: (item: Item, index: number) => Operation<Value, Failure>,
	options: MapOptions<Item> & Readonly<{ readonly failure: 'settle' }>,
): Operation<readonly result.Result<Value, Failure>[], never>;
/** Create either fail-fast or settled bounded mapping after overload resolution. */
export function map<Item, Value, Failure>(
	items: readonly Item[],
	createOperation: (item: Item, index: number) => Operation<Value, Failure>,
	options: MapOptions<Item>,
): Operation<unknown, unknown> {
	const keys = new Set<string>();
	const entries = Object.freeze(items.map((item, index): MapEntry<Value, Failure> => {
		const key = options.key(item, index);
		assertStableKey(key);
		if (keys.has(key)) throw new TypeError(`Workflow map produced duplicate key ${JSON.stringify(key)}.`);
		keys.add(key);
		const childOperation = createOperation(item, index);
		assertOperation(childOperation);
		return Object.freeze({ key, operation: childOperation });
	}));
	const instruction: MapInstruction<Value, Failure> = Object.freeze({
		category: 'control',
		type: 'map',
		version: builtInInstructionVersion,
		entries,
		concurrency: positiveInteger(options.concurrency, 'map concurrency'),
		failure: options.failure ?? 'fail-fast',
		...(options.instructionKey === undefined ? {} : { key: options.instructionKey }),
		...(options.annotations === undefined ? {} : { annotations: freezeAnnotations(options.annotations) }),
	});
	return operation(instruction);
}

/** Repeat one operation according to one explicit maximum-attempt policy. */
export function retry<Value, Failure>(childOperation: Operation<Value, Failure>, options: RetryOptions): Operation<Value, Failure> {
	assertOperation(childOperation);
	const delay = options.delay === undefined ? undefined : Temporal.Duration.from(options.delay);
	const maximumDelay = options.maximumDelay === undefined ? undefined : Temporal.Duration.from(options.maximumDelay);
	const backoff = options.backoff ?? 1;
	if (!Number.isFinite(backoff) || backoff < 1) throw new TypeError('retry backoff must be a finite number greater than or equal to 1.');
	const jitter = options.jitter ?? 0;
	if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new TypeError('retry jitter must be between 0 and 1.');
	if (delay === undefined && (maximumDelay !== undefined || backoff !== 1 || jitter !== 0)) {
		throw new TypeError('retry maximumDelay, backoff, and jitter require retry delay.');
	}
	const instruction: RetryInstruction<Value, Failure> = Object.freeze({
		category: 'control',
		type: 'retry',
		version: builtInInstructionVersion,
		operation: childOperation,
		maximumAttempts: positiveInteger(options.maximumAttempts, 'retry maximumAttempts'),
		...(delay === undefined ? {} : { delay }),
		backoff,
		...(maximumDelay === undefined ? {} : { maximumDelay }),
		jitter,
		...instructionMetadata(options),
	});
	return operation(instruction);
}

/** Create a validated workflow context by deriving local cancellation from a parent context. */
export async function createContext<WorkflowDefinition extends Definition>(
	options: CreateContextOptions<WorkflowDefinition>,
): Promise<Context<WorkflowDefinition> & AsyncDisposable> {
	assertIdentifier(options.runId, 'workflow run');
	const input = await schema.parse(options.definition.input, options.input) as import('./types.ts').Input<WorkflowDefinition>;
	const owned = contextCore.child(options.ctx, { id: options.runId });
	return Object.freeze({
		id: owned.id,
		...(owned.traceId === undefined ? {} : { traceId: owned.traceId }),
		...(owned.deploymentId === undefined ? {} : { deploymentId: owned.deploymentId }),
		...(owned.idempotencyKey === undefined ? {} : { idempotencyKey: owned.idempotencyKey }),
		startedAt: owned.startedAt,
		...(owned.deadline === undefined ? {} : { deadline: owned.deadline }),
		signal: owned.signal,
		clock: owned.clock,
		workflow: options.definition,
		runId: options.runId,
		input,
		version: options.definition.version,
		/**
		 * Releases owned state and waits for cleanup completion when used with `await using`.
		 *
		 * @internal
		 */
		async [Symbol.asyncDispose]() { await owned[Symbol.asyncDispose](); },
	});
}

/** Execute one workflow program through an instruction interpreter. */
export async function execute<WorkflowDefinition extends Definition>(
	options: ExecuteOptions<WorkflowDefinition>,
): Promise<import('./types.ts').Result<WorkflowDefinition>> {
	if (options.implementation.definition !== options.ctx.workflow) {
		throw new TypeError('Workflow implementation and context must reference the same exact definition.');
	}
	const cleanups: Operation<void, unknown>[] = [];
	let primaryFailure: unknown;
	let hasPrimaryFailure = false;
	let value: import('./types.ts').Result<WorkflowDefinition> | undefined;
	try {
		const unvalidated = await driveIterator(
			options.implementation.program(options.ctx),
			options.ctx,
			options.engine,
			`${options.ctx.workflow.id}@${options.ctx.version}`,
			cleanups,
		);
		value = await schema.parse(options.ctx.workflow.result, unvalidated) as import('./types.ts').Result<WorkflowDefinition>;
	} catch (error) {
		primaryFailure = error;
		hasPrimaryFailure = true;
	}

	const cleanupFailures = await executeCleanups(cleanups, options.ctx, options.engine);
	if (hasPrimaryFailure) {
		if (cleanupFailures.length > 0) throw new CleanupFailureError(primaryFailure, cleanupFailures);
		throw primaryFailure;
	}
	if (cleanupFailures.length > 0) {
		throw new AggregateError(cleanupFailures, 'Workflow completed, but one or more required cleanups failed.');
	}
	return value!;
}

/** Execute one author-facing operation outside a complete workflow program. */
export async function executeOperation<Value, Failure>(
	childOperation: Operation<Value, Failure>,
	ctx: Context,
	engine: Engine,
	path = `${ctx.workflow.id}@${ctx.version}/operation`,
): Promise<Value> {
	assertOperation(childOperation);
	return await driveIterator(childOperation[Symbol.iterator](), ctx, engine, path, []);
}

/** Create a live in-memory interpreter that coordinates controls and delegates leaf commands. */
export function live(input: LiveOptions): Engine {
	let engine!: Engine;
	engine = Object.freeze({
		/**
		 * Executes work as one finite phase of the module runtime.
		 *
		 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
		 *
		 * @internal
		 */
		async execute(ctx: Context, instruction: Instruction, path: string) {
			const next = async (): Promise<AnyCompletion> => {
				if (instruction.category === 'control') return await executeControl(ctx, instruction, path, engine);
				if (instruction.type === 'ensure') return success(undefined);
				if (instruction.type === 'continue') throw new ContinueAsNewError(instruction.input);
				try {
					return await input.command(ctx, instruction, path);
				} catch (error) {
					return fault(error);
				}
			};
			if (input.instruction === undefined) return await next();
			const identity = await identifyInstruction(instruction, path);
			return await input.instruction({ ctx, instruction, path, identity, next });
		},
	});
	return engine;
}

/** Create a successful completion. */
export function success<Value>(value: Value): SuccessCompletion<Value> {
	return Object.freeze({ type: 'success', value });
}

/** Create a declared-failure completion. */
export function failed<Failure>(failure: Failure): FailureCompletion<Failure> {
	return Object.freeze({ type: 'failure', failure });
}

/** Create an unexpected-fault completion. */
export function fault(fault_: unknown): FaultCompletion {
	return Object.freeze({ type: 'fault', fault: fault_ });
}

/** Create a cancelled completion. */
export function cancelled(reason: unknown): CancelledCompletion {
	return Object.freeze({ type: 'cancelled', reason });
}

/**
 * Describe one yielded instruction as JSON-safe durable history data.
 *
 * The description stores exact definition identities and serializable input,
 * but it never stores schemas, generator objects, resource handles, or child
 * operation closures. Control children are verified at their own deterministic
 * paths when the interpreter enters them.
 */
export function describeInstruction(instruction: Instruction, path: string): InstructionDescription {
	assertInstruction(instruction);
	if (path.trim().length === 0) throw new TypeError('Workflow instruction path must not be empty.');
	return Object.freeze({
		path,
		category: instruction.category,
		type: instruction.type,
		version: instruction.version,
		...(instruction.key === undefined ? {} : { key: instruction.key }),
		...(instruction.annotations === undefined ? {} : { annotations: instruction.annotations }),
		payload: describeInstructionPayload(instruction),
	});
}

/**
 * Create the stable SHA-256 identity used to compare replayed instructions.
 *
 * A durable adapter persists this identity before it dispatches external work.
 * On replay, the adapter compares the newly yielded fingerprint with history.
 * A mismatch is workflow divergence and must fail instead of dispatching new
 * work under an old history position.
 */
export async function identifyInstruction(instruction: Instruction, path: string): Promise<InstructionIdentity> {
	const description = describeInstruction(instruction, path);
	const encoded = new TextEncoder().encode(JSON.stringify(description));
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
	const fingerprint = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return Object.freeze({ description, fingerprint });
}

/** Create deterministic JSON-safe workflow documentation. */
export function document(input: CatalogDefinitionInput<Definition>): readonly Document[] {
	return Object.freeze(catalogCore.values(input).map((definition) => Object.freeze({
		id: definition.id,
		version: definition.version,
		...(definition.description === undefined ? {} : { description: definition.description }),
		inputVendor: definition.input['~standard'].vendor,
		resultVendor: definition.result['~standard'].vendor,
		failures: Object.freeze(definition.failures.map((entry) => entry.id)),
		activities: Object.freeze(definition.activities.map((entry) => entry.id)),
		workflows: Object.freeze(definition.workflows.map((entry) => entry.id)),
		policies: Object.freeze(definition.policies.map((entry) => entry.id)),
		permissions: ids(definition.permissions),
		entitlements: ids(definition.entitlements),
		billing: ids(definition.billing),
	})));
}

/**
 * Builds the describe instruction payload used for diagnostics, replay identity, or generated documentation in the durable workflow interpreter.
 *
 * Workflow internals preserve deterministic instruction identity, replay, cancellation, registered cleanup, and control-instruction ownership.
 *
 * @internal
 */
function describeInstructionPayload(instruction: Instruction): DurableValue {
	if (instruction.category === 'control') {
		if (instruction.type === 'parallel') {
			return durable({
				branches: Object.keys(instruction.operations).sort(),
				failure: instruction.failure,
				...(instruction.concurrency === undefined ? {} : { concurrency: instruction.concurrency }),
			}, 'parallel instruction');
		}
		if (instruction.type === 'race') {
			return durable({ branches: Object.keys(instruction.operations).sort() }, 'race instruction');
		}
		if (instruction.type === 'map') {
			return durable({
				entries: instruction.entries.map((entry) => entry.key),
				concurrency: instruction.concurrency,
				failure: instruction.failure,
			}, 'map instruction');
		}
		return durable({
			maximumAttempts: instruction.maximumAttempts,
			...(instruction.delay === undefined ? {} : { delay: instruction.delay.toString() }),
			backoff: instruction.backoff,
			...(instruction.maximumDelay === undefined ? {} : { maximumDelay: instruction.maximumDelay.toString() }),
			jitter: instruction.jitter,
		}, 'retry instruction');
	}

	if (instruction.type === 'activity') {
		return durable({
			activity: { id: instruction.activity.id, version: instruction.activity.version },
			input: instruction.input,
		}, 'activity command');
	}
	if (instruction.type === 'sleep') return durable({ duration: instruction.duration.toString() }, 'sleep command');
	if (instruction.type === 'wait') {
		return durable({ signal: instruction.signal.id, input: instruction.input }, 'wait command');
	}
	if (instruction.type === 'child-workflow') {
		return durable({
			workflow: { id: instruction.workflow.id, version: instruction.workflow.version },
			input: instruction.input,
			cancellation: instruction.options.cancellation ?? 'follow-parent',
			result: instruction.options.result ?? 'wait',
		}, 'child workflow command');
	}
	if (instruction.type === 'emit') {
		return durable({ event: instruction.event.id, value: instruction.value }, 'emit command');
	}
	if (instruction.type === 'ensure') {
		return durable({ cleanup: describeCleanup(instruction.cleanup) }, 'ensure command');
	}
	return durable({ input: instruction.input }, 'continue-as-new command');
}

/**
 * Builds the describe cleanup used for diagnostics, replay identity, or generated documentation in the durable workflow interpreter.
 *
 * Workflow internals preserve deterministic instruction identity, replay, cancellation, registered cleanup, and control-instruction ownership.
 *
 * @internal
 */
function describeCleanup(command: ActivityCommand<unknown, unknown> | ChildWorkflowCommand<unknown, unknown>): DurableValue {
	if (command.type === 'activity') {
		return durable({
			category: command.category,
			type: command.type,
			version: command.version,
			...(command.key === undefined ? {} : { key: command.key }),
			activity: { id: command.activity.id, version: command.activity.version },
			input: command.input,
		}, 'cleanup activity command');
	}
	return durable({
		category: command.category,
		type: command.type,
		version: command.version,
		...(command.key === undefined ? {} : { key: command.key }),
		workflow: { id: command.workflow.id, version: command.workflow.version },
		input: command.input,
		cancellation: command.options.cancellation ?? 'follow-parent',
		result: command.options.result ?? 'wait',
	}, 'cleanup child command');
}

/**
 * Drives one workflow generator until completion while routing each yielded instruction through the deterministic interpreter.
 *
 * Workflow internals preserve deterministic instruction identity, replay, cancellation, registered cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function driveIterator<Value>(
	iterator: Generator<Instruction, Value, AnyCompletion>,
	ctx: Context,
	engine: Engine,
	basePath: string,
	cleanups: Operation<void, unknown>[],
): Promise<Value> {
	let resume: AnyCompletion | undefined;
	let index = 0;
	const explicitKeys = new Set<string>();
	try {
		while (true) {
			if (resume?.type === 'fault') throw new FaultError(resume.fault);
			if (resume?.type === 'cancelled') throw new CancelledError(resume.reason);
			contextCore.check(ctx);
			let step: IteratorResult<Instruction, Value>;
			try {
				step = resume === undefined ? iterator.next() : iterator.next(resume);
			} catch (error) {
				if (resume?.type === 'failure' && error !== resume.failure) {
					throw new CleanupFailureError(resume.failure, [error]);
				}
				throw error;
			}
			if (step.done) return step.value;
			const instruction = step.value;
			assertInstruction(instruction);
			assertUniqueInstructionKey(explicitKeys, instruction);
			const path = instructionPath(basePath, index, instruction);
			index += 1;
			let completion: AnyCompletion;
			try {
				completion = await engine.execute(ctx, instruction, path);
			} catch (error) {
				if (error instanceof ContinueAsNewError) throw error;
				throw new FaultError(error);
			}
			if (instruction.category === 'command' && instruction.type === 'ensure' && completion.type === 'success') {
				cleanups.push(operation(instruction.cleanup));
			}
			resume = completion;
		}
	} catch (error) {
		const finalizer = closeIterator(iterator);
		if (!finalizer.success) throw new CleanupFailureError(error, [finalizer.failure]);
		throw error;
	}
}

/**
 * Closes iterator and waits for the cleanup that the current owner is responsible for.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
function closeIterator<Value>(iterator: Generator<Instruction, Value, AnyCompletion>):
	| Readonly<{ readonly success: true }>
	| Readonly<{ readonly success: false; readonly failure: unknown }> {
	try {
		const step = iterator.return?.(undefined as never);
		if (step !== undefined && !step.done) {
			return Object.freeze({ success: false, failure: new FinalizerInstructionError(step.value) });
		}
		return Object.freeze({ success: true });
	} catch (error) {
		return Object.freeze({ success: false, failure: error });
	}
}

/**
 * Executes cleanups as one finite phase of the module runtime.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function executeCleanups(cleanups: readonly Operation<void, unknown>[], ctx: Context, engine: Engine): Promise<readonly unknown[]> {
	if (cleanups.length === 0) return Object.freeze([]);
	await using owned = contextCore.create({
		id: `${ctx.runId}:cleanup`,
		...(ctx.traceId === undefined ? {} : { traceId: ctx.traceId }),
		...(ctx.deploymentId === undefined ? {} : { deploymentId: ctx.deploymentId }),
		startedAt: ctx.startedAt,
		clock: ctx.clock,
	});
	const cleanupContext = workflowContext(ctx, owned);
	const failures: unknown[] = [];
	for (let index = cleanups.length - 1; index >= 0; index -= 1) {
		try {
			await executeOperation(cleanups[index]!, cleanupContext, engine, `${ctx.workflow.id}@${ctx.version}/cleanup/${index}`);
		} catch (error) {
			failures.push(error);
		}
	}
	return Object.freeze(failures);
}

/**
 * Executes control as one finite phase of the module runtime.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function executeControl(ctx: Context, instruction: ControlInstruction, path: string, engine: Engine): Promise<AnyCompletion> {
	try {
		if (instruction.type === 'parallel') return await executeParallel(ctx, instruction, path, engine);
		if (instruction.type === 'race') return await executeRace(ctx, instruction, path, engine);
		if (instruction.type === 'map') return await executeMap(ctx, instruction, path, engine);
		return await executeRetry(ctx, instruction, path, engine);
	} catch (error) {
		if (error instanceof ContinueAsNewError) throw error;
		if (error instanceof CleanupFailureError || error instanceof FinalizerInstructionError || error instanceof FaultError) {
			return fault(error instanceof FaultError ? error.fault : error);
		}
		if (isCancellation(error)) return cancelled(cancellationReason(error));
		return failed(error);
	}
}

/**
 * Executes parallel as one finite phase of the module runtime.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function executeParallel(ctx: Context, instruction: ParallelInstruction, path: string, engine: Engine): Promise<AnyCompletion> {
	const entries = Object.entries(instruction.operations);
	const concurrency = Math.min(instruction.concurrency ?? entries.length, entries.length);
	if (instruction.failure === 'settle') {
		const values = await ownedBounded(entries, concurrency, ctx, async ([key, childOperation], branchCtx) => {
			try {
				return [key, result.ok(await executeOperation(childOperation, branchCtx, engine, `${path}/${encodeURIComponent(key)}`))] as const;
			} catch (error) {
				if (isTerminalExecutionError(error)) throw error;
				return [key, result.fail(error)] as const;
			}
		});
		return success(Object.freeze(Object.fromEntries(values)));
	}
	const values = await failFast(entries, concurrency, ctx, async ([key, childOperation], branchCtx) => {
		return [key, await executeOperation(childOperation, branchCtx, engine, `${path}/${encodeURIComponent(key)}`)] as const;
	});
	return success(Object.freeze(Object.fromEntries(values)));
}

/**
 * Executes race as one finite phase of the module runtime.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function executeRace(ctx: Context, instruction: RaceInstruction, path: string, engine: Engine): Promise<AnyCompletion> {
	const entries = Object.entries(instruction.operations).sort(([left], [right]) => left.localeCompare(right));
	const reducer = new LocalReducer();
	const scope = new LocalScope();
	const branches = entries.map(([key, childOperation]) => {
		const branch = localWorkflowBranch(reducer, ctx, `workflow race branch ${key}`, async (branchCtx) => {
			const value = await executeOperation(childOperation, branchCtx, engine, `${path}/${encodeURIComponent(key)}`);
			return Object.freeze({ key, value });
		});
		scope.addChild(branch);
		return Object.freeze({ key, branch, result: branch.start() });
	});
	const first = await Promise.race(branches.map(async (entry) => Object.freeze({ entry, exit: await entry.result })));
	const primary = localExitFailure(first.exit);
	const reason = new SiblingCancellation(primary === undefined ? `Workflow race was won by ${first.entry.key}.` : primary);
	await scope.close(reason);
	const settled = await Promise.all(branches.map(async (entry) => Object.freeze({ entry, exit: await entry.result })));
	const cleanupFailures = settled
		.filter(({ entry }) => entry !== first.entry)
		.map(({ exit }) => localExitFailure(exit))
		.filter((failure) => failure !== undefined && !isSiblingCancellation(failure));
	if (primary !== undefined) {
		if (cleanupFailures.length > 0) throw new CleanupFailureError(primary, cleanupFailures);
		throw primary;
	}
	if (cleanupFailures.length > 0) throw new CleanupFailureError(first.exit, cleanupFailures);
	if (first.exit.type !== 'success') throw localCauseFailure(first.exit.cause);
	return success(first.exit.value);
}

/**
 * Executes map as one finite phase of the module runtime.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function executeMap(ctx: Context, instruction: MapInstruction, path: string, engine: Engine): Promise<AnyCompletion> {
	if (instruction.failure === 'settle') {
		const values = await ownedBounded(instruction.entries, instruction.concurrency, ctx, async (entry, branchCtx) => {
			try {
				return result.ok(await executeOperation(entry.operation, branchCtx, engine, `${path}/${encodeURIComponent(entry.key)}`));
			} catch (error) {
				if (isTerminalExecutionError(error)) throw error;
				return result.fail(error);
			}
		});
		return success(Object.freeze(values));
	}
	const values = await failFast(instruction.entries, instruction.concurrency, ctx, async (entry, branchCtx) => {
		return await executeOperation(entry.operation, branchCtx, engine, `${path}/${encodeURIComponent(entry.key)}`);
	});
	return success(Object.freeze(values));
}

/**
 * Executes retry as one finite phase of the module runtime.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function executeRetry(ctx: Context, instruction: RetryInstruction, path: string, engine: Engine): Promise<AnyCompletion> {
	let previous: unknown;
	for (let attempt = 1; attempt <= instruction.maximumAttempts; attempt += 1) {
		try {
			return success(await executeOperation(instruction.operation, ctx, engine, `${path}/attempt:${attempt}`));
		} catch (error) {
			if (isTerminalExecutionError(error)) throw error;
			previous = error;
			if (attempt < instruction.maximumAttempts && instruction.delay !== undefined) {
				const delay = retryDelay(instruction, path, attempt);
				await executeOperation(sleep(delay.toString()), ctx, engine, `${path}/retry-delay:${attempt}`);
			}
		}
	}
	return failed(previous);
}

/**
 * Calculates the deterministic retry delay, including bounded jitter, for one instruction attempt.
 *
 * @internal
 */
function retryDelay(instruction: RetryInstruction, path: string, failedAttempt: number): Temporal.Duration {
	const initialMilliseconds = durationMilliseconds(instruction.delay!);
	const maximumMilliseconds = instruction.maximumDelay === undefined
		? Number.POSITIVE_INFINITY
		: durationMilliseconds(instruction.maximumDelay);
	const backedOff = Math.min(initialMilliseconds * instruction.backoff ** (failedAttempt - 1), maximumMilliseconds);
	const jitterScale = instruction.jitter === 0
		? 1
		: 1 + ((deterministicUnit(`${path}:${failedAttempt}`) * 2) - 1) * instruction.jitter;
	return Temporal.Duration.from({ milliseconds: Math.max(0, Math.round(backedOff * jitterScale)) });
}

/**
 * Converts duration into the millisecond value used by the durable workflow interpreter.
 *
 * @internal
 */
function durationMilliseconds(duration: Temporal.Duration): number {
	let milliseconds: number;
	try {
		milliseconds = duration.total({ unit: 'milliseconds', relativeTo: Temporal.PlainDate.from('2000-01-01') });
	} catch (error) {
		throw new TypeError('Workflow retry delay must be convertible to milliseconds.', { cause: error });
	}
	if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new TypeError('Workflow retry delay must be a finite non-negative duration.');
	return milliseconds;
}

/**
 * Derives a stable unit interval value from instruction identity so replay uses the same retry jitter.
 *
 * @internal
 */
function deterministicUnit(value: string): number {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0) / 0xffff_ffff;
}

/**
 * Runs bounded workflow branches while keeping each child operation owned and joined before the parent continues.
 *
 * Workflow internals preserve deterministic instruction identity, replay, cancellation, registered cleanup, and control-instruction ownership.
 *
 * @internal
 */
async function ownedBounded<Input, Output>(
	values: readonly Input[],
	concurrency: number,
	ctx: Context,
	executeValue: (value: Input, ctx: Context, index: number) => Promise<Output>,
): Promise<Output[]> {
	if (values.length === 0) return [];
	const maximum = Math.min(positiveInteger(concurrency, 'concurrency'), values.length);
	const reducer = new LocalReducer();
	const scope = new LocalScope();
	const valuesByIndex = new Array<Output>(values.length);
	const active = new Map<number, LocalBranch<Output>>();
	const failures: unknown[] = [];
	let nextIndex = 0;
	let primary: unknown;
	let hasPrimary = false;

	const launch = (index: number): void => {
		const branch = localWorkflowBranch(reducer, ctx, `workflow branch ${index}`, (branchCtx) => executeValue(values[index]!, branchCtx, index));
		scope.addChild(branch);
		active.set(index, branch);
		void branch.start().then((exit) => {
			active.delete(index);
			const failure = localExitFailure(exit);
			if (failure === undefined && exit.type === 'success') valuesByIndex[index] = exit.value;
			else if (!hasPrimary) {
				primary = failure;
				hasPrimary = true;
				const reason = new SiblingCancellation(failure);
				void scope.close(reason);
			} else if (!isSiblingCancellation(failure)) failures.push(failure);
		});
	};

	while (active.size < maximum && nextIndex < values.length) launch(nextIndex++);
	while (active.size > 0) {
		await Promise.race([...active.values()].map((branch) => branch.settled()));
		while (!hasPrimary && active.size < maximum && nextIndex < values.length) launch(nextIndex++);
	}
	await scope.close(hasPrimary ? new SiblingCancellation(primary) : undefined);
	if (hasPrimary) {
		if (failures.length > 0) throw new CleanupFailureError(primary, failures);
		throw primary;
	}
	return valuesByIndex;
}

/**
 * Runs child workflow operations with fail-fast semantics and waits for sibling cancellation and cleanup before returning the failure.
 *
 * @internal
 */
async function failFast<Input, Output>(
	values: readonly Input[],
	concurrency: number,
	ctx: Context,
	executeValue: (value: Input, ctx: Context, index: number) => Promise<Output>,
): Promise<Output[]> {
	return await ownedBounded(values, concurrency, ctx, executeValue);
}

/**
 * Creates the host-local branch used to execute one child workflow operation under structured ownership.
 *
 * @internal
 */
function localWorkflowBranch<Output>(
	reducer: LocalReducer,
	ctx: Context,
	name: string,
	executeValue: (ctx: Context) => Promise<Output>,
): LocalBranch<Output> {
	return new LocalBranch(localOperation.wait(name, async (signal) => {
		await using owned = contextCore.child(ctx, { signal });
		return await executeValue(workflowContext(ctx, owned));
	}), reducer);
}

/**
 * Builds the local exit failure used when the durable workflow interpreter cannot complete as intended.
 *
 * @internal
 */
function localExitFailure<Value>(exit: LocalExit<Value>): unknown | undefined {
	if (exit.type === 'success') return undefined;
	return localCauseFailure(exit.cause);
}

/**
 * Builds the local cause failure used when the durable workflow interpreter cannot complete as intended.
 *
 * @internal
 */
function localCauseFailure(cause: LocalCause): unknown {
	if (cause.type === 'failure') return cause.failure;
	if (cause.type === 'fault') return new FaultError(cause.fault);
	if (cause.type === 'cancelled') return new CancelledError(cause.reason);
	const failures = cause.causes.map(localCauseFailure);
	const primary = failures[0];
	return failures.length <= 1 ? primary : new CleanupFailureError(primary, failures.slice(1));
}

/**
 * Creates the workflow context that carries ownership and cancellation through the durable workflow interpreter.
 *
 * Workflow internals preserve deterministic instruction identity, replay, cancellation, registered cleanup, and control-instruction ownership.
 *
 * @internal
 */
function workflowContext(parent: Context, owned: contextCore.Owned): Context {
	return Object.freeze({
		id: owned.id,
		...(owned.traceId === undefined ? {} : { traceId: owned.traceId }),
		...(owned.deploymentId === undefined ? {} : { deploymentId: owned.deploymentId }),
		...(owned.idempotencyKey === undefined ? {} : { idempotencyKey: owned.idempotencyKey }),
		startedAt: owned.startedAt,
		...(owned.deadline === undefined ? {} : { deadline: owned.deadline }),
		signal: owned.signal,
		clock: owned.clock,
		workflow: parent.workflow,
		runId: parent.runId,
		input: parent.input,
		version: parent.version,
	});
}

/**
 * Builds the instruction path used by the durable workflow interpreter.
 *
 * @internal
 */
function instructionPath(base: string, index: number, instruction: Instruction): string {
	const segment = instruction.key === undefined ? String(index) : encodeURIComponent(instruction.key);
	return `${base}/${segment}:${instruction.type}`;
}

/**
 * Extracts stable instruction metadata used by diagnostics and the durable instruction description.
 *
 * @internal
 */
function instructionMetadata(options: ActivityRunOptions): Readonly<{ readonly key?: string; readonly annotations?: Annotations }> {
	if (options.key !== undefined) assertStableKey(options.key);
	return {
		...(options.key === undefined ? {} : { key: options.key }),
		...(options.annotations === undefined ? {} : { annotations: freezeAnnotations(options.annotations) }),
	};
}

/**
 * Collects the ids used to preserve stable identity in the durable workflow interpreter.
 *
 * @internal
 */
function ids(input: CatalogDefinitionInput<CatalogEntryIdentity> | undefined): readonly string[] {
	return input === undefined ? Object.freeze([]) : Object.freeze(catalogCore.values(input).map((entry) => entry.id));
}

/**
 * Captures the snapshot input as immutable state for the durable workflow interpreter.
 *
 * @internal
 */
function snapshotInput<Value>(value: Value): Value {
	if (!Array.isArray(value)) return value;
	return Object.freeze(value.map((entry) => snapshotInput(entry))) as Value;
}

/**
 * Snapshots annotations so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeAnnotations(value: Annotations): Annotations {
	return Object.freeze({ ...value });
}

/**
 * Snapshots record so later compilation cannot observe caller mutation.
 *
 * @internal
 */
function freezeRecord<Values extends Readonly<Record<string, unknown>>>(value: Values): Values {
	return Object.freeze({ ...value });
}

/**
 * Rejects invalid operations before it can enter authoritative module state.
 *
 * @internal
 */
function assertOperations(value: Operations): void {
	if (Object.keys(value).length === 0) throw new TypeError('Workflow control instruction requires at least one operation.');
	for (const [key, childOperation] of Object.entries(value)) {
		assertStableKey(key);
		assertOperation(childOperation);
	}
}

/**
 * Rejects invalid operation before it can enter authoritative module state.
 *
 * @internal
 */
function assertOperation(value: unknown): asserts value is Operation<unknown, unknown> {
	if (typeof value !== 'object' || value === null || typeof (value as Operation<unknown, unknown>)[Symbol.iterator] !== 'function') {
		throw new TypeError('Workflow operation must implement Symbol.iterator.');
	}
}

/**
 * Creates d instruction while preserving the module's ownership rules.
 *
 * @internal
 */
function createdInstruction(value: Operation<unknown, unknown>, label: string): Instruction {
	assertOperation(value);
	const instruction = operationInstructions.get(value as object);
	if (instruction === undefined) throw new TypeError(`${label} must come from a workflow or activity operation creator.`);
	return instruction;
}

/**
 * Rejects invalid instruction before it can enter authoritative module state.
 *
 * It preserves deterministic durable instruction identity, replay semantics, cancellation, cleanup, and control-instruction ownership.
 *
 * @internal
 */
function assertInstruction(value: unknown): asserts value is Instruction {
	if (typeof value !== 'object' || value === null) throw new TypeError('Workflow program yielded a non-instruction value.');
	const instruction = value as Partial<Instruction>;
	if (instruction.category !== 'command' && instruction.category !== 'control') {
		throw new TypeError('Workflow instruction category must be command or control.');
	}
	if (typeof instruction.type !== 'string' || instruction.type.length === 0) {
		throw new TypeError('Workflow instruction type must be a non-empty string.');
	}
	if (!Number.isSafeInteger(instruction.version) || (instruction.version ?? 0) < 1) {
		throw new TypeError('Workflow instruction version must be a positive safe integer.');
	}
}

/**
 * Validates and freezes a value before it is persisted as workflow instruction data.
 *
 * @internal
 */
function durable(value: unknown, label: string): DurableValue {
	return durableValue(value, label, new Set<object>());
}

/**
 * Returns the durable value in the representation expected by the durable workflow interpreter.
 *
 * Workflow internals preserve deterministic instruction identity, replay, cancellation, registered cleanup, and control-instruction ownership.
 *
 * @internal
 */
function durableValue(value: unknown, path: string, parents: Set<object>): DurableValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number.`);
		return value;
	}
	if (typeof value !== 'object') throw new TypeError(`${path} must contain only JSON-safe durable values.`);
	if (parents.has(value)) throw new TypeError(`${path} contains a cycle.`);
	parents.add(value);
	try {
		if (Array.isArray(value)) {
			return Object.freeze(value.map((entry, index) => durableValue(entry, `${path}[${index}]`, parents)));
		}
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new TypeError(`${path} contains a non-plain object.`);
		}
		const output: Record<string, DurableValue> = Object.create(null);
		for (const key of Object.keys(value).sort()) {
			output[key] = durableValue((value as Record<string, unknown>)[key], `${path}.${key}`, parents);
		}
		return Object.freeze(output);
	} finally {
		parents.delete(value);
	}
}

/**
 * Rejects invalid unique instruction key before it can enter authoritative module state.
 *
 * @internal
 */
function assertUniqueInstructionKey(keys: Set<string>, instruction: Instruction): void {
	if (instruction.key === undefined) return;
	assertStableKey(instruction.key);
	if (keys.has(instruction.key)) throw new TypeError(`Workflow program yielded duplicate instruction key ${JSON.stringify(instruction.key)} in one scope.`);
	keys.add(instruction.key);
}

/**
 * Rejects invalid identifier before it can enter authoritative module state.
 *
 * @internal
 */
function assertIdentifier(value: string, label: string): void {
	if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) throw new TypeError(`Invalid ${label} id ${JSON.stringify(value)}.`);
}

/**
 * Rejects invalid stable key before it can enter authoritative module state.
 *
 * @internal
 */
function assertStableKey(value: string): void {
	if (value.trim().length === 0) throw new TypeError('Workflow instruction keys must not be empty.');
	if (value.length > 512) throw new TypeError('Workflow instruction keys must not exceed 512 characters.');
}

/**
 * Validates positive integer before it is used by the durable workflow interpreter.
 *
 * @internal
 */
function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive safe integer.`);
	return value;
}

/**
 * Checks whether terminal execution error satisfies the condition required by the durable workflow interpreter.
 *
 * @internal
 */
function isTerminalExecutionError(error: unknown): boolean {
	return error instanceof FaultError || error instanceof ContinueAsNewError || error instanceof CleanupFailureError || isCancellation(error);
}

/**
 * Checks whether cancellation satisfies the condition required by the durable workflow interpreter.
 *
 * @internal
 */
function isCancellation(error: unknown): boolean {
	return error instanceof CancelledError ||
		error instanceof contextCore.ContextCancelledError ||
		error instanceof contextCore.ContextDeadlineExceededError;
}

/**
 * Checks whether cellation reason is currently allowed by the durable workflow interpreter.
 *
 * @internal
 */
function cancellationReason(error: unknown): unknown {
	if (error instanceof CancelledError || error instanceof contextCore.ContextCancelledError) return error.reason;
	return error;
}

/**
 * Checks whether sibling cancellation satisfies the condition required by the durable workflow interpreter.
 *
 * @internal
 */
function isSiblingCancellation(error: unknown): boolean {
	if (error instanceof CancelledError) return error.reason instanceof SiblingCancellation;
	if (error instanceof contextCore.ContextCancelledError) return error.reason instanceof SiblingCancellation;
	return false;
}

export { workflowCatalog as catalog, continueAsNew as continue };
export type * from './types.ts';
