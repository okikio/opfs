import type { CatalogEntryIdentity, DefinitionInput } from '@utils/catalog';
import type {
	AnyEndpointHandlerBinding,
	EndpointCompositionInput,
	EndpointDefinition,
	EndpointEntry,
	EndpointHandlerBinding,
	EndpointConcernValues,
	EmptyEndpointHost,
	EndpointGroup,
	EndpointMethod,
	EndpointOperation,
	EndpointInputSource,
	EndpointRuntimeInputValues,
} from '@utils/server/endpoint';
import type { EnvironmentDefinition, EnvironmentManifest } from '@utils/env';
import type { Context } from '@utils/context';
import type {
	MiddlewareContextDefinition,
	MiddlewareContextValue,
	MiddlewareDefinition,
	MiddlewareHandler,
	MiddlewareInput,
	MiddlewarePlan,
} from '@utils/server/middleware';
import type { ResilienceInput, ResiliencePolicy } from '@utils/resilience';
import type { ProblemDefinition, ProblemResult } from '@utils/http/problem';
import type { ResponseCompletion, ResponseDefinition, ResponseResult } from '@utils/http/response';
import type { RequestParsingOptions } from '@utils/http/request';
import type {
	AnyImplementation,
	Collection as ResourceCollection,
	Definition as ResourceDefinition,
	Document as ResourceDocument,
	ImplementationSet as ResourceImplementationSet,
} from '@utils/resource';
import type { Definition as WorkflowDefinition } from '@utils/workflow';

/** Static cross-cutting values contributed by a service or service policy. */
export interface ServiceContributions {
	readonly middleware?: MiddlewareInput;
	readonly authentication?: DefinitionInput<CatalogEntryIdentity>;
	readonly permissions?: DefinitionInput<CatalogEntryIdentity>;
	readonly entitlements?: DefinitionInput<CatalogEntryIdentity>;
	readonly billing?: DefinitionInput<CatalogEntryIdentity>;
	readonly resources?: DefinitionInput<ResourceDefinition>;
	readonly problems?: DefinitionInput<ProblemDefinition>;
	readonly resiliency?: ResilienceInput;
}

/** Additive selector-based overlay for a subset of imported endpoints. */
export interface ServicePolicy extends CatalogEntryIdentity, ServiceContributions {
	readonly kind: 'service-policy';
	readonly endpoints: readonly EndpointEntry[];
}

/** Input accepted by `service.policy()`. */
export type ServicePolicyInput = Readonly<{
	readonly id: string;
	readonly description?: string;
	readonly endpoints: EndpointCompositionInput;
}> & ServiceContributions;

/** Import-safe service definition. */
export interface ServiceDefinition<
	Id extends string = string,
	Path extends string = string,
> extends CatalogEntryIdentity, ServiceContributions {
	readonly kind: 'service';
	readonly id: Id;
	readonly path: Path;
	readonly environment?: EnvironmentDefinition;
	readonly endpoints: readonly EndpointEntry[];
	readonly workflows: readonly WorkflowDefinition[];
	readonly policies: readonly ServicePolicy[];
}

/** Input accepted by `service.define()`. */
export type ServiceDefinitionInput<
	Id extends string = string,
	Path extends string = string,
> = Readonly<{
	readonly id: Id;
	readonly path: Path;
	readonly description?: string;
	readonly environment?: EnvironmentDefinition;
	readonly endpoints: EndpointCompositionInput;
	readonly workflows?: DefinitionInput<WorkflowDefinition>;
	readonly policies?: readonly ServicePolicy[];
}> & ServiceContributions;

/** Exact named subset of a service's imported endpoint graph. */
export interface ServiceSelection<
	Service extends ServiceDefinition = ServiceDefinition,
> extends CatalogEntryIdentity {
	readonly kind: 'service-selection';
	readonly service: Service;
	readonly endpoints: readonly EndpointDefinition[];
}

/** Runtime implementation supplied separately from a service definition. */
export interface ServiceImplementation<
	Definition extends ServiceDefinition = ServiceDefinition,
	Host extends object = EmptyEndpointHost,
> {
	readonly kind: 'service-implementation';
	readonly definition: Definition;
	readonly endpoints: readonly AnyEndpointHandlerBinding[];
	readonly middleware: readonly MiddlewareHandler[];
	readonly resources: ResourceImplementationSet;
	readonly hostType?: Host;
}

/** Input accepted by `service.implement()`. */
export interface ServiceImplementationInput<Host extends object = EmptyEndpointHost> {
	readonly endpoints?: readonly (AnyEndpointHandlerBinding | readonly AnyEndpointHandlerBinding[])[];
	readonly middleware?: readonly MiddlewareHandler[];
	readonly resources?: ResourceImplementationSet;
	readonly hostType?: Host;
}

/** One service route with full import provenance. */
export interface ServiceRoute {
	readonly id: string;
	readonly service: ServiceDefinition;
	readonly endpoint: EndpointDefinition;
	readonly operation: EndpointOperation;
	readonly groups: readonly EndpointGroup[];
	readonly method: EndpointMethod;
	readonly path: string;
}

/** Fully resolved static contract for one operation. */
export interface EffectiveServiceOperation extends ServiceRoute {
	readonly middleware: MiddlewarePlan;
	readonly authentication: readonly CatalogEntryIdentity[];
	readonly permissions: readonly CatalogEntryIdentity[];
	readonly entitlements: readonly CatalogEntryIdentity[];
	readonly billing: readonly CatalogEntryIdentity[];
	readonly resources: readonly ResourceDefinition[];
	readonly problems: readonly ProblemDefinition[];
	readonly responses: readonly ResponseDefinition[];
	readonly resiliency: readonly ResiliencePolicy[];
	readonly handler: AnyEndpointHandlerBinding;
}

/** JSON-safe route manifest used by gateways, tests, and deployments. */
export interface ServiceRouteManifestEntry {
	readonly id: string;
	readonly method: Uppercase<EndpointMethod>;
	readonly path: string;
	readonly operationId: string;
	readonly endpointId: string;
	readonly authentication: readonly string[];
	readonly permissions: readonly string[];
	readonly entitlements: readonly string[];
	readonly billing: readonly string[];
	readonly resources: readonly string[];
	readonly problems: readonly string[];
	readonly responses: readonly string[];
	readonly middleware: Readonly<Record<string, readonly string[]>>;
	readonly resiliency: readonly string[];
}

/** Deterministic compiled service manifest. */
export interface ServiceManifest {
	readonly id: string;
	readonly path: string;
	readonly description?: string;
	readonly routes: readonly ServiceRouteManifestEntry[];
	readonly environment?: EnvironmentManifest;
	readonly resources: readonly string[];
	readonly resourceGraph: readonly ResourceDocument[];
	readonly permissions: readonly string[];
	readonly entitlements: readonly string[];
	readonly billing: readonly string[];
	readonly problems: readonly string[];
	readonly responses: readonly string[];
	readonly middleware: readonly string[];
	readonly resiliency: readonly string[];
	readonly workflows: readonly string[];
}

/** Compiled service ready for runtime creation and artifact generation. */
export interface CompiledService<
	Definition extends ServiceDefinition = ServiceDefinition,
	Host extends object = EmptyEndpointHost,
> {
	readonly kind: 'compiled-service';
	readonly definition: Definition;
	readonly implementation: ServiceImplementation<Definition, Host>;
	readonly operations: readonly EffectiveServiceOperation[];
	readonly manifest: ServiceManifest;
}


/** Definition or implementation value that may be attached to a compiler issue. */
export type ServiceValidationSubject =
	| CatalogEntryIdentity
	| ServiceRoute
	| AnyEndpointHandlerBinding
	| MiddlewareHandler
	| AnyImplementation
	| ResiliencePolicy;

/** One compiler validation issue. */
export interface ServiceValidationIssue {
	readonly code:
		| 'invalid-definition'
		| 'invalid-endpoint'
		| 'policy-target-outside-service'
		| 'route-conflict'
		| 'operation-id-conflict'
		| 'missing-endpoint-handler'
		| 'extraneous-endpoint-handler'
		| 'missing-middleware-handler'
		| 'extraneous-middleware-handler'
		| 'missing-resource-implementation'
		| 'resource-conflict'
		| 'invalid-resiliency'
		| 'missing-environment'
		| 'environment-conflict';
	readonly message: string;
	readonly definition?: ServiceValidationSubject;
}

/** Validation result for a definition or implementation. */
export type ServiceValidationResult =
	| Readonly<{ readonly valid: true; readonly routes: readonly ServiceRoute[] }>
	| Readonly<{ readonly valid: false; readonly issues: readonly ServiceValidationIssue[] }>;


/**
 * Exact application concern values propagated through one request.
 *
 * Identity, authorization, and billing packages specialize this interface with
 * their provider-neutral domain types. `utils/server` only coordinates the
 * stages and never imports those domain packages.
 */
export type ServiceConcernValues = EndpointConcernValues;

/** Validated values grouped by HTTP request location. */
export type ServiceInputValues = EndpointRuntimeInputValues;

/** Request values exposed to service concern runtimes. */
export interface ServiceRequestState<
	Host extends object = EmptyEndpointHost,
	Concerns extends ServiceConcernValues = ServiceConcernValues,
> {
	readonly request: Request;
	readonly host: Host;
	readonly ctx: Context;
	readonly input: ServiceInputValues;
	readonly resources: ResourceCollection;
	readonly values: ServiceContextStore;
	readonly operation: EffectiveServiceOperation;
	readonly authentication?: Concerns['authentication'];
	readonly actor?: Concerns['actor'];
	readonly organization?: Concerns['organization'];
	readonly authorization?: Concerns['authorization'];
	readonly entitlementState?: Concerns['entitlements'];
	readonly billingState?: Concerns['billing'];
}

/** Patch returned by a concern runtime after successful evaluation. */
export interface ServiceRequestStatePatch<Concerns extends ServiceConcernValues = ServiceConcernValues> {
	readonly authentication?: Concerns['authentication'];
	readonly actor?: Concerns['actor'];
	readonly organization?: Concerns['organization'];
	readonly authorization?: Concerns['authorization'];
	readonly entitlementState?: Concerns['entitlements'];
	readonly billingState?: Concerns['billing'];
}

/**
 * Host adapter for resilience policies not implemented by the generic server.
 *
 * Timeout and body limits are native. Admission/idempotency/retry/circuit and
 * bulkhead semantics require an explicit durable or distributed host adapter.
 */
export interface ServiceResilienceRuntime<Host extends object = EmptyEndpointHost, Concerns extends ServiceConcernValues = ServiceConcernValues> {
	supports(policy: ResiliencePolicy): boolean;
	execute(
		policies: readonly ResiliencePolicy[],
		state: ServiceRequestState<Host, Concerns>,
		next: () => Promise<ServiceStageResult>,
	): Promise<ServiceStageResult>;
}

/** Provider/domain concern runtimes supplied by a composition root. */
export interface ServiceConcernRuntimes<Host extends object = EmptyEndpointHost, Concerns extends ServiceConcernValues = ServiceConcernValues> {
	readonly authenticate?: (
		requirements: readonly CatalogEntryIdentity[],
		state: ServiceRequestState<Host, Concerns>,
	) => Promise<ServiceRequestStatePatch<Concerns> | ProblemResult | void>;
	readonly authorize?: (
		permissions: readonly CatalogEntryIdentity[],
		state: ServiceRequestState<Host, Concerns>,
	) => Promise<ServiceRequestStatePatch<Concerns> | ProblemResult | void>;
	readonly entitlements?: (
		entitlements: readonly CatalogEntryIdentity[],
		state: ServiceRequestState<Host, Concerns>,
	) => Promise<ServiceRequestStatePatch<Concerns> | ProblemResult | void>;
	readonly billing?: (
		billing: readonly CatalogEntryIdentity[],
		state: ServiceRequestState<Host, Concerns>,
	) => Promise<ServiceRequestStatePatch<Concerns> | ProblemResult | void>;
	readonly resilience?: ServiceResilienceRuntime<Host, Concerns>;
}

/** Direct-identity context store used by middleware and concern adapters. */
export interface ServiceContextStore {
	has<Definition extends MiddlewareContextDefinition>(definition: Definition): boolean;
	get<Definition extends MiddlewareContextDefinition>(definition: Definition): MiddlewareContextValue<Definition>;
	set<Definition extends MiddlewareContextDefinition>(
		definition: Definition,
		value: MiddlewareContextValue<Definition>,
	): void;
}

/** Options used to create a live Hono service runtime. */
export interface CreateServiceOptions<Host extends object = EmptyEndpointHost, Concerns extends ServiceConcernValues = ServiceConcernValues> {
	readonly environment?: Readonly<Record<string, unknown>>;
	readonly host: Host;
	readonly concerns?: ServiceConcernRuntimes<Host, Concerns>;
	readonly requestParsing?: RequestParsingOptions;
	readonly onError?: (error: Error, state?: ServiceRequestState<Host, Concerns>) => void | Promise<void>;
	readonly onResponseComplete?: (event: Readonly<{
		readonly requestId: string;
		readonly operationId: string;
		readonly method: string;
		readonly path: string;
		readonly status: number;
		readonly completion: ResponseCompletion;
	}>) => void | Promise<void>;
	readonly requestId?: (request: Request) => string;
	readonly traceId?: (request: Request) => string | undefined;
}

/** Live service runtime owned by one host. */
export interface ServiceRuntime extends AsyncDisposable {
	readonly fetch: (request: Request) => Response | Promise<Response>;
	readonly resources: ResourceCollection;
}

/** Result returned by a middleware or concern stage. */
export type ServiceStageResult =
	| ResponseResult
	| ProblemResult
	| Response
	| void;
