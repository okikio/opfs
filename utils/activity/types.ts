import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Catalog, CatalogEntryIdentity, CatalogSelection, DefinitionInput as CatalogDefinitionInput } from '@utils/catalog';
import type { Context as BaseContext } from '@utils/context';
import type { Definition as FailureDefinition, Occurrence as FailureOccurrence } from '@utils/failure';
import type { Definition as ResourceDefinition, Resolver as ResourceResolver } from '@utils/resource';
import type { ResilienceInput, ResiliencePolicy } from '@utils/resilience';
import type { Definition as RuntimeDefinition } from '@utils/runtime';
import type { Operation } from '@utils/workflow';
import type { Result as ExplicitResult } from '@utils/result';

/** Static schema accepted by activity definitions. */
export type Schema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

/** Input accepted by {@link define}. Activity versions are part of durable execution identity. */
export interface DefinitionInput {
	readonly id: string;
	readonly version: string;
	readonly description?: string;
	readonly input: Schema;
	readonly result: Schema;
	readonly failures?: CatalogDefinitionInput<FailureDefinition>;
	readonly runtimes: CatalogDefinitionInput<RuntimeDefinition>;
	readonly resources?: CatalogDefinitionInput<ResourceDefinition>;
	readonly permissions?: CatalogDefinitionInput<CatalogEntryIdentity>;
	readonly resilience?: ResilienceInput;
}

/** Immutable external-work contract. */
export interface Definition<Authoring extends DefinitionInput = DefinitionInput> extends CatalogEntryIdentity {
	readonly kind: 'activity';
	readonly version: Authoring['version'];
	readonly description?: string;
	readonly input: Authoring['input'];
	readonly result: Authoring['result'];
	readonly failures: readonly FailureDefinition[];
	readonly runtimes: readonly RuntimeDefinition[];
	readonly resources: readonly ResourceDefinition[];
	readonly permissions: readonly CatalogEntryIdentity[];
	readonly resilience: readonly ResiliencePolicy[];
}

/** Input value inferred from an activity definition. */
export type Input<ActivityDefinition extends Definition> = StandardSchemaV1.InferOutput<ActivityDefinition['input']>;

/** Result value inferred from an activity definition. */
export type Result<ActivityDefinition extends Definition> = StandardSchemaV1.InferOutput<ActivityDefinition['result']>;

/** Resource definition union declared by an activity. */
export type Resources<ActivityDefinition extends Definition> = ActivityDefinition['resources'][number];

/** Runtime definition union allowed by an activity. */
export type Runtimes<ActivityDefinition extends Definition> = ActivityDefinition['runtimes'][number];

/** Declared failure occurrence union inferred from an activity. */
export type Failures<ActivityDefinition extends Definition> = ActivityDefinition['failures'][number] extends infer Failure_ extends FailureDefinition
	? FailureOccurrence<Failure_>
	: never;

/** One concrete activity execution context. */
export interface Context<ActivityDefinition extends Definition = Definition> extends BaseContext {
	readonly activity: ActivityDefinition;
	readonly runtime: Runtimes<ActivityDefinition>;
	readonly jobId: string;
	readonly attempt: number;
	readonly input: Input<ActivityDefinition>;
	readonly resources: ResourceResolver<Resources<ActivityDefinition>>;
	heartbeat(value?: unknown): void;
}

/** Concrete implementation bound to one exact activity and runtime. */
export interface Implementation<ActivityDefinition extends Definition = Definition> {
	readonly definition: ActivityDefinition;
	readonly runtime: Runtimes<ActivityDefinition>;
	readonly execute: (ctx: Context<ActivityDefinition>) => Result<ActivityDefinition> | Promise<Result<ActivityDefinition>>;
}

/** Input accepted by {@link implement}. */
export interface ImplementationInput<ActivityDefinition extends Definition> {
	readonly runtime: Runtimes<ActivityDefinition>;
	readonly execute: Implementation<ActivityDefinition>['execute'];
}

/** Options accepted by {@link run}. */
export interface RunOptions {
	readonly key?: string;
	readonly annotations?: Readonly<Record<string, string | number | boolean>>;
}

/** Inputs accepted by direct activity execution. */
export interface ExecuteOptions<ActivityDefinition extends Definition> {
	readonly implementation: Implementation<ActivityDefinition>;
	readonly input: unknown;
	readonly ctx: BaseContext;
	readonly resources: ResourceResolver<Resources<ActivityDefinition>>;
	readonly jobId: string;
	readonly attempt: number;
	readonly heartbeat?: (value?: unknown) => void;
}

/** Named activity catalog. */
export type ActivityCatalog<Entries extends Readonly<Record<PropertyKey, Definition>>> = Catalog<Entries[keyof Entries], Entries>;

/** Key-preserving activity catalog selection. */
export type ActivitySelection<
	Entry extends Definition,
	Entries extends Readonly<Record<PropertyKey, Entry>>,
> = CatalogSelection<Entry, Entries>;

/** JSON-safe activity documentation. */
export interface Document {
	readonly id: string;
	readonly version: string;
	readonly description?: string;
	readonly inputVendor: string;
	readonly resultVendor: string;
	readonly failures: readonly string[];
	readonly runtimes: readonly string[];
	readonly resources: readonly string[];
	readonly permissions: readonly string[];
	readonly resilience: readonly string[];
}

/** Explicit result returned by activity.try(). */
export type TryResult<ActivityDefinition extends Definition> = ExplicitResult<Result<ActivityDefinition>, Failures<ActivityDefinition>>;

/** Yieldable activity execution operation. */
export type RunOperation<ActivityDefinition extends Definition> = Operation<Result<ActivityDefinition>, Failures<ActivityDefinition>>;
