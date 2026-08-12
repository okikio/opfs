import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Catalog, CatalogEntryIdentity, CatalogSelection, DefinitionInput as CatalogDefinitionInput } from '@utils/catalog';
import type { Context as BaseContext } from '@utils/context';
import type { Definition as FailureDefinition, Occurrence as FailureOccurrence } from '@utils/failure';
import type { Result as ExplicitResult } from '@utils/result';

/** Static schema accepted by workflow definitions, signals, and events. */
export type Schema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

/** Structural activity contract referenced by workflow instructions. */
export interface ActivityReference extends CatalogEntryIdentity {
	readonly kind: 'activity';
	readonly version: string;
	readonly input: Schema;
	readonly result: Schema;
	readonly failures: readonly FailureDefinition[];
}

/** Structural workflow contract referenced by child-workflow instructions. */
export interface WorkflowReference extends CatalogEntryIdentity {
	readonly kind: 'workflow';
	readonly version: string;
	readonly input: Schema;
	readonly result: Schema;
	readonly failures: readonly FailureDefinition[];
}

/** Cross-cutting definitions retained by a workflow contract for compilation. */
export interface Contributions {
	readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly entitlements?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly billing?: CatalogDefinitionInput<CatalogEntryIdentity>;
}

/** Input accepted by {@link define}. */
export interface DefinitionInput extends Contributions {
	readonly id: string;
	readonly version: string;
	readonly description?: string;
	readonly input: Schema;
	readonly result: Schema;
	readonly failures?: CatalogDefinitionInput<FailureDefinition>;
	readonly activities?: CatalogDefinitionInput<ActivityReference>;
	readonly workflows?: CatalogDefinitionInput<WorkflowReference>;
	readonly policies?: readonly Policy[];
}

/** Immutable workflow contract independent from a concrete interpreter. */
export interface Definition<Authoring extends DefinitionInput = DefinitionInput> extends WorkflowReference, Contributions {
	readonly description?: string;
	readonly input: Authoring['input'];
	readonly result: Authoring['result'];
	readonly failures: readonly FailureDefinition[];
	readonly activities: readonly ActivityReference[];
	readonly workflows: readonly WorkflowReference[];
	readonly policies: readonly Policy[];
}

/** Input value inferred from a workflow definition. */
export type Input<WorkflowDefinition extends WorkflowReference> = StandardSchemaV1.InferOutput<WorkflowDefinition['input']>;

/** Result value inferred from a workflow definition. */
export type Result<WorkflowDefinition extends WorkflowReference> = StandardSchemaV1.InferOutput<WorkflowDefinition['result']>;

/** Declared failure occurrence union inferred from a workflow definition. */
export type Failures<WorkflowDefinition extends WorkflowReference> = WorkflowDefinition['failures'][number] extends infer Failure_ extends FailureDefinition
	? FailureOccurrence<Failure_>
	: never;

/** Runtime workflow context. It deliberately has no resource resolver. */
export interface Context<WorkflowDefinition extends Definition = Definition> extends BaseContext {
	readonly workflow: WorkflowDefinition;
	readonly runId: string;
	readonly input: Input<WorkflowDefinition>;
	readonly version: WorkflowDefinition['version'];
}

/** Immutable activity-placement policy attached to one workflow. */
export interface Policy extends CatalogEntryIdentity {
	readonly kind: 'workflow-policy';
	readonly description?: string;
	readonly activities: readonly ActivityReference[];
	readonly runtime: CatalogEntryIdentity & Readonly<{ readonly kind: 'runtime' }>;
}

/** Input accepted by {@link policy}. */
export interface PolicyInput {
	readonly id: string;
	readonly description?: string;
	readonly activities: CatalogDefinitionInput<ActivityReference>;
	readonly runtime: CatalogEntryIdentity & Readonly<{ readonly kind: 'runtime' }>;
}

/** Instruction annotations safe to persist or expose to operators. */
export type Annotations = Readonly<Record<string, string | number | boolean>>;

/** Shared instruction metadata. */
export interface InstructionBase {
	readonly category: 'command' | 'control';
	readonly type: string;
	readonly version: number;
	readonly key?: string;
	readonly annotations?: Annotations;
}

/** Shared leaf-command metadata. */
export interface CommandBase extends InstructionBase {
	readonly category: 'command';
}

/** Shared control-instruction metadata. */
export interface ControlInstructionBase extends InstructionBase {
	readonly category: 'control';
}

/** Public options accepted by activity operations and simple commands. */
export interface ActivityRunOptions {
	readonly key?: string;
	readonly annotations?: Annotations;
}

/** Activity execution command. */
export interface ActivityCommand<Value = unknown, Failure = unknown> extends CommandBase {
	readonly type: 'activity';
	readonly activity: ActivityReference;
	readonly input: unknown;
	readonly options: ActivityRunOptions;
	readonly _value?: Value;
	readonly _failure?: Failure;
}

/** Durable sleep command. */
export interface SleepCommand extends CommandBase {
	readonly type: 'sleep';
	readonly duration: Temporal.Duration;
}

/** Stable signal definition. */
export interface Signal<Value = unknown> extends CatalogEntryIdentity {
	readonly kind: 'workflow-signal';
	readonly description?: string;
	readonly value: Schema<unknown, Value>;
}

/** Wait for one matching signal value. */
export interface WaitCommand<Value = unknown> extends CommandBase {
	readonly type: 'wait';
	readonly signal: Signal<Value>;
	readonly input: unknown;
}

/** Public options accepted by child workflow operations. */
export interface ChildOptions extends ActivityRunOptions {
	readonly cancellation?: 'follow-parent' | 'request' | 'independent';
	readonly result?: 'wait' | 'discard';
}

/** Start or await one child workflow. */
export interface ChildWorkflowCommand<Value = unknown, Failure = unknown> extends CommandBase {
	readonly type: 'child-workflow';
	readonly workflow: WorkflowReference;
	readonly input: unknown;
	readonly options: ChildOptions;
	readonly _value?: Value;
	readonly _failure?: Failure;
}

/** Stable event definition used by workflow progress projections. */
export interface Event<Value = unknown> extends CatalogEntryIdentity {
	readonly kind: 'workflow-event';
	readonly description?: string;
	readonly value: Schema<unknown, Value>;
}

/** Emit one declared event. */
export interface EmitCommand extends CommandBase {
	readonly type: 'emit';
	readonly event: Event;
	readonly value: unknown;
}

/** Register one cleanup operation for the current workflow scope. */
export interface EnsureCommand extends CommandBase {
	readonly type: 'ensure';
	readonly cleanup: ActivityCommand<unknown, unknown> | ChildWorkflowCommand<unknown, unknown>;
}

/** End the current run and atomically continue with new input. */
export interface ContinueCommand extends CommandBase {
	readonly type: 'continue';
	readonly input: unknown;
}

/** Public options accepted by parallel coordination. */
export interface ParallelOptions extends ActivityRunOptions {
	readonly concurrency?: number;
	readonly failure?: 'fail-fast' | 'settle';
}

/** Keyed parallel child-operation coordination. */
export interface ParallelInstruction<Operations_ extends Operations = Operations> extends ControlInstructionBase {
	readonly type: 'parallel';
	readonly operations: Operations_;
	readonly concurrency?: number;
	readonly failure: 'fail-fast' | 'settle';
}

/** Public options accepted by race coordination. */
export type RaceOptions = ActivityRunOptions;

/** First-terminal child-operation coordination. */
export interface RaceInstruction<Operations_ extends Operations = Operations> extends ControlInstructionBase {
	readonly type: 'race';
	readonly operations: Operations_;
}

/** One keyed operation created for a mapped input. */
export interface MapEntry<Value = unknown, Failure = unknown> {
	readonly key: string;
	readonly operation: Operation<Value, Failure>;
}

/** Public options accepted by bounded mapping. */
export interface MapOptions<Item> {
	readonly concurrency: number;
	readonly key: (item: Item, index: number) => string;
	readonly failure?: 'fail-fast' | 'settle';
	readonly instructionKey?: string;
	readonly annotations?: Annotations;
}

/** Bounded keyed mapping coordination. */
export interface MapInstruction<Value = unknown, Failure = unknown> extends ControlInstructionBase {
	readonly type: 'map';
	readonly entries: readonly MapEntry<Value, Failure>[];
	readonly concurrency: number;
	readonly failure: 'fail-fast' | 'settle';
}

/** Public options accepted by workflow-level retry. */
export interface RetryOptions extends ActivityRunOptions {
	readonly maximumAttempts: number;
	readonly delay?: Temporal.DurationLike | string;
	readonly backoff?: number;
	readonly maximumDelay?: Temporal.DurationLike | string;
	readonly jitter?: number;
}

/** Repeat one operation according to one explicit policy. */
export interface RetryInstruction<Value = unknown, Failure = unknown> extends ControlInstructionBase {
	readonly type: 'retry';
	readonly operation: Operation<Value, Failure>;
	readonly maximumAttempts: number;
	readonly delay?: Temporal.Duration;
	readonly backoff: number;
	readonly maximumDelay?: Temporal.Duration;
	readonly jitter: number;
}

/** JSON-safe value that can be persisted as workflow history. */
export type DurableValue = null | boolean | number | string | readonly DurableValue[] | Readonly<{ readonly [key: string]: DurableValue }>;

/** Serializable description of one yielded workflow instruction. */
export interface InstructionDescription {
	readonly path: string;
	readonly category: Instruction['category'];
	readonly type: Instruction['type'];
	readonly version: number;
	readonly key?: string;
	readonly annotations?: Annotations;
	readonly payload: DurableValue;
}

/** Stable persisted identity material for one yielded workflow instruction. */
export interface InstructionIdentity {
	readonly description: InstructionDescription;
	readonly fingerprint: string;
}

/** Leaf instructions requesting one interpreter-owned action. */
export type Command =
	| ActivityCommand
	| SleepCommand
	| WaitCommand
	| ChildWorkflowCommand
	| EmitCommand
	| EnsureCommand
	| ContinueCommand;

/** Instructions coordinating nested operations. */
export type ControlInstruction = ParallelInstruction | RaceInstruction | MapInstruction | RetryInstruction;

/** Any instruction understood by a workflow interpreter. */
export type Instruction = Command | ControlInstruction;

/** Successful instruction completion. */
export interface SuccessCompletion<Value = unknown> {
	readonly type: 'success';
	readonly value: Value;
}

/** Declared instruction failure completion. */
export interface FailureCompletion<Failure = unknown> {
	readonly type: 'failure';
	readonly failure: Failure;
}

/** Unexpected interpreter or implementation fault completion. */
export interface FaultCompletion {
	readonly type: 'fault';
	readonly fault: unknown;
}

/** Cancelled instruction completion. */
export interface CancelledCompletion {
	readonly type: 'cancelled';
	readonly reason: unknown;
}

/** Completion returned by an interpreter for one suspended instruction. */
export type Completion<Value = unknown, Failure = unknown> =
	| SuccessCompletion<Value>
	| FailureCompletion<Failure>
	| FaultCompletion
	| CancelledCompletion;

/** Runtime-erased completion. */
export type AnyCompletion = Completion<unknown, unknown>;

/** Author-facing yieldable workflow value. */
export interface Operation<Value, Failure = never> {
	readonly _value?: Value;
	readonly _failure?: Failure;
	[Symbol.iterator](): Generator<Instruction, Value, AnyCompletion>;
}

/** Extract the success value from an operation. */
export type OperationValue<Value extends Operation<unknown, unknown>> = Value extends Operation<infer Output, infer _Failure> ? Output : never;

/** Extract the failure value from an operation. */
export type OperationFailure<Value extends Operation<unknown, unknown>> = Value extends Operation<infer _Output, infer Failure> ? Failure : never;

/** Keyed operation record. */
export type Operations = Readonly<Record<string, Operation<unknown, unknown>>>;

/** Key-preserving operation success values. */
export type OperationValues<Values extends Operations> = { readonly [Key in keyof Values]: OperationValue<Values[Key]> };

/** Key-preserving settled operation values. */
export type SettledOperationValues<Values extends Operations> = {
	readonly [Key in keyof Values]: ExplicitResult<OperationValue<Values[Key]>, OperationFailure<Values[Key]>>;
};

/** Union of failures represented by a keyed operation record. */
export type OperationFailures<Values extends Operations> = OperationFailure<Values[keyof Values]>;

/** Result returned by a race. */
export type RaceResult<Values extends Operations> = {
	readonly [Key in keyof Values]: Readonly<{ readonly key: Key; readonly value: OperationValue<Values[Key]> }>;
}[keyof Values];

/** Workflow generator program. */
export type Program<Value> = Generator<Instruction, Value, AnyCompletion>;

/** Exact workflow implementation. */
export interface Implementation<WorkflowDefinition extends Definition = Definition> {
	readonly definition: WorkflowDefinition;
	readonly program: (ctx: Context<WorkflowDefinition>) => Program<Result<WorkflowDefinition>>;
}

/** Leaf-command execution supplied by a live runtime host. */
export type CommandHandler = (
	ctx: Context,
	command: Command,
	path: string,
) => Promise<AnyCompletion>;

/** Input passed to an instruction lifecycle wrapper. */
export interface InstructionHandlerInput {
	readonly ctx: Context;
	readonly instruction: Instruction;
	readonly path: string;
	readonly identity: InstructionIdentity;
	readonly next: () => Promise<AnyCompletion>;
}

/** Wrapper used by durable engines to record every instruction and completion. */
export type InstructionHandler = (input: InstructionHandlerInput) => Promise<AnyCompletion>;

/** Inputs accepted by the live instruction interpreter. */
export interface LiveOptions {
	readonly command: CommandHandler;
	readonly instruction?: InstructionHandler;
}

/** Interpreter interface used by live and durable workflow implementations. */
export interface Engine {
	execute(ctx: Context, instruction: Instruction, path: string): Promise<AnyCompletion>;
}

/** Inputs accepted while creating one validated workflow context. */
export interface CreateContextOptions<WorkflowDefinition extends Definition> {
	readonly definition: WorkflowDefinition;
	readonly runId: string;
	readonly input: unknown;
	readonly ctx: BaseContext;
}

/** Inputs accepted while executing one workflow implementation. */
export interface ExecuteOptions<WorkflowDefinition extends Definition> {
	readonly ctx: Context<WorkflowDefinition>;
	readonly implementation: Implementation<WorkflowDefinition>;
	readonly engine: Engine;
}

/** Named workflow catalog. */
export type WorkflowCatalog<Entries extends Readonly<Record<PropertyKey, Definition>>> = Catalog<Entries[keyof Entries], Entries>;

/** Key-preserving workflow catalog selection. */
export type WorkflowSelection<
	Entry extends Definition,
	Entries extends Readonly<Record<PropertyKey, Entry>>,
> = CatalogSelection<Entry, Entries>;

/** JSON-safe workflow documentation. */
export interface Document {
	readonly id: string;
	readonly version: string;
	readonly description?: string;
	readonly inputVendor: string;
	readonly resultVendor: string;
	readonly failures: readonly string[];
	readonly activities: readonly string[];
	readonly workflows: readonly string[];
	readonly policies: readonly string[];
	readonly permissions: readonly string[];
	readonly entitlements: readonly string[];
	readonly billing: readonly string[];
}
