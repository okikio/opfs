import type {
	CatalogEntryIdentity,
	CatalogEntryValue,
	DefinitionEntry,
	DefinitionInput,
	ValuedCatalogEntry,
} from '@utils/catalog';
import type { Context } from '@utils/context';
import type { ProblemDefinition } from '@utils/http/problem';
import type { ResilienceInput } from '@utils/resilience';


/** Static resource reference accepted by portable middleware contracts. */
export type MiddlewareResourceDefinition<Value = unknown> = ValuedCatalogEntry<'resource', Value>;

/** Runtime value represented by one middleware resource reference. */
export type MiddlewareResourceValue<Definition extends MiddlewareResourceDefinition> = CatalogEntryValue<Definition>;

const middlewareContextValue: unique symbol = Symbol('kaiju.middleware.context-value');

/** Typed request-context value that middleware may require or provide. */
export interface MiddlewareContextDefinition<Value = unknown> extends CatalogEntryIdentity {
	readonly kind: 'middleware-context';
	readonly [middlewareContextValue]: Value;
}

/** Input accepted by {@link context}. */
export interface MiddlewareContextDefinitionInput {
	readonly id: string;
	readonly description: string;
}

/** Value represented by one middleware context definition. */
export type MiddlewareContextValue<Definition extends MiddlewareContextDefinition> =
	Definition extends MiddlewareContextDefinition<infer Value> ? Value : never;

/** Static import-safe middleware contract. */
export interface MiddlewareDefinition<
	Requires extends readonly MiddlewareContextDefinition[] = readonly MiddlewareContextDefinition[],
	Provides extends readonly MiddlewareContextDefinition[] = readonly MiddlewareContextDefinition[],
	Resources extends MiddlewareResourceDefinition = MiddlewareResourceDefinition,
	Problems extends ProblemDefinition = ProblemDefinition,
> extends CatalogEntryIdentity {
	readonly kind: 'middleware';
	readonly description: string;
	readonly requires: Requires;
	readonly provides: Provides;
	readonly resources?: DefinitionInput<Resources>;
	readonly problems?: DefinitionInput<Problems>;
	readonly permissions?: DefinitionInput<CatalogEntryIdentity>;
	readonly entitlements?: DefinitionInput<CatalogEntryIdentity>;
	readonly authentication?: DefinitionInput<CatalogEntryIdentity>;
	readonly resiliency?: ResilienceInput;
	readonly documentation?: Readonly<{ readonly url?: string; readonly notes?: string }>;
}

/** Input accepted by {@link define}. */
export interface MiddlewareDefinitionInput<
	Requires extends readonly MiddlewareContextDefinition[] = readonly MiddlewareContextDefinition[],
	Provides extends readonly MiddlewareContextDefinition[] = readonly MiddlewareContextDefinition[],
> {
	readonly id: string;
	readonly description: string;
	readonly requires?: Requires;
	readonly provides?: Provides;
	readonly resources?: DefinitionInput<MiddlewareResourceDefinition>;
	readonly problems?: DefinitionInput<ProblemDefinition>;
	readonly permissions?: DefinitionInput<CatalogEntryIdentity>;
	readonly entitlements?: DefinitionInput<CatalogEntryIdentity>;
	readonly authentication?: DefinitionInput<CatalogEntryIdentity>;
	readonly resiliency?: ResilienceInput;
	readonly documentation?: Readonly<{ readonly url?: string; readonly notes?: string }>;
}


/** Required contexts represented by one middleware authoring input. */
export type MiddlewareRequires<Input extends MiddlewareDefinitionInput> =
	Input extends { readonly requires: infer Requires extends readonly MiddlewareContextDefinition[] }
		? Requires
		: readonly [];

/** Provided contexts represented by one middleware authoring input. */
export type MiddlewareProvides<Input extends MiddlewareDefinitionInput> =
	Input extends { readonly provides: infer Provides extends readonly MiddlewareContextDefinition[] }
		? Provides
		: readonly [];

/** Resource definitions represented by one middleware input. */
export type MiddlewareResources<Input extends MiddlewareDefinitionInput> = Extract<
	DefinitionEntry<NonNullable<Input['resources']>>,
	MiddlewareResourceDefinition
>;

/** Problem definitions represented by one middleware input. */
export type MiddlewareProblems<Input extends MiddlewareDefinitionInput> = Extract<
	DefinitionEntry<NonNullable<Input['problems']>>,
	ProblemDefinition
>;

/** Typed context store visible to one middleware handler. */
export interface MiddlewareContextStore<Allowed extends MiddlewareContextDefinition = MiddlewareContextDefinition> {
	has<Definition extends Allowed>(definition: Definition): boolean;
	get<Definition extends Allowed>(definition: Definition): MiddlewareContextValue<Definition>;
	set<Definition extends Allowed>(definition: Definition, value: MiddlewareContextValue<Definition>): void;
}

/** Resource resolver constrained to the middleware declaration envelope. */
export interface MiddlewareResourceResolver<Allowed extends MiddlewareResourceDefinition = MiddlewareResourceDefinition> {
	has<Definition extends Allowed>(definition: Definition): boolean;
	get<Definition extends Allowed>(definition: Definition): Promise<MiddlewareResourceValue<Definition>>;
}

/** Runtime context supplied to a middleware handler by the server adapter. */
export interface MiddlewareHandlerContext<
	Definition extends MiddlewareDefinition = MiddlewareDefinition,
	Host = unknown,
> {
	readonly request: Request;
	readonly host: Host;
	readonly values: MiddlewareContextStore<Definition['requires'][number] | Definition['provides'][number]>;
	readonly resources: MiddlewareResourceResolver<Extract<
		DefinitionEntry<NonNullable<Definition['resources']>>,
		MiddlewareResourceDefinition
	>>;
	readonly ctx: Context;
}

/** Onion-style continuation used by middleware handlers. */
export type MiddlewareNext<Result = unknown> = () => Promise<Result>;

/** Stable key for middleware work that must execute at most once per request. */
export type MiddlewareOnceKey = string | symbol | object;

/** Runtime behavior bound to one exact middleware definition. */
export interface MiddlewareHandler<
	Definition extends MiddlewareDefinition = MiddlewareDefinition,
	Host = unknown,
	Result = unknown,
> {
	readonly kind: 'middleware-handler';
	readonly definition: Definition;
	readonly handle: (
		context: MiddlewareHandlerContext<Definition, Host>,
		next: MiddlewareNext<Result>,
	) => Result | Promise<Result>;
}

/** Supported compiler placement lanes. */
export type MiddlewareLane = 'wholeRequest' | 'beforeValidation' | 'afterValidation' | 'aroundOperation';

/** Use-site placement wrapper around one middleware definition. */
export interface MiddlewareUse<
	Definition extends MiddlewareDefinition = MiddlewareDefinition,
	Lane extends MiddlewareLane = MiddlewareLane,
> {
	readonly kind: 'middleware-use';
	readonly definition: Definition;
	readonly lane: Lane;
}

/** Direct or explicitly placed middleware value accepted by composition fields. */
export type MiddlewareInput =
	| MiddlewareDefinition
	| MiddlewareUse
	| readonly MiddlewareInput[];

/** Normalized deterministic middleware lanes. */
export interface MiddlewarePlan {
	readonly wholeRequest: readonly MiddlewareDefinition[];
	readonly beforeValidation: readonly MiddlewareDefinition[];
	readonly afterValidation: readonly MiddlewareDefinition[];
	readonly aroundOperation: readonly MiddlewareDefinition[];
}

/** One validation issue in a middleware definition or composition. */
export interface MiddlewareValidationIssue {
	readonly code:
		| 'invalid-id'
		| 'duplicate-id'
		| 'duplicate-context-provider'
		| 'missing-required-context';
	readonly message: string;
	readonly definition?: MiddlewareDefinition;
	readonly context?: MiddlewareContextDefinition;
}

/** Deterministic validation result for middleware composition. */
export type MiddlewareValidationResult =
	| Readonly<{ readonly valid: true; readonly plan: MiddlewarePlan }>
	| Readonly<{ readonly valid: false; readonly issues: readonly MiddlewareValidationIssue[] }>;

/** JSON-safe middleware documentation projection. */
export interface MiddlewareDocument {
	readonly id: string;
	readonly description: string;
	readonly requires: readonly string[];
	readonly provides: readonly string[];
	readonly resources: readonly string[];
	readonly problems: readonly string[];
	readonly permissions: readonly string[];
	readonly entitlements: readonly string[];
	readonly resiliency: readonly string[];
	readonly documentation?: Readonly<{ readonly url?: string; readonly notes?: string }>;
}
