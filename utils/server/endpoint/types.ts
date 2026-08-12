import type { StandardSchemaV1 } from '@standard-schema/spec';
import type {
	CatalogEntryIdentity,
	CatalogEntryValue,
	DefinitionEntry,
	DefinitionInput,
	ValuedCatalogEntry,
} from '@utils/catalog';
import type { ProblemDefinition, ProblemResult } from '@utils/http/problem';
import type { ResponseDefinition, ResponseResult } from '@utils/http/response';
import type { Context } from '@utils/context';
import type { MiddlewareInput } from '@utils/server/middleware';
import type { ResilienceInput } from '@utils/resilience';


/** Static resource reference accepted by portable endpoint contracts. */
export type EndpointResourceDefinition<Value = unknown> = ValuedCatalogEntry<'resource', Value>;

/** Runtime value represented by one endpoint resource reference. */
export type EndpointResourceValue<Definition extends EndpointResourceDefinition> = CatalogEntryValue<Definition>;

/** HTTP methods supported by endpoint definitions. */
export type EndpointMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';

/** Request locations understood by the endpoint compiler. */
export type EndpointInputSource = 'param' | 'query' | 'header' | 'cookie' | 'json' | 'form' | 'raw';

/** Standard Schema-compatible runtime validation contract. */
export type EndpointSchema<Input = unknown, Output = Input> = StandardSchemaV1<Input, Output>;

/** Concrete request or response example retained for generated documentation. */
export interface EndpointExample<Value = unknown> {
	readonly key: string;
	readonly summary?: string;
	readonly description?: string;
	readonly value: Value;
}

/** Transport-specific documentation wrapped around a first-class schema. */
export interface EndpointInput<Schema extends EndpointSchema = EndpointSchema> {
	readonly kind: 'endpoint-input';
	readonly schema: Schema;
	readonly description?: string;
	readonly required?: boolean;
	readonly contentType?: string;
	readonly examples?: readonly EndpointExample[];
	readonly jsonSchema?: unknown;
}

/** Bare or documented schema accepted by one request location. */
export type EndpointInputSlot<Schema extends EndpointSchema = EndpointSchema> = Schema | EndpointInput<Schema>;

/** Flat request input locations accepted by operations and paths. */
export interface EndpointInputSlots {
	readonly param?: EndpointInputSlot;
	readonly query?: EndpointInputSlot;
	readonly header?: EndpointInputSlot;
	readonly cookie?: EndpointInputSlot;
	readonly json?: EndpointInputSlot;
	readonly form?: EndpointInputSlot;
	readonly raw?: EndpointInputSlot;
}

/** Extract the schema carried by one endpoint input slot. */
export type EndpointInputSchema<Slot> = Slot extends EndpointInput<infer Schema>
	? Schema
	: Slot extends EndpointSchema ? Slot
	: never;

/** Parsed output values exposed to an endpoint handler. */
export type InferEndpointInputs<Inputs extends EndpointInputSlots> = {
	readonly [Source in keyof Inputs as Inputs[Source] extends undefined ? never : Source]:
		StandardSchemaV1.InferOutput<EndpointInputSchema<NonNullable<Inputs[Source]>>>;
};

/** Merge path-level inputs with operation-level inputs. */
export type MergeEndpointInputs<
	Shared extends EndpointInputSlots,
	Operation extends EndpointInputSlots,
> = Omit<Shared, keyof Operation> & Operation;

/** Static cross-cutting values contributed by a group, path, or operation. */
export interface EndpointContributions {
	readonly middleware?: MiddlewareInput;
	readonly authentication?: DefinitionInput<CatalogEntryIdentity>;
	readonly permissions?: DefinitionInput<CatalogEntryIdentity>;
	readonly entitlements?: DefinitionInput<CatalogEntryIdentity>;
	readonly billing?: DefinitionInput<CatalogEntryIdentity>;
	readonly resources?: DefinitionInput<EndpointResourceDefinition>;
	readonly problems?: DefinitionInput<ProblemDefinition>;
	readonly responses?: DefinitionInput<ResponseDefinition>;
	readonly resiliency?: ResilienceInput;
}

/** Common human-facing metadata for endpoint definitions. */
export interface EndpointDocumentation {
	readonly operationId?: string;
	readonly summary?: string;
	readonly description?: string;
	readonly tags?: readonly string[];
	readonly deprecated?: boolean;
	readonly internal?: boolean;
}

/** Input accepted by a method-operation definition. */
export type EndpointOperationInput = Readonly<{
	readonly id: string;
	readonly method?: EndpointMethod;
	readonly rawResponse?: boolean;
}> & EndpointDocumentation & EndpointInputSlots & EndpointContributions;

/** Pick only explicitly authored request-location fields from a flat endpoint input. */
type ExplicitEndpointInputSlots<Input> = {
	readonly [Source in EndpointInputSource as Input extends Readonly<Record<Source, infer Slot>>
		? Exclude<Slot, undefined> extends EndpointInputSlot ? Source : never
		: never]: Input extends Readonly<Record<Source, infer Slot>> ? Exclude<Slot, undefined> : never;
};

/** Preserve exact authored schemas while retaining a broad shape for heterogeneous operations. */
export type PickEndpointInputSlots<Input> = Input extends EndpointOperationInput
	? EndpointOperationInput extends Input ? EndpointInputSlots : ExplicitEndpointInputSlots<Input>
	: ExplicitEndpointInputSlots<Input>;

/** Immutable path-independent method contract. */
export interface EndpointOperation<
	Method extends EndpointMethod = EndpointMethod,
	Inputs extends EndpointInputSlots = EndpointInputSlots,
	Responses extends ResponseDefinition = ResponseDefinition,
	Problems extends ProblemDefinition = ProblemDefinition,
	Resources extends EndpointResourceDefinition = EndpointResourceDefinition,
> extends CatalogEntryIdentity, EndpointDocumentation, Omit<EndpointContributions, 'responses' | 'problems' | 'resources'> {
	readonly kind: 'endpoint-operation';
	readonly method: Method;
	readonly operationId: string;
	readonly inputs: Inputs;
	readonly responses?: DefinitionInput<Responses>;
	readonly problems?: DefinitionInput<Problems>;
	readonly resources?: DefinitionInput<Resources>;
	readonly rawResponse: boolean;
}

/** Response definitions represented by one operation authoring input. */
export type EndpointOperationResponses<Input extends EndpointOperationInput> = Extract<
	DefinitionEntry<NonNullable<Input['responses']>>,
	ResponseDefinition
>;

/** Problem definitions represented by one operation authoring input. */
export type EndpointOperationProblems<Input extends EndpointOperationInput> = Extract<
	DefinitionEntry<NonNullable<Input['problems']>>,
	ProblemDefinition
>;

/** Resource definitions represented by one operation authoring input. */
export type EndpointOperationResources<Input extends EndpointOperationInput> = Extract<
	DefinitionEntry<NonNullable<Input['resources']>>,
	EndpointResourceDefinition
>;

/** Fully inferred operation type produced from one authoring input. */
export type DefinedEndpointOperation<
	Method extends EndpointMethod,
	Input extends EndpointOperationInput,
> = EndpointOperation<
	Method,
	PickEndpointInputSlots<Input>,
	EndpointOperationResponses<Input>,
	EndpointOperationProblems<Input>,
	EndpointOperationResources<Input>
>;


/** Input accepted by a multi-method endpoint path. */
export type EndpointDefinitionInput<
	Path extends string = string,
	Operations extends readonly EndpointOperation[] = readonly EndpointOperation[],
> = Readonly<{
	readonly id: string;
	readonly path: Path;
	readonly operations: Operations;
}> & Omit<EndpointDocumentation, 'operationId'> & EndpointInputSlots & Omit<EndpointContributions, 'responses' | 'billing'>;

/** Immutable path contract containing one or more method operations. */
export interface EndpointDefinition<
	Path extends string = string,
	SharedInput extends EndpointInputSlots = EndpointInputSlots,
	Operations extends readonly EndpointOperation[] = readonly EndpointOperation[],
	Resources extends EndpointResourceDefinition = EndpointResourceDefinition,
	Problems extends ProblemDefinition = ProblemDefinition,
> extends CatalogEntryIdentity, Omit<EndpointDocumentation, 'operationId'>,
	Omit<EndpointContributions, 'responses' | 'billing' | 'resources' | 'problems'> {
	readonly kind: 'endpoint';
	readonly path: Path;
	readonly inputs: SharedInput;
	readonly operations: Operations;
	readonly resources?: DefinitionInput<Resources>;
	readonly problems?: DefinitionInput<Problems>;
}

/** Resource definitions represented by one endpoint path authoring input. */
export type EndpointDefinitionResources<Input extends EndpointContributions> = Extract<
	DefinitionEntry<NonNullable<Input['resources']>>,
	EndpointResourceDefinition
>;

/** Problem definitions represented by one endpoint path authoring input. */
export type EndpointDefinitionProblems<Input extends EndpointContributions> = Extract<
	DefinitionEntry<NonNullable<Input['problems']>>,
	ProblemDefinition
>;

/** Complete single-method endpoint authoring input. */
export type SingleMethodEndpointInput<
	Path extends string = string,
> = Readonly<{ readonly id: string; readonly path: Path; readonly rawResponse?: boolean }> &
	EndpointDocumentation & EndpointInputSlots & EndpointContributions;

/** One concrete endpoint, group, or group selection accepted by composition. */
export type EndpointEntry = EndpointDefinition | EndpointGroup | EndpointGroupSelection;

/** Recursive endpoint composition input accepted by groups, services, and gateways. */
export type EndpointCompositionInput = EndpointEntry | readonly EndpointCompositionInput[];

/** Named or direct endpoint-group members. */
export type EndpointGroupMembers =
	| Readonly<Record<string, EndpointEntry>>
	| EndpointCompositionInput;

/** Input accepted by an endpoint group. */
export type EndpointGroupInput<
	Path extends string = string,
	Members extends EndpointGroupMembers = EndpointGroupMembers,
> = Readonly<{
	readonly id: string;
	readonly path: Path;
	readonly endpoints: Members;
}> & Omit<EndpointDocumentation, 'operationId'> & Omit<EndpointContributions, 'responses' | 'billing'>;

/** Static endpoint group with a shared path prefix and contributions. */
export interface EndpointGroup<
	Path extends string = string,
	Entries extends Readonly<Record<string, EndpointEntry>> | undefined = Readonly<Record<string, EndpointEntry>> | undefined,
> extends CatalogEntryIdentity, Omit<EndpointDocumentation, 'operationId'>, Omit<EndpointContributions, 'responses' | 'billing'> {
	readonly kind: 'endpoint-group';
	readonly path: Path;
	readonly endpoints: readonly EndpointEntry[];
	readonly entries?: Entries;
}

/** Key-preserving immutable selection from a named endpoint group. */
export interface EndpointGroupSelection<
	Group extends EndpointGroup = EndpointGroup,
	Entries extends Readonly<Record<string, EndpointEntry>> = Readonly<Record<string, EndpointEntry>>,
> extends CatalogEntryIdentity {
	readonly kind: 'endpoint-group-selection';
	readonly source: Group;
	readonly keys: readonly (keyof Entries & string)[];
	readonly endpoints: readonly EndpointEntry[];
}

/** One deterministic endpoint validation issue. */
export interface EndpointValidationIssue {
	readonly code:
		| 'invalid-id'
		| 'invalid-path'
		| 'missing-operation'
		| 'missing-result'
		| 'duplicate-method'
		| 'duplicate-id'
		| 'duplicate-operation-id'
		| 'body-method-conflict'
		| 'raw-body-conflict'
		| 'missing-path-schema'
		| 'ambiguous-route';
	readonly message: string;
	readonly definition?: EndpointEntry | EndpointOperation;
}

/** Deterministic endpoint validation result. */
export type EndpointValidationResult =
	| Readonly<{ readonly valid: true; readonly endpoints: readonly EndpointDefinition[] }>
	| Readonly<{ readonly valid: false; readonly issues: readonly EndpointValidationIssue[] }>;

/** JSON-safe operation projection. */
export interface EndpointOperationDocument {
	readonly id: string;
	readonly method: EndpointMethod;
	readonly operationId: string;
	readonly summary?: string;
	readonly description?: string;
	readonly tags: readonly string[];
	readonly deprecated: boolean;
	readonly internal: boolean;
	readonly inputs: readonly EndpointInputSource[];
	readonly responses: readonly string[];
	readonly problems: readonly string[];
	readonly resources: readonly string[];
}

/** JSON-safe endpoint projection with fully composed path. */
export interface EndpointDocument {
	readonly id: string;
	readonly path: string;
	readonly groupIds: readonly string[];
	readonly operations: readonly EndpointOperationDocument[];
}

/** Resource definition union retained by an operation. */
export type OperationResource<Operation extends EndpointOperation> =
	Operation extends EndpointOperation<EndpointMethod, EndpointInputSlots, ResponseDefinition, ProblemDefinition, infer Resource>
		? Resource
		: never;

/** Resource definition union retained by an endpoint path. */
export type PathResource<Endpoint extends EndpointDefinition> =
	Endpoint extends EndpointDefinition<string, EndpointInputSlots, readonly EndpointOperation[], infer Resource, ProblemDefinition>
		? Resource
		: never;

/** Effective resource definitions available to an endpoint handler. */
export type EndpointResources<
	Endpoint extends EndpointDefinition,
	Operation extends EndpointOperation,
> = PathResource<Endpoint> | OperationResource<Operation>;

/** Resolver constrained to resources declared by the effective operation. */
export interface EndpointResourceResolver<Allowed extends EndpointResourceDefinition = EndpointResourceDefinition> {
	has<Definition extends Allowed>(definition: Definition): boolean;
	get<Definition extends Allowed>(definition: Definition): Promise<EndpointResourceValue<Definition>>;
}

/** Request execution context propagated by the owning host. */
export type EndpointContext = Context;


/**
 * Provider-neutral request concern values attached by a service runtime.
 *
 * Domain packages may specialize these fields with their exact identity,
 * authorization, entitlement, and billing types. The portable endpoint package
 * intentionally requires structured objects instead of accepting arbitrary data.
 */
export interface EndpointConcernValues {
	readonly authentication?: object;
	readonly actor?: object;
	readonly organization?: object;
	readonly authorization?: object;
	readonly entitlements?: object;
	readonly billing?: object;
}

/** Empty host value used when an endpoint handler does not require host state. */
export type EmptyEndpointHost = Readonly<Record<never, never>>;

/** Portable handler context specialized by a service runtime adapter. */
export interface EndpointHandlerContext<
	Endpoint extends EndpointDefinition = EndpointDefinition,
	Operation extends EndpointOperation = EndpointOperation,
	Host extends object = EmptyEndpointHost,
	Concerns extends EndpointConcernValues = EndpointConcernValues,
> {
	readonly request: Request;
	readonly host: Host;
	readonly input: InferEndpointInputs<MergeEndpointInputs<Endpoint['inputs'], Operation['inputs']>>;
	readonly resources: EndpointResourceResolver<EndpointResources<Endpoint, Operation>>;
	readonly ctx: EndpointContext;
	readonly authentication?: Concerns['authentication'];
	readonly actor?: Concerns['actor'];
	readonly organization?: Concerns['organization'];
	readonly authorization?: Concerns['authorization'];
	readonly entitlements?: Concerns['entitlements'];
	readonly billing?: Concerns['billing'];
}

/** Response definition union retained by an operation. */
export type OperationResponse<Operation extends EndpointOperation> =
	Operation extends EndpointOperation<EndpointMethod, EndpointInputSlots, infer ResponseDefinition_, ProblemDefinition, EndpointResourceDefinition>
		? ResponseDefinition_
		: never;

/** Problem definition union retained by an operation. */
export type OperationProblem<Operation extends EndpointOperation> =
	Operation extends EndpointOperation<EndpointMethod, EndpointInputSlots, ResponseDefinition, infer ProblemDefinition_, EndpointResourceDefinition>
		? ProblemDefinition_
		: never;

/** Declared result union for one endpoint operation. */
export type EndpointHandlerResult<Operation extends EndpointOperation> =
	| ResponseResult<OperationResponse<Operation>>
	| ProblemResult<OperationProblem<Operation>>
	| (Operation['rawResponse'] extends true ? Response : never);

/** Handler function for one exact endpoint operation. */
export type EndpointHandler<
	Endpoint extends EndpointDefinition,
	Operation extends EndpointOperation,
	Host extends object = EmptyEndpointHost,
	Concerns extends EndpointConcernValues = EndpointConcernValues,
> = (
	context: EndpointHandlerContext<Endpoint, Operation, Host, Concerns>,
) => EndpointHandlerResult<Operation> | Promise<EndpointHandlerResult<Operation>>;

/** Direct binding between imported endpoint/operation values and behavior. */
export interface EndpointHandlerBinding<
	Endpoint extends EndpointDefinition = EndpointDefinition,
	Operation extends EndpointOperation = EndpointOperation,
	Host extends object = EmptyEndpointHost,
	Concerns extends EndpointConcernValues = EndpointConcernValues,
> {
	readonly kind: 'endpoint-handler';
	readonly endpoint: Endpoint;
	readonly operation: Operation;
	readonly handle: EndpointHandler<Endpoint, Operation, Host, Concerns>;
}


/** Values retained after request-location parsing but before handler specialization. */
export type EndpointRuntimeInputValues = Readonly<Partial<Record<
	EndpointInputSource,
	object | string | number | boolean | bigint | symbol | null | undefined
>>>;

/** Runtime context shape shared by heterogeneous compiled handler collections. */
export interface ErasedEndpointHandlerContext {
	readonly request: Request;
	readonly host: object;
	readonly input: EndpointRuntimeInputValues;
	readonly resources: EndpointResourceResolver;
	readonly ctx: EndpointContext;
	readonly authentication?: object;
	readonly actor?: object;
	readonly organization?: object;
	readonly authorization?: object;
	readonly entitlements?: object;
	readonly billing?: object;
}

/**
 * Callable shape used to retain differently specialized endpoint handlers in one
 * compiled collection.
 *
 * The method-signature extraction intentionally makes the parameter bivariant.
 * Each handler remains exact at `handler()` authoring sites, while heterogeneous
 * service composition can retain those handlers without replacing their known
 * context with `any`, `unknown`, or a `never` cast. The service compiler still
 * invokes a binding only for its exact endpoint and operation identities.
 */
export type AnyEndpointHandler = {
	bivarianceHack(
		context: ErasedEndpointHandlerContext,
	): EndpointHandlerResult<EndpointOperation> | Promise<EndpointHandlerResult<EndpointOperation>>;
}['bivarianceHack'];

/** Runtime-erased endpoint binding used by heterogeneous composition utilities. */
export interface AnyEndpointHandlerBinding {
	readonly kind: 'endpoint-handler';
	readonly endpoint: EndpointDefinition;
	readonly operation: EndpointOperation;
	readonly handle: AnyEndpointHandler;
}

/** Complete handler set for a multi-method endpoint. */
export interface EndpointHandlerSet<
	Endpoint extends EndpointDefinition = EndpointDefinition,
	Bindings extends readonly AnyEndpointHandlerBinding[] = readonly AnyEndpointHandlerBinding[],
> {
	readonly kind: 'endpoint-handlers';
	readonly endpoint: Endpoint;
	readonly bindings: Bindings;
}
