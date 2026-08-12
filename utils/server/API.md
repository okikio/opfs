@utils/server public API usage
==============================

Purpose
-------

This reference maps every public export target declared by `@utils/server` to its role and to a concrete repository use when one exists.

The package README teaches the programming model progressively.  This file is the exhaustive lookup surface for developers who already know the model.

@utils/server
-------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `endpoint` | namespace | Server composition namespaces. | `endpoint.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `gateway` | namespace | Public contract documented by the source declaration. | `gateway.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayProblems` | value | Framework-owned failures emitted before an origin service receives a request. | `GatewayProblems` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `middleware` | namespace | Public contract documented by the source declaration. | `middleware.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServerProblems` | value | Framework-level public and internal problems contributed by the service compiler. | `ServerProblems` | `.agents/support/production-fixture.ts:642` uses `ServerProblems`. |
| `service` | namespace | Public contract documented by the source declaration. | `service.…` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`ServerProblems` appears in `.agents/support/production-fixture.ts:642`:

~~~~ typescript
if (key === null) return problem.create(ServerProblems.InvalidRequest, { detail: `${policy.header} is required.` });
					const body = JSON.stringify(state.input.json ?? null);
					const existing = idempotency.get(key);
					if (existing !== undefined) {
~~~~

@utils/server/gateway
---------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `compile` | function | Compile exact service route artifacts into one deterministic edge route table. | `compile(...)` | `.agents/support/production-fixture.ts:657` uses `compile`. |
| `CompiledGateway` | interface | Compiled gateway ready for a host runtime. | `value: CompiledGateway` | `.agents/support/production-fixture.ts:367` uses `CompiledGateway`. |
| `CompiledGatewayRoute` | interface | Fully resolved edge route. | `value: CompiledGatewayRoute` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `CompileGatewayOptions` | interface | Options supplied to `gateway.compile()`. | `value: CompileGatewayOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `compose` | function | Compose gateway definitions or selections by direct identity. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:271` uses `compose`. |
| `create` | function | Create a fetch-compatible runtime from one compiled gateway. | `create(...)` | `.agents/support/production-fixture.ts:658` uses `create`. |
| `CreateGatewayOptions` | interface | Runtime options for one compiled gateway. | `value: CreateGatewayOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `credentials` | function | Define explicit request/response credential forwarding behavior. | `credentials(...)` | `.agents/support/production-fixture.ts:355` uses `credentials`. |
| `define` | function | Define an import-safe gateway from exact mounted service references. | `define(...)` | `.agents/support/production-fixture.ts:344` uses `define`. |
| `document` | function | Return the JSON-safe gateway manifest retained by a compiled gateway. | `document(...)` | `.agents/tests/public-api-repetition.test.ts:106` uses `document`. |
| `GatewayCachePolicy` | type | Gateway cache behavior. | `value: GatewayCachePolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayCompilationError` | class | Error raised when a gateway cannot be compiled safely. | `new GatewayCompilationError(...)` | `.agents/tests/public-api-repetition.test.ts:114` uses `GatewayCompilationError`. |
| `GatewayConcernRuntimes` | interface | Host-specific gateway concern runtimes. | `value: GatewayConcernRuntimes` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayCredentialPolicy` | interface | Explicit caller credential forwarding policy. | `value: GatewayCredentialPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayDefinition` | interface | Import-safe gateway definition. | `value: GatewayDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayDefinitionInput` | interface | Input accepted by `gateway.define()`. | `value: GatewayDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayManifest` | interface | Deterministic compiled gateway manifest. | `value: GatewayManifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayMount` | interface | One exact service or service selection mounted at an origin. | `value: GatewayMount` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayObserverDefinition` | interface | Import-safe subscription to redacted gateway lifecycle events. | `value: GatewayObserverDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayObserverEvent` | interface | Redacted gateway lifecycle event. | `value: GatewayObserverEvent` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayObserverEventKind` | type | Gateway lifecycle events available to redacted observers. | `value: GatewayObserverEventKind` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayObserverHandler` | interface | Runtime handler bound to an exact observer definition. | `value: GatewayObserverHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayOrigin` | type | Host-resolved origin for one independently deployed service. | `value: GatewayOrigin` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayPolicy` | interface | Additive edge behavior for exact imported endpoints. | `value: GatewayPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayPolicyInput` | interface | Input accepted by `gateway.policy()`. | `value: GatewayPolicyInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayProblems` | value | Framework-owned failures emitted before an origin service receives a request. | `GatewayProblems` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayRedirectPolicy` | interface | Upstream Location handling policy for manual redirects. | `value: GatewayRedirectPolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayRequestPatch` | interface | Patch produced by one gateway edge adapter. | `value: GatewayRequestPatch` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayRequestState` | interface | Request state visible to gateway authentication and assertion adapters. | `value: GatewayRequestState` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayRouteManifestEntry` | interface | JSON-safe gateway route manifest. | `value: GatewayRouteManifestEntry` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayRuntime` | interface | Live gateway request handler. | `value: GatewayRuntime` | `.agents/support/production-fixture.ts:362` uses `GatewayRuntime`. |
| `GatewaySelection` | interface | Named gateway subset that preserves exact mount references. | `value: GatewaySelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayServiceArtifact` | type | One concrete service artifact supplied to gateway compilation. | `value: GatewayServiceArtifact` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayValidationIssue` | interface | One validation issue emitted by the gateway compiler. | `value: GatewayValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayValidationResult` | type | Deterministic gateway validation result. | `value: GatewayValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `GatewayValidationSubject` | type | Definition value that may be attached to one gateway compiler issue. | `value: GatewayValidationSubject` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `mount` | function | Mount an exact service definition or selection at one origin. | `mount(...)` | `.agents/support/production-fixture.ts:346` uses `mount`. |
| `noStore` | function | Disable storage by shared or browser caches. | `noStore(...)` | `.agents/support/production-fixture.ts:354` uses `noStore`. |
| `observer` | value | Gateway lifecycle observer definition and handler namespace. | `observer` | `.agents/support/production-fixture.ts:343` uses `observer`. |
| `passThroughCache` | function | Preserve origin cache headers without adding gateway storage behavior. | `passThroughCache(...)` | `.agents/tests/public-api-matrix.test.ts:272` uses `passThroughCache`. |
| `policy` | function | Define one selector-based additive gateway policy. | `policy(...)` | `.agents/support/production-fixture.ts:347` uses `policy`. |
| `redirects` | function | Define how upstream manual redirect locations are exposed publicly. | `redirects(...)` | `.agents/support/production-fixture.ts:356` uses `redirects`. |
| `select` | function | Select exact mounts from one gateway without copying routes. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:267` uses `select`. |
| `validate` | function | Validate mount and policy ownership without requiring service artifacts. | `validate(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:271`:

~~~~ typescript
assert.equal(gateway.compose(gatewayDefinition, gatewaySelection).length, 2);
			assert.equal(gateway.passThroughCache().mode, 'pass-through');
		}
~~~~

`credentials` appears in `.agents/support/production-fixture.ts:355`:

~~~~ typescript
credentials: gateway.credentials({ requestAuthorization: 'strip-after-authentication' }),
		redirects: gateway.redirects({ mode: 'reject-cross-origin' }),
	})],
	observers: [GatewayObserver],
~~~~

`define` appears in `.agents/support/production-fixture.ts:344`:

~~~~ typescript
const GatewayDefinition = gateway.define({
	id: 'validation-gateway',
	services: [gateway.mount(ServiceDefinition, { origin: 'https://validation-service.internal' })],
	policies: [gateway.policy({
~~~~

`mount` appears in `.agents/support/production-fixture.ts:346`:

~~~~ typescript
services: [gateway.mount(ServiceDefinition, { origin: 'https://validation-service.internal' })],
	policies: [gateway.policy({
		id: 'validation.gateway-import-policy',
		endpoints: [StartImport, GetImport],
~~~~

`noStore` appears in `.agents/support/production-fixture.ts:354`:

~~~~ typescript
cache: gateway.noStore(),
		credentials: gateway.credentials({ requestAuthorization: 'strip-after-authentication' }),
		redirects: gateway.redirects({ mode: 'reject-cross-origin' }),
	})],
~~~~

`observer` appears in `.agents/support/production-fixture.ts:343`:

~~~~ typescript
const GatewayObserver = gateway.observer.define({ id: 'validation.gateway-observer', description: 'Trace synthetic gateway lifecycle events.' });
const GatewayDefinition = gateway.define({
	id: 'validation-gateway',
	services: [gateway.mount(ServiceDefinition, { origin: 'https://validation-service.internal' })],
~~~~

`passThroughCache` appears in `.agents/tests/public-api-matrix.test.ts:272`:

~~~~ typescript
assert.equal(gateway.passThroughCache().mode, 'pass-through');
		}

		const problems = problem.catalog('matrix.problems', { ProblemA, ProblemB });
~~~~

`policy` appears in `.agents/support/production-fixture.ts:347`:

~~~~ typescript
policies: [gateway.policy({
		id: 'validation.gateway-import-policy',
		endpoints: [StartImport, GetImport],
		authenticate: GatewayAuthentication,
~~~~

`redirects` appears in `.agents/support/production-fixture.ts:356`:

~~~~ typescript
redirects: gateway.redirects({ mode: 'reject-cross-origin' }),
	})],
	observers: [GatewayObserver],
});
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:267`:

~~~~ typescript
const gatewaySelection = gateway.select(gatewayDefinition, {
				id: `matrix-gateway-selection-${index}`,
				services: [serviceDefinition],
			});
~~~~

`compile` appears in `.agents/support/production-fixture.ts:657`:

~~~~ typescript
const compiledGateway = gateway.compile(GatewayDefinition, { services: [compiledService] });
	const gatewayRuntime = gateway.create(compiledGateway, {
		requestId: (() => {
			let sequence = 0;
~~~~

`document` appears in `.agents/tests/public-api-repetition.test.ts:106`:

~~~~ typescript
assert.equal(gateway.document(first.compiledGateway), first.compiledGateway.manifest);

		await using second = await createProductionFixture({ resetTrace: false });
		assert.equal(service.document(second.compiledService).id, second.compiledService.definition.id);
~~~~

`GatewayCompilationError` appears in `.agents/tests/public-api-repetition.test.ts:114`:

~~~~ typescript
assert.equal(new gateway.GatewayCompilationError([]).issues.length, 0);
		assert.equal(new gateway.GatewayCompilationError([{ code: 'invalid-definition', message: 'invalid' }]).issues.length, 1);
		assert.equal(new service.ServiceRuntimeConfigurationError('first').message, 'first');
		assert.equal(new service.ServiceRuntimeConfigurationError('second').message, 'second');
~~~~

`create` appears in `.agents/support/production-fixture.ts:658`:

~~~~ typescript
const gatewayRuntime = gateway.create(compiledGateway, {
		requestId: (() => {
			let sequence = 0;
			return () => `request-${++sequence}`;
~~~~

`CompiledGateway` appears in `.agents/support/production-fixture.ts:367`:

~~~~ typescript
readonly compiledGateway: gateway.CompiledGateway;
	readonly definitions: Readonly<{
		readonly ImportWorkflow: typeof ImportWorkflow;
		readonly NormalizeDomain: typeof NormalizeDomain;
~~~~

`GatewayRuntime` appears in `.agents/support/production-fixture.ts:362`:

~~~~ typescript
readonly gateway: gateway.GatewayRuntime;
	readonly service: service.ServiceRuntime;
	readonly trace: TraceRecorder;
	readonly repository: ImportRepositoryValue;
~~~~

@utils/server/service
---------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `compile` | function | Compile a definition and its exact runtime implementation into one authoritative service artifact. | `compile(...)` | `.agents/support/production-fixture.ts:598` uses `compile`. |
| `CompiledService` | interface | Compiled service ready for runtime creation and artifact generation. | `value: CompiledService` | `.agents/support/production-fixture.ts:366` uses `CompiledService`. |
| `compose` | function | Compose service definitions or selections into deterministic direct references. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:262` uses `compose`. |
| `composeRuntimes` | function | Compose focused resilience runtimes into one deterministic onion. | `composeRuntimes(...)` | `.agents/tests/public-api-repetition.test.ts:119` uses `composeRuntimes`. |
| `create` | function | Create a live Hono runtime from one fully compiled service. | `create(...)` | `.agents/support/production-fixture.ts:605` uses `create`. |
| `CreateServiceOptions` | interface | Options used to create a live Hono service runtime. | `value: CreateServiceOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one import-safe independently deployable service. | `define(...)` | `.agents/support/production-fixture.ts:335` uses `define`. |
| `document` | function | Return the deterministic manifest retained by a compiled service. | `document(...)` | `.agents/tests/public-api-repetition.test.ts:105` uses `document`. |
| `EffectiveServiceOperation` | interface | Fully resolved static contract for one operation. | `value: EffectiveServiceOperation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `implement` | function | Bind an exact service definition to its HTTP endpoint, middleware, and resource implementations. | `implement(...)` | `.agents/support/production-fixture.ts:598` uses `implement`. |
| `joinPath` | export | Public contract documented by the source declaration. | `joinPath` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `leafEndpoints` | function | Return exact leaf endpoint definitions represented by a composition. | `leafEndpoints(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `openapi` | function | Generate OpenAPI from the compiler-resolved operation graph. | `openapi(...)` | `services/observations/openapi.ts:18` uses `openapi`. |
| `policy` | function | Define one selector-based additive service policy. | `policy(...)` | `.agents/support/production-fixture.ts:328` uses `policy`. |
| `RetryableOperationError` | class | Error wrapper used when a caller deliberately classifies an operation failure as safe to retry. | `new RetryableOperationError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select exact endpoint definitions from one service without copying routes. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:261` uses `select`. |
| `ServiceCompilationError` | class | Error raised when service compilation finds one or more contract defects. | `new ServiceCompilationError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceConcernRuntimes` | interface | Provider/domain concern runtimes supplied by a composition root. | `value: ServiceConcernRuntimes` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceConcernValues` | type | Exact application concern values propagated through one request. | `value: ServiceConcernValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceContextStore` | interface | Direct-identity context store used by middleware and concern adapters. | `value: ServiceContextStore` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceContributions` | interface | Static cross-cutting values contributed by a service or service policy. | `value: ServiceContributions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceDefinition` | interface | Import-safe service definition. | `value: ServiceDefinition` | `services/gateway/src/routing.ts:7` uses `ServiceDefinition`. |
| `ServiceDefinitionInput` | type | Input accepted by `service.define()`. | `value: ServiceDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceImplementation` | interface | Runtime implementation supplied separately from a service definition. | `value: ServiceImplementation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceImplementationInput` | interface | Input accepted by `service.implement()`. | `value: ServiceImplementationInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceInputValues` | type | Validated values grouped by HTTP request location. | `value: ServiceInputValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceManifest` | interface | Deterministic compiled service manifest. | `value: ServiceManifest` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceOpenApiOptions` | interface | Options for projecting one compiled service to OpenAPI 3.1. | `value: ServiceOpenApiOptions` | `apps/docs/src/lib/services.ts:19` uses `ServiceOpenApiOptions`. |
| `ServicePolicy` | interface | Additive selector-based overlay for a subset of imported endpoints. | `value: ServicePolicy` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServicePolicyInput` | type | Input accepted by `service.policy()`. | `value: ServicePolicyInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceRequestState` | interface | Request values exposed to service concern runtimes. | `value: ServiceRequestState` | `.agents/tests/public-api-repetition.test.ts:127` uses `ServiceRequestState`. |
| `ServiceRequestStatePatch` | interface | Patch returned by a concern runtime after successful evaluation. | `value: ServiceRequestStatePatch` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceResilienceRuntime` | interface | Host adapter for resilience policies not implemented by the generic server. | `value: ServiceResilienceRuntime` | `.agents/tests/public-api-repetition.test.ts:121` uses `ServiceResilienceRuntime`. |
| `ServiceRoute` | interface | One service route with full import provenance. | `value: ServiceRoute` | `services/gateway/src/routing.ts:8` uses `ServiceRoute`. |
| `ServiceRouteManifestEntry` | interface | JSON-safe route manifest used by gateways, tests, and deployments. | `value: ServiceRouteManifestEntry` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceRuntime` | interface | Live service runtime owned by one host. | `value: ServiceRuntime` | `.agents/support/production-fixture.ts:363` uses `ServiceRuntime`. |
| `ServiceRuntimeConfigurationError` | class | Error raised when a compiled service is missing a required concern runtime. | `new ServiceRuntimeConfigurationError(...)` | `.agents/tests/public-api-repetition.test.ts:116` uses `ServiceRuntimeConfigurationError`. |
| `ServiceSelection` | interface | Exact named subset of a service's imported endpoint graph. | `value: ServiceSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceStageResult` | type | Result returned by a middleware or concern stage. | `value: ServiceStageResult` | `.agents/support/production-fixture.ts:604` uses `ServiceStageResult`. |
| `ServiceValidationIssue` | interface | One compiler validation issue. | `value: ServiceValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceValidationResult` | type | Validation result for a definition or implementation. | `value: ServiceValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ServiceValidationSubject` | type | Definition or implementation value that may be attached to a compiler issue. | `value: ServiceValidationSubject` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `standardRetry` | function | Create a service resilience runtime backed by `@std/async/retry`. | `standardRetry(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `StandardRetryOptions` | interface | Configuration for the standard-library-backed retry runtime. | `value: StandardRetryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `validate` | function | Validate an import-safe service definition without requiring runtime implementations. | `validate(...)` | `services/gateway/src/routing.ts:35` uses `validate`. |

Detected uses
~~~~~~~~~~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:262`:

~~~~ typescript
assert.equal(service.compose(serviceDefinition, serviceSelection).length, 2);
			const gatewayDefinition = gateway.define({
				id: `matrix-gateway-${index}`,
				services: [gateway.mount(serviceDefinition, { origin: 'https://service.validation.test' })],
~~~~

`define` appears in `.agents/support/production-fixture.ts:335`:

~~~~ typescript
const ServiceDefinition = service.define({
	id: 'validation-service',
	path: '/api/v1',
	endpoints: [StartImport, GetImport, GetHealth],
~~~~

`policy` appears in `.agents/support/production-fixture.ts:328`:

~~~~ typescript
const ImportPolicy = service.policy({
	id: 'validation.import-policy',
	endpoints: [StartImport, GetImport],
	middleware: [middleware.wholeRequest(WholeRequest), middleware.aroundOperation(AroundOperation)],
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:261`:

~~~~ typescript
const serviceSelection = service.select(serviceDefinition, { id: `matrix-service-selection-${index}`, endpoints: selected });
			assert.equal(service.compose(serviceDefinition, serviceSelection).length, 2);
			const gatewayDefinition = gateway.define({
				id: `matrix-gateway-${index}`,
~~~~

`implement` appears in `.agents/support/production-fixture.ts:598`:

~~~~ typescript
const compiledService = service.compile(service.implement(ServiceDefinition, {
		hostType: Object.freeze({ coordinator }),
		endpoints: [startHandler, getHandler, healthHandler],
		middleware: [middlewareHandler('whole', WholeRequest), middlewareHandler('operation', AroundOperation)],
~~~~

`compile` appears in `.agents/support/production-fixture.ts:598`:

~~~~ typescript
const compiledService = service.compile(service.implement(ServiceDefinition, {
		hostType: Object.freeze({ coordinator }),
		endpoints: [startHandler, getHandler, healthHandler],
		middleware: [middlewareHandler('whole', WholeRequest), middlewareHandler('operation', AroundOperation)],
~~~~

`document` appears in `.agents/tests/public-api-repetition.test.ts:105`:

~~~~ typescript
assert.equal(service.document(first.compiledService), first.compiledService.manifest);
		assert.equal(gateway.document(first.compiledGateway), first.compiledGateway.manifest);

		await using second = await createProductionFixture({ resetTrace: false });
~~~~

`validate` appears in `services/gateway/src/routing.ts:35`:

~~~~ typescript
*   -> service.validate()
 *   -> full method/path routes
 *   -> remove internal diagnostics
 *   -> Bunny route matcher
~~~~

`create` appears in `.agents/support/production-fixture.ts:605`:

~~~~ typescript
const serviceRuntime = service.create(compiledService, {
		host: Object.freeze({ coordinator }),
		requestId: (request) => request.headers.get('x-request-id') ?? crypto.randomUUID(),
		onError: async (error, state) => await trace.record('service', 'fault', {
~~~~

`ServiceRuntimeConfigurationError` appears in `.agents/tests/public-api-repetition.test.ts:116`:

~~~~ typescript
assert.equal(new service.ServiceRuntimeConfigurationError('first').message, 'first');
		assert.equal(new service.ServiceRuntimeConfigurationError('second').message, 'second');

		const empty = service.composeRuntimes();
~~~~

`composeRuntimes` appears in `.agents/tests/public-api-repetition.test.ts:119`:

~~~~ typescript
const empty = service.composeRuntimes();
		assert.equal(empty.supports(resilience.retry()), false);
		const retryRuntime: service.ServiceResilienceRuntime = Object.freeze({
			supports(policy: resilience.ResiliencePolicy): boolean {
~~~~

`openapi` appears in `services/observations/openapi.ts:18`:

~~~~ typescript
return await service.openapi(compiled, { ...ObservationsOpenApiOptions, ...overrides });
}

export default createObservationsOpenApiDocument;
~~~~

`ServiceOpenApiOptions` appears in `apps/docs/src/lib/services.ts:19`:

~~~~ typescript
readonly createDocument: (overrides?: Partial<ServiceOpenApiOptions>) => Promise<OpenApiDocument>;
}

/** Services whose current compiled contracts are published by the docs application. */
~~~~

`ServiceDefinition` appears in `services/gateway/src/routing.ts:7`:

~~~~ typescript
readonly services: Readonly<Record<string, ServiceDefinition>>;
	readonly routes: readonly ServiceRoute[];
}
~~~~

`ServiceRoute` appears in `services/gateway/src/routing.ts:8`:

~~~~ typescript
readonly routes: readonly ServiceRoute[];
}

/** One matched service route and its decoded path parameters. */
~~~~

`CompiledService` appears in `.agents/support/production-fixture.ts:366`:

~~~~ typescript
readonly compiledService: service.CompiledService;
	readonly compiledGateway: gateway.CompiledGateway;
	readonly definitions: Readonly<{
		readonly ImportWorkflow: typeof ImportWorkflow;
~~~~

`ServiceRequestState` appears in `.agents/tests/public-api-repetition.test.ts:127`:

~~~~ typescript
_state: service.ServiceRequestState,
				next: () => Promise<service.ServiceStageResult>,
			): Promise<service.ServiceStageResult> {
				return await next();
~~~~

`ServiceResilienceRuntime` appears in `.agents/tests/public-api-repetition.test.ts:121`:

~~~~ typescript
const retryRuntime: service.ServiceResilienceRuntime = Object.freeze({
			supports(policy: resilience.ResiliencePolicy): boolean {
				return policy.type === 'retry';
			},
~~~~

`ServiceRuntime` appears in `.agents/support/production-fixture.ts:363`:

~~~~ typescript
readonly service: service.ServiceRuntime;
	readonly trace: TraceRecorder;
	readonly repository: ImportRepositoryValue;
	readonly compiledService: service.CompiledService;
~~~~

`ServiceStageResult` appears in `.agents/support/production-fixture.ts:604`:

~~~~ typescript
const idempotency = new Map<string, Readonly<{ readonly body: string; readonly result: service.ServiceStageResult }>>();
	const serviceRuntime = service.create(compiledService, {
		host: Object.freeze({ coordinator }),
		requestId: (request) => request.headers.get('x-request-id') ?? crypto.randomUUID(),
~~~~

@utils/server/service/resilience
--------------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `composeRuntimes` | function | Compose focused resilience runtimes into one deterministic onion. | `composeRuntimes(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `RetryableOperationError` | class | Error wrapper used when a caller deliberately classifies an operation failure as safe to retry. | `new RetryableOperationError(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `standardRetry` | function | Create a service resilience runtime backed by `@std/async/retry`. | `standardRetry(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `StandardRetryOptions` | interface | Configuration for the standard-library-backed retry runtime. | `value: StandardRetryOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/server/endpoint
----------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `AnyEndpointHandler` | type | Callable shape used to retain differently specialized endpoint handlers in one compiled collection. | `value: AnyEndpointHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `AnyEndpointHandlerBinding` | interface | Runtime-erased endpoint binding used by heterogeneous composition utilities. | `value: AnyEndpointHandlerBinding` | `utils/server/service/compile.ts:374` uses `AnyEndpointHandlerBinding`. |
| `compose` | function | Compose endpoint paths, groups, selections, and nested arrays. | `compose(...)` | `utils/server/gateway/definition.ts:214` uses `compose`. |
| `define` | function | Define a multi-method endpoint path. | `define(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `delete` | value | Define a complete `DELETE` endpoint. | `delete` | `.agents/tests/public-api-matrix.test.ts:236` uses `delete`. |
| `document` | function | Create deterministic JSON-safe endpoint documentation. | `document(...)` | `.agents/tests/public-api-matrix.test.ts:246` uses `document`. |
| `EmptyEndpointHost` | type | Empty host value used when an endpoint handler does not require host state. | `value: EmptyEndpointHost` | `utils/server/service/compile.ts:72` uses `EmptyEndpointHost`. |
| `EndpointCompositionInput` | type | Recursive endpoint composition input accepted by groups, services, and gateways. | `value: EndpointCompositionInput` | `utils/server/gateway/types.ts:108` uses `EndpointCompositionInput`. |
| `EndpointConcernValues` | interface | Provider-neutral request concern values attached by a service runtime. | `value: EndpointConcernValues` | `utils/server/service/types.ts:240` uses `EndpointConcernValues`. |
| `EndpointContext` | type | Request execution context propagated by the owning host. | `value: EndpointContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointContributions` | interface | Static cross-cutting values contributed by a group, path, or operation. | `value: EndpointContributions` | `utils/server/service/compile.ts:325` uses `EndpointContributions`. |
| `EndpointDefinition` | interface | Immutable path contract containing one or more method operations. | `value: EndpointDefinition` | `utils/server/gateway/compile.ts:49` uses `EndpointDefinition`. |
| `EndpointDefinitionInput` | type | Input accepted by a multi-method endpoint path. | `value: EndpointDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDocument` | interface | JSON-safe endpoint projection with fully composed path. | `value: EndpointDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDocumentation` | interface | Common human-facing metadata for endpoint definitions. | `value: EndpointDocumentation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointEntry` | type | One concrete endpoint, group, or group selection accepted by composition. | `value: EndpointEntry` | `utils/server/service/compile.ts:242` uses `EndpointEntry`. |
| `EndpointExample` | interface | Concrete request or response example retained for generated documentation. | `value: EndpointExample` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointGroup` | interface | Static endpoint group with a shared path prefix and contributions. | `value: EndpointGroup` | `utils/server/service/compile.ts:244` uses `EndpointGroup`. |
| `EndpointGroupInput` | type | Input accepted by an endpoint group. | `value: EndpointGroupInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointGroupMembers` | type | Named or direct endpoint-group members. | `value: EndpointGroupMembers` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointGroupSelection` | interface | Key-preserving immutable selection from a named endpoint group. | `value: EndpointGroupSelection` | `utils/server/service/definition.ts:183` uses `EndpointGroupSelection`. |
| `EndpointHandler` | type | Handler function for one exact endpoint operation. | `value: EndpointHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerBinding` | interface | Direct binding between imported endpoint/operation values and behavior. | `value: EndpointHandlerBinding` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerContext` | interface | Portable handler context specialized by a service runtime adapter. | `value: EndpointHandlerContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerResult` | type | Declared result union for one endpoint operation. | `value: EndpointHandlerResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerSet` | interface | Complete handler set for a multi-method endpoint. | `value: EndpointHandlerSet` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInput` | interface | Transport-specific documentation wrapped around a first-class schema. | `value: EndpointInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSchema` | type | Extract the schema carried by one endpoint input slot. | `value: EndpointInputSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSlot` | type | Bare or documented schema accepted by one request location. | `value: EndpointInputSlot` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSlots` | interface | Flat request input locations accepted by operations and paths. | `value: EndpointInputSlots` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSource` | type | Request locations understood by the endpoint compiler. | `value: EndpointInputSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointMethod` | type | HTTP methods supported by endpoint definitions. | `value: EndpointMethod` | `services/gateway/src/routing.ts:70` uses `EndpointMethod`. |
| `EndpointOperation` | interface | Immutable path-independent method contract. | `value: EndpointOperation` | `utils/server/service/compile.ts:298` uses `EndpointOperation`. |
| `EndpointOperationDocument` | interface | JSON-safe operation projection. | `value: EndpointOperationDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointOperationInput` | type | Input accepted by a method-operation definition. | `value: EndpointOperationInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointResourceDefinition` | type | Static resource reference accepted by portable endpoint contracts. | `value: EndpointResourceDefinition` | `utils/server/service/runtime.ts:756` uses `EndpointResourceDefinition`. |
| `EndpointResourceResolver` | interface | Resolver constrained to resources declared by the effective operation. | `value: EndpointResourceResolver` | `utils/server/service/runtime.ts:790` uses `EndpointResourceResolver`. |
| `EndpointResources` | type | Effective resource definitions available to an endpoint handler. | `value: EndpointResources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointResourceValue` | type | Runtime value represented by one endpoint resource reference. | `value: EndpointResourceValue` | `utils/server/service/runtime.ts:807` uses `EndpointResourceValue`. |
| `EndpointRuntimeInputValues` | type | Values retained after request-location parsing but before handler specialization. | `value: EndpointRuntimeInputValues` | `utils/server/service/types.ts:243` uses `EndpointRuntimeInputValues`. |
| `EndpointSchema` | type | Standard Schema-compatible runtime validation contract. | `value: EndpointSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointValidationIssue` | interface | One deterministic endpoint validation issue. | `value: EndpointValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointValidationResult` | type | Deterministic endpoint validation result. | `value: EndpointValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ErasedEndpointHandlerContext` | interface | Runtime context shape shared by heterogeneous compiled handler collections. | `value: ErasedEndpointHandlerContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `get` | value | Define a complete `GET` endpoint. | `get` | `.agents/support/production-fixture.ts:315` uses `get`. |
| `group` | function | Define a static endpoint group with shared prefix and contributions. | `group(...)` | `.agents/tests/public-api-matrix.test.ts:243` uses `group`. |
| `handler` | function | Normalize direct, operation-specific, or exhaustive handler authoring. | `handler(...)` | `.agents/support/production-fixture.ts:579` uses `handler`. |
| `handlers` | function | Flatten handler bindings while rejecting duplicate operation implementations. | `handlers(...)` | `utils/server/service/implementation.ts:18` uses `handlers`. |
| `head` | value | Define a complete `HEAD` endpoint. | `head` | `.agents/tests/public-api-matrix.test.ts:238` uses `head`. |
| `InferEndpointInputs` | type | Parsed output values exposed to an endpoint handler. | `value: InferEndpointInputs` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `input` | function | Add transport documentation to a first-class Standard Schema value. | `input(...)` | `.agents/tests/public-api-matrix.test.ts:240` uses `input`. |
| `isInput` | function | Return whether a value is a documented endpoint input. | `isInput(...)` | `.agents/tests/public-api-matrix.test.ts:241` uses `isInput`. |
| `joinPath` | function | Join HTTP route-template fragments with one leading slash. | `joinPath(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `match` | function | Validate a value against any Standard Schema-compatible contract. | `match(...)` | `utils/server/service/runtime.ts:462` uses `match`. |
| `MergeEndpointInputs` | type | Merge path-level inputs with operation-level inputs. | `value: MergeEndpointInputs` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `normalizePathTemplate` | function | Convert parameter names to a stable shape used for route-collision checks. | `normalizePathTemplate(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `openapi` | function | Generate an endpoint-only OpenAPI document from the exact imported graph. | `openapi(...)` | `utils/server/service/openapi.ts:31` uses `openapi`. |
| `OpenApiDocument` | interface | OpenAPI 3.1 document generated from one endpoint composition. | `value: OpenApiDocument` | `apps/docs/src/lib/services.ts:19` uses `OpenApiDocument`. |
| `OpenApiOptions` | interface | Options for the endpoint-only OpenAPI projection. | `value: OpenApiOptions` | `utils/server/service/openapi.ts:12` uses `OpenApiOptions`. |
| `operation` | value | Path-independent operation constructors. | `operation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `options` | value | Define a complete `OPTIONS` endpoint. | `options` | `.agents/tests/public-api-matrix.test.ts:237` uses `options`. |
| `patch` | value | Define a complete `PATCH` endpoint. | `patch` | `.agents/tests/public-api-matrix.test.ts:235` uses `patch`. |
| `pathParameters` | function | Return parameter names declared by one route template in authored order. | `pathParameters(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PickEndpointInputSlots` | type | Preserve exact authored schemas while retaining a broad shape for heterogeneous operations. | `value: PickEndpointInputSlots` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `post` | value | Define a complete `POST` endpoint. | `post` | `.agents/support/production-fixture.ts:296` uses `post`. |
| `put` | value | Define a complete `PUT` endpoint. | `put` | `.agents/tests/public-api-matrix.test.ts:234` uses `put`. |
| `schemaOf` | function | Return the Standard Schema carried by a bare or documented input slot. | `schemaOf(...)` | `utils/server/service/runtime.ts:462` uses `schemaOf`. |
| `select` | function | Select named members from an endpoint group without copying definitions. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:244` uses `select`. |
| `SingleMethodEndpointInput` | type | Complete single-method endpoint authoring input. | `value: SingleMethodEndpointInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `StandardJsonSchemaV1` | interface | Minimal Standard JSON Schema trait used without coupling to a schema library. | `value: StandardJsonSchemaV1` | `utils/server/service/compile_test.ts:13` uses `StandardJsonSchemaV1`. |
| `validate` | function | Validate a complete endpoint composition without acquiring runtime values. | `validate(...)` | `utils/server/service/compile.ts:57` uses `validate`. |

Detected uses
~~~~~~~~~~~~~

`compose` appears in `utils/server/gateway/definition.ts:214`:

~~~~ typescript
for (const entry of endpoint.compose(input)) visit(entry);
	return Object.freeze(result);
}
~~~~

`delete` appears in `.agents/tests/public-api-matrix.test.ts:236`:

~~~~ typescript
Delete: endpoint.delete({ id: `matrix.delete-${index}`, path: '/delete', responses: [NoContent] }),
				Options: endpoint.options({ id: `matrix.options-${index}`, path: '/options', responses: [NoContent] }),
				Head: endpoint.head({ id: `matrix.head-${index}`, path: '/head', responses: [NoContent] }),
			};
~~~~

`document` appears in `.agents/tests/public-api-matrix.test.ts:246`:

~~~~ typescript
assert.equal(endpoint.document(group).length, 5);

			const requestMiddleware = middleware.define({ id: `matrix.middleware-${index}`, description: 'Matrix middleware.' });
			const middlewareCatalog = middleware.catalog(`matrix.middleware.catalog.${index}`, { requestMiddleware });
~~~~

`get` appears in `.agents/support/production-fixture.ts:315`:

~~~~ typescript
const GetImport = endpoint.get({
	id: 'validation.imports-get',
	path: '/imports/:importId',
	param: StatusParametersSchema,
~~~~

`group` appears in `.agents/tests/public-api-matrix.test.ts:243`:

~~~~ typescript
const group = endpoint.group({ id: `matrix.group-${index}`, path: '/group', endpoints });
			const selected = endpoint.select(group, ['Put', 'Head']);
			assert.equal(endpoint.compose(selected).length, 1);
			assert.equal(endpoint.document(group).length, 5);
~~~~

`head` appears in `.agents/tests/public-api-matrix.test.ts:238`:

~~~~ typescript
Head: endpoint.head({ id: `matrix.head-${index}`, path: '/head', responses: [NoContent] }),
			};
			const documentedInput = endpoint.input(StringSchema, { description: 'Documented matrix header.' });
			assert.equal(endpoint.isInput(documentedInput), true);
~~~~

`input` appears in `.agents/tests/public-api-matrix.test.ts:240`:

~~~~ typescript
const documentedInput = endpoint.input(StringSchema, { description: 'Documented matrix header.' });
			assert.equal(endpoint.isInput(documentedInput), true);
			assert.equal(endpoint.schemaOf(documentedInput), StringSchema);
			const group = endpoint.group({ id: `matrix.group-${index}`, path: '/group', endpoints });
~~~~

`isInput` appears in `.agents/tests/public-api-matrix.test.ts:241`:

~~~~ typescript
assert.equal(endpoint.isInput(documentedInput), true);
			assert.equal(endpoint.schemaOf(documentedInput), StringSchema);
			const group = endpoint.group({ id: `matrix.group-${index}`, path: '/group', endpoints });
			const selected = endpoint.select(group, ['Put', 'Head']);
~~~~

`match` appears in `utils/server/service/runtime.ts:462`:

~~~~ typescript
const result = await endpoint.match(endpoint.schemaOf(slot), raw);
		if (!result.success) {
			issues.push(...requestWire.validationDetails(source, result.issues));
			continue;
~~~~

`options` appears in `.agents/tests/public-api-matrix.test.ts:237`:

~~~~ typescript
Options: endpoint.options({ id: `matrix.options-${index}`, path: '/options', responses: [NoContent] }),
				Head: endpoint.head({ id: `matrix.head-${index}`, path: '/head', responses: [NoContent] }),
			};
			const documentedInput = endpoint.input(StringSchema, { description: 'Documented matrix header.' });
~~~~

`patch` appears in `.agents/tests/public-api-matrix.test.ts:235`:

~~~~ typescript
Patch: endpoint.patch({ id: `matrix.patch-${index}`, path: '/patch', responses: [NoContent] }),
				Delete: endpoint.delete({ id: `matrix.delete-${index}`, path: '/delete', responses: [NoContent] }),
				Options: endpoint.options({ id: `matrix.options-${index}`, path: '/options', responses: [NoContent] }),
				Head: endpoint.head({ id: `matrix.head-${index}`, path: '/head', responses: [NoContent] }),
~~~~

`post` appears in `.agents/support/production-fixture.ts:296`:

~~~~ typescript
const StartImport = endpoint.post({
	id: 'validation.imports-start',
	path: '/imports',
	json: ImportRequestSchema,
~~~~

`put` appears in `.agents/tests/public-api-matrix.test.ts:234`:

~~~~ typescript
Put: endpoint.put({ id: `matrix.put-${index}`, path: '/put', responses: [NoContent] }),
				Patch: endpoint.patch({ id: `matrix.patch-${index}`, path: '/patch', responses: [NoContent] }),
				Delete: endpoint.delete({ id: `matrix.delete-${index}`, path: '/delete', responses: [NoContent] }),
				Options: endpoint.options({ id: `matrix.options-${index}`, path: '/options', responses: [NoContent] }),
~~~~

`schemaOf` appears in `utils/server/service/runtime.ts:462`:

~~~~ typescript
const result = await endpoint.match(endpoint.schemaOf(slot), raw);
		if (!result.success) {
			issues.push(...requestWire.validationDetails(source, result.issues));
			continue;
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:244`:

~~~~ typescript
const selected = endpoint.select(group, ['Put', 'Head']);
			assert.equal(endpoint.compose(selected).length, 1);
			assert.equal(endpoint.document(group).length, 5);
~~~~

`validate` appears in `utils/server/service/compile.ts:57`:

~~~~ typescript
const endpointValidation = endpoint.validate(definition.endpoints);
	if (!endpointValidation.valid) {
		for (const item of endpointValidation.issues) issues.push(issue('invalid-endpoint', item.message, item.definition));
	}
~~~~

`handler` appears in `.agents/support/production-fixture.ts:579`:

~~~~ typescript
const startHandler = endpoint.handler<typeof StartImport, Host>(StartImport, async ({ input, host, ctx }) => {
		try {
			const id = `import-${ctx.id}`;
			const record = await host.coordinator.start(id, input.json, ctx);
~~~~

`handlers` appears in `utils/server/service/implementation.ts:18`:

~~~~ typescript
const endpointBindings = endpoint.handlers(...(input.endpoints ?? []));
	const middleware = Object.freeze([...(input.middleware ?? [])]);
	const resources = input.resources ?? resource.implementations();
	return Object.freeze({
~~~~

`AnyEndpointHandlerBinding` appears in `utils/server/service/compile.ts:374`:

~~~~ typescript
bindings: readonly AnyEndpointHandlerBinding[],
	routes: readonly ServiceRoute[],
	issues: ServiceValidationIssue[],
): ReadonlyMap<EndpointDefinition, ReadonlyMap<EndpointOperation, AnyEndpointHandlerBinding>> {
~~~~

`EndpointCompositionInput` appears in `utils/server/gateway/types.ts:108`:

~~~~ typescript
readonly endpoints: EndpointCompositionInput;
	readonly authenticate?: DefinitionInput<CatalogEntryIdentity>;
	readonly assertion?: DefinitionInput<CatalogEntryIdentity>;
	readonly timeout?: Temporal.Duration | Temporal.DurationLike | string;
~~~~

`EndpointContributions` appears in `utils/server/service/compile.ts:325`:

~~~~ typescript
): readonly (ServiceContributions | EndpointContributions)[] {
	return Object.freeze([
		service,
		...service.policies.filter((policy) => policyTargets.get(policy)?.has(route.endpoint)),
~~~~

`EndpointDefinition` appears in `utils/server/gateway/compile.ts:49`:

~~~~ typescript
const availableEndpoints = new Set<EndpointDefinition>();
	for (const mounted of definition.services) {
		const service = serviceOf(mounted.target);
		const existing = mountedServices.get(service.id);
~~~~

`EndpointEntry` appears in `utils/server/service/compile.ts:242`:

~~~~ typescript
entries: readonly EndpointEntry[],
		prefix: string,
		groups: readonly EndpointGroup[],
	): void => {
~~~~

`EndpointRuntimeInputValues` appears in `utils/server/service/types.ts:243`:

~~~~ typescript
export type ServiceInputValues = EndpointRuntimeInputValues;

/** Request values exposed to service concern runtimes. */
export interface ServiceRequestState<
~~~~

`EndpointConcernValues` appears in `utils/server/service/types.ts:240`:

~~~~ typescript
export type ServiceConcernValues = EndpointConcernValues;

/** Validated values grouped by HTTP request location. */
export type ServiceInputValues = EndpointRuntimeInputValues;
~~~~

`EmptyEndpointHost` appears in `utils/server/service/compile.ts:72`:

~~~~ typescript
Host extends object = EmptyEndpointHost,
>(implementation: ServiceImplementation<Definition, Host>): CompiledService<Definition, Host> {
	try {
		return compileImplementation(implementation);
~~~~

`EndpointGroup` appears in `utils/server/service/compile.ts:244`:

~~~~ typescript
groups: readonly EndpointGroup[],
	): void => {
		for (const entry of entries) {
			if (entry.kind === 'endpoint') {
~~~~

`EndpointGroupSelection` appears in `utils/server/service/definition.ts:183`:

~~~~ typescript
export type { EndpointGroup, EndpointGroupSelection };
~~~~

`EndpointMethod` appears in `services/gateway/src/routing.ts:70`:

~~~~ typescript
const method = request.method.toLowerCase() as EndpointMethod;
		const pathname = new URL(request.url).pathname;
		for (const candidate of compiled) {
			if (candidate.route.method !== method) continue;
~~~~

`EndpointOperation` appears in `utils/server/service/compile.ts:298`:

~~~~ typescript
const operationOwners = new Map<string, EndpointOperation>();
	for (const route of routes) {
		const key = `${route.method} ${normalizeRouteShape(route.path)}`;
		const existing = routeOwners.get(key);
~~~~

`EndpointResourceDefinition` appears in `utils/server/service/runtime.ts:756`:

~~~~ typescript
definition: endpoint.EndpointResourceDefinition,
): ResourceDefinition {
	if (!isConcreteResourceDefinition(definition)) {
		throw new ServiceRuntimeConfigurationError(
~~~~

`EndpointResourceResolver` appears in `utils/server/service/runtime.ts:790`:

~~~~ typescript
): endpoint.EndpointResourceResolver & MiddlewareResourceResolver {
	return Object.freeze({
		/**
		 * Checks whether the required state is present for the compiled service runtime.
~~~~

`EndpointResourceValue` appears in `utils/server/service/runtime.ts:807`:

~~~~ typescript
): Promise<endpoint.EndpointResourceValue<Definition>> {
			const concrete = requireConcreteResourceDefinition(definition);
			if (!allowed.has(concrete)) {
				throw new TypeError(`Resource ${JSON.stringify(concrete.id)} is outside the effective operation envelope.`);
~~~~

`openapi` appears in `utils/server/service/openapi.ts:31`:

~~~~ typescript
const document = await endpoint.openapi(definitions, {
		title: options.title,
		version: options.version,
		...(options.includeInternal !== undefined ? { includeInternal: options.includeInternal } : {}),
~~~~

`OpenApiDocument` appears in `apps/docs/src/lib/services.ts:19`:

~~~~ typescript
readonly createDocument: (overrides?: Partial<ServiceOpenApiOptions>) => Promise<OpenApiDocument>;
}

/** Services whose current compiled contracts are published by the docs application. */
~~~~

`OpenApiOptions` appears in `utils/server/service/openapi.ts:12`:

~~~~ typescript
export interface ServiceOpenApiOptions extends Omit<OpenApiOptions, 'description'> {
	/** Override the service definition description in the generated document. */
	readonly description?: string;
}
~~~~

`StandardJsonSchemaV1` appears in `utils/server/service/compile_test.ts:13`:

~~~~ typescript
function schema<Output>(jsonSchema: Readonly<Record<string, unknown>>): StandardSchemaV1<unknown, Output> & endpoint.StandardJsonSchemaV1 {
	return {
		'~standard': { version: 1, vendor: 'test', validate: (value) => ({ value: value as Output }) },
		'~standard-json-schema': { version: 1, vendor: 'test', jsonSchema },
~~~~

@utils/server/endpoint/definition
---------------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `compose` | function | Compose endpoint paths, groups, selections, and nested arrays. | `compose(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define a multi-method endpoint path. | `define(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `defineOperation` | function | Define one path-independent HTTP method operation. | `defineOperation(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `del` | value | Define a complete `DELETE` endpoint. | `del` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `document` | function | Create deterministic JSON-safe endpoint documentation. | `document(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `get` | value | Define a complete `GET` endpoint. | `get` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `group` | function | Define a static endpoint group with shared prefix and contributions. | `group(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `head` | value | Define a complete `HEAD` endpoint. | `head` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `input` | function | Add transport documentation to a first-class Standard Schema value. | `input(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `isInput` | function | Return whether a value is a documented endpoint input. | `isInput(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `match` | function | Validate a value against any Standard Schema-compatible contract. | `match(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `operation` | value | Path-independent operation constructors. | `operation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `options` | value | Define a complete `OPTIONS` endpoint. | `options` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `patch` | value | Define a complete `PATCH` endpoint. | `patch` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `post` | value | Define a complete `POST` endpoint. | `post` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `put` | value | Define a complete `PUT` endpoint. | `put` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `schemaOf` | function | Return the Standard Schema carried by a bare or documented input slot. | `schemaOf(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select named members from an endpoint group without copying definitions. | `select(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `validate` | function | Validate a complete endpoint composition without acquiring runtime values. | `validate(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/server/endpoint/handler
------------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `handler` | function | Normalize direct, operation-specific, or exhaustive handler authoring. | `handler(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `handlers` | function | Flatten handler bindings while rejecting duplicate operation implementations. | `handlers(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/server/endpoint/openapi
------------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `openapi` | function | Generate an endpoint-only OpenAPI document from the exact imported graph. | `openapi(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OpenApiDocument` | interface | OpenAPI 3.1 document generated from one endpoint composition. | `value: OpenApiDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OpenApiOptions` | interface | Options for the endpoint-only OpenAPI projection. | `value: OpenApiOptions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `StandardJsonSchemaV1` | interface | Minimal Standard JSON Schema trait used without coupling to a schema library. | `value: StandardJsonSchemaV1` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/server/endpoint/types
----------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `AnyEndpointHandler` | type | Callable shape used to retain differently specialized endpoint handlers in one compiled collection. | `value: AnyEndpointHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `AnyEndpointHandlerBinding` | interface | Runtime-erased endpoint binding used by heterogeneous composition utilities. | `value: AnyEndpointHandlerBinding` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `DefinedEndpointOperation` | type | Fully inferred operation type produced from one authoring input. | `value: DefinedEndpointOperation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EmptyEndpointHost` | type | Empty host value used when an endpoint handler does not require host state. | `value: EmptyEndpointHost` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointCompositionInput` | type | Recursive endpoint composition input accepted by groups, services, and gateways. | `value: EndpointCompositionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointConcernValues` | interface | Provider-neutral request concern values attached by a service runtime. | `value: EndpointConcernValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointContext` | type | Request execution context propagated by the owning host. | `value: EndpointContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointContributions` | interface | Static cross-cutting values contributed by a group, path, or operation. | `value: EndpointContributions` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDefinition` | interface | Immutable path contract containing one or more method operations. | `value: EndpointDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDefinitionInput` | type | Input accepted by a multi-method endpoint path. | `value: EndpointDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDefinitionProblems` | type | Problem definitions represented by one endpoint path authoring input. | `value: EndpointDefinitionProblems` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDefinitionResources` | type | Resource definitions represented by one endpoint path authoring input. | `value: EndpointDefinitionResources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDocument` | interface | JSON-safe endpoint projection with fully composed path. | `value: EndpointDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointDocumentation` | interface | Common human-facing metadata for endpoint definitions. | `value: EndpointDocumentation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointEntry` | type | One concrete endpoint, group, or group selection accepted by composition. | `value: EndpointEntry` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointExample` | interface | Concrete request or response example retained for generated documentation. | `value: EndpointExample` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointGroup` | interface | Static endpoint group with a shared path prefix and contributions. | `value: EndpointGroup` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointGroupInput` | type | Input accepted by an endpoint group. | `value: EndpointGroupInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointGroupMembers` | type | Named or direct endpoint-group members. | `value: EndpointGroupMembers` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointGroupSelection` | interface | Key-preserving immutable selection from a named endpoint group. | `value: EndpointGroupSelection` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandler` | type | Handler function for one exact endpoint operation. | `value: EndpointHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerBinding` | interface | Direct binding between imported endpoint/operation values and behavior. | `value: EndpointHandlerBinding` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerContext` | interface | Portable handler context specialized by a service runtime adapter. | `value: EndpointHandlerContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerResult` | type | Declared result union for one endpoint operation. | `value: EndpointHandlerResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointHandlerSet` | interface | Complete handler set for a multi-method endpoint. | `value: EndpointHandlerSet` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInput` | interface | Transport-specific documentation wrapped around a first-class schema. | `value: EndpointInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSchema` | type | Extract the schema carried by one endpoint input slot. | `value: EndpointInputSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSlot` | type | Bare or documented schema accepted by one request location. | `value: EndpointInputSlot` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSlots` | interface | Flat request input locations accepted by operations and paths. | `value: EndpointInputSlots` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointInputSource` | type | Request locations understood by the endpoint compiler. | `value: EndpointInputSource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointMethod` | type | HTTP methods supported by endpoint definitions. | `value: EndpointMethod` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointOperation` | interface | Immutable path-independent method contract. | `value: EndpointOperation` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointOperationDocument` | interface | JSON-safe operation projection. | `value: EndpointOperationDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointOperationInput` | type | Input accepted by a method-operation definition. | `value: EndpointOperationInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointOperationProblems` | type | Problem definitions represented by one operation authoring input. | `value: EndpointOperationProblems` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointOperationResources` | type | Resource definitions represented by one operation authoring input. | `value: EndpointOperationResources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointOperationResponses` | type | Response definitions represented by one operation authoring input. | `value: EndpointOperationResponses` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointResourceDefinition` | type | Static resource reference accepted by portable endpoint contracts. | `value: EndpointResourceDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointResourceResolver` | interface | Resolver constrained to resources declared by the effective operation. | `value: EndpointResourceResolver` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointResources` | type | Effective resource definitions available to an endpoint handler. | `value: EndpointResources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointResourceValue` | type | Runtime value represented by one endpoint resource reference. | `value: EndpointResourceValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointRuntimeInputValues` | type | Values retained after request-location parsing but before handler specialization. | `value: EndpointRuntimeInputValues` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointSchema` | type | Standard Schema-compatible runtime validation contract. | `value: EndpointSchema` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointValidationIssue` | interface | One deterministic endpoint validation issue. | `value: EndpointValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `EndpointValidationResult` | type | Deterministic endpoint validation result. | `value: EndpointValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `ErasedEndpointHandlerContext` | interface | Runtime context shape shared by heterogeneous compiled handler collections. | `value: ErasedEndpointHandlerContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `InferEndpointInputs` | type | Parsed output values exposed to an endpoint handler. | `value: InferEndpointInputs` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MergeEndpointInputs` | type | Merge path-level inputs with operation-level inputs. | `value: MergeEndpointInputs` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationProblem` | type | Problem definition union retained by an operation. | `value: OperationProblem` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationResource` | type | Resource definition union retained by an operation. | `value: OperationResource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `OperationResponse` | type | Response definition union retained by an operation. | `value: OperationResponse` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PathResource` | type | Resource definition union retained by an endpoint path. | `value: PathResource` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `PickEndpointInputSlots` | type | Preserve exact authored schemas while retaining a broad shape for heterogeneous operations. | `value: PickEndpointInputSlots` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `SingleMethodEndpointInput` | type | Complete single-method endpoint authoring input. | `value: SingleMethodEndpointInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

@utils/server/endpoint/path
---------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `joinPath` | function | Join HTTP route-template fragments with one leading slash. | `joinPath(...)` | `utils/server/gateway/runtime.ts:111` uses `joinPath`. |
| `normalizePathTemplate` | function | Convert parameter names to a stable shape used for route-collision checks. | `normalizePathTemplate(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `pathParameters` | function | Return parameter names declared by one route template in authored order. | `pathParameters(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Detected uses
~~~~~~~~~~~~~

`joinPath` appears in `utils/server/gateway/runtime.ts:111`:

~~~~ typescript
target.pathname = joinPath(target.pathname, source.pathname);
		target.search = source.search;
		const upstreamInit: RequestInit & { duplex?: 'half' } = {
			method: request.method,
~~~~

@utils/server/middleware
------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `afterValidation` | value | Place middleware in the normal post-validation lane. | `afterValidation` | `utils/server/service/compile.ts:691` uses `afterValidation`. |
| `aroundOperation` | value | Place middleware immediately around endpoint handler invocation. | `aroundOperation` | `.agents/support/production-fixture.ts:331` uses `aroundOperation`. |
| `beforeValidation` | value | Place middleware immediately before request validation. | `beforeValidation` | `utils/server/service/compile.ts:690` uses `beforeValidation`. |
| `catalog` | export | Public contract documented by the source declaration. | `catalog` | `.agents/tests/public-api-matrix.test.ts:249` uses `catalog`. |
| `compose` | function | Compose middleware definitions, catalogs, selections, and nested arrays. | `compose(...)` | `.agents/tests/public-api-matrix.test.ts:251` uses `compose`. |
| `context` | function | Create the direct or curried middleware-context authoring function. | `context(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `define` | function | Define one import-safe middleware contract. | `define(...)` | `.agents/support/production-fixture.ts:293` uses `define`. |
| `document` | function | Create deterministic JSON-safe middleware documentation. | `document(...)` | `.agents/tests/public-api-matrix.test.ts:252` uses `document`. |
| `handler` | function | Bind runtime behavior to one exact middleware definition. | `handler(...)` | `.agents/support/production-fixture.ts:570` uses `handler`. |
| `middlewareCatalog` | function | Create a named middleware catalog. | `middlewareCatalog(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareContextDefinition` | interface | Typed request-context value that middleware may require or provide. | `value: MiddlewareContextDefinition` | `utils/server/service/runtime.ts:714` uses `MiddlewareContextDefinition`. |
| `MiddlewareContextDefinitionInput` | interface | Input accepted by {@link context}. | `value: MiddlewareContextDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareContextStore` | interface | Typed context store visible to one middleware handler. | `value: MiddlewareContextStore` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareContextValue` | type | Value represented by one middleware context definition. | `value: MiddlewareContextValue` | `utils/server/service/runtime.ts:729` uses `MiddlewareContextValue`. |
| `MiddlewareDefinition` | interface | Static import-safe middleware contract. | `value: MiddlewareDefinition` | `.agents/support/production-fixture.ts:570` uses `MiddlewareDefinition`. |
| `MiddlewareDefinitionInput` | interface | Input accepted by {@link define}. | `value: MiddlewareDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareDocument` | interface | JSON-safe middleware documentation projection. | `value: MiddlewareDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareHandler` | interface | Runtime behavior bound to one exact middleware definition. | `value: MiddlewareHandler` | `utils/server/service/compile.ts:415` uses `MiddlewareHandler`. |
| `MiddlewareHandlerContext` | interface | Runtime context supplied to a middleware handler by the server adapter. | `value: MiddlewareHandlerContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareInput` | type | Direct or explicitly placed middleware value accepted by composition fields. | `value: MiddlewareInput` | `utils/server/endpoint/types.ts:84` uses `MiddlewareInput`. |
| `MiddlewareLane` | type | Supported compiler placement lanes. | `value: MiddlewareLane` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareNext` | type | Onion-style continuation used by middleware handlers. | `value: MiddlewareNext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareOnceKey` | type | Stable key for middleware work that must execute at most once per request. | `value: MiddlewareOnceKey` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewarePlan` | interface | Normalized deterministic middleware lanes. | `value: MiddlewarePlan` | `utils/server/service/types.ts:135` uses `MiddlewarePlan`. |
| `MiddlewareProblems` | type | Problem definitions represented by one middleware input. | `value: MiddlewareProblems` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareProvides` | type | Provided contexts represented by one middleware authoring input. | `value: MiddlewareProvides` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareRequires` | type | Required contexts represented by one middleware authoring input. | `value: MiddlewareRequires` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareResourceDefinition` | type | Static resource reference accepted by portable middleware contracts. | `value: MiddlewareResourceDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareResourceResolver` | interface | Resource resolver constrained to the middleware declaration envelope. | `value: MiddlewareResourceResolver` | `utils/server/service/runtime.ts:790` uses `MiddlewareResourceResolver`. |
| `MiddlewareResources` | type | Resource definitions represented by one middleware input. | `value: MiddlewareResources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareResourceValue` | type | Runtime value represented by one middleware resource reference. | `value: MiddlewareResourceValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareUse` | interface | Use-site placement wrapper around one middleware definition. | `value: MiddlewareUse` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareValidationIssue` | interface | One validation issue in a middleware definition or composition. | `value: MiddlewareValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareValidationResult` | type | Deterministic validation result for middleware composition. | `value: MiddlewareValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `once` | function | Wrap an exact middleware handler so its inner work executes at most once for one Request, even when the same definition is contributed by several layers. | `once(...)` | `.agents/tests/public-api-matrix.test.ts:254` uses `once`. |
| `plan` | function | Normalize middleware input while preserving authored order within each lane. | `plan(...)` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `select` | function | Select an immutable key-preserving middleware subset. | `select(...)` | `.agents/tests/public-api-matrix.test.ts:250` uses `select`. |
| `validate` | function | Validate ordering, IDs, and context guarantees for one middleware input. | `validate(...)` | `utils/server/service/compile.ts:132` uses `validate`. |
| `wholeRequest` | value | Surround the complete application request pipeline before transport materialization. | `wholeRequest` | `.agents/support/production-fixture.ts:331` uses `wholeRequest`. |

Detected uses
~~~~~~~~~~~~~

`define` appears in `.agents/support/production-fixture.ts:293`:

~~~~ typescript
const WholeRequest = middleware.define({ id: 'validation.whole-request', description: 'Trace the entire synthetic service request.' });
const AroundOperation = middleware.define({ id: 'validation.around-operation', description: 'Trace the synthetic endpoint handler.' });

const StartImport = endpoint.post({
~~~~

`handler` appears in `.agents/support/production-fixture.ts:570`:

~~~~ typescript
const middlewareHandler = (name: string, definition: middleware.MiddlewareDefinition) => middleware.handler(
		definition,
		async (_state, next) => {
			await trace.record('middleware', `${name}-before`);
~~~~

`once` appears in `.agents/tests/public-api-matrix.test.ts:254`:

~~~~ typescript
const useOnce = middleware.once(binding);
			assert.equal(useOnce.kind, 'middleware-handler');
			assert.equal(useOnce.definition, requestMiddleware);
			assert.equal(middleware.beforeValidation(requestMiddleware).lane, 'beforeValidation');
~~~~

`select` appears in `.agents/tests/public-api-matrix.test.ts:250`:

~~~~ typescript
assert.equal(middleware.select(middlewareCatalog, ['requestMiddleware']).requestMiddleware, requestMiddleware);
			assert.equal(middleware.compose(requestMiddleware, middleware.select(middlewareCatalog, ['requestMiddleware'])).length, 1);
			assert.equal(middleware.document(middlewareCatalog).length, 1);
			const binding = middleware.handler(requestMiddleware, async (_ctx, next) => await next());
~~~~

`compose` appears in `.agents/tests/public-api-matrix.test.ts:251`:

~~~~ typescript
assert.equal(middleware.compose(requestMiddleware, middleware.select(middlewareCatalog, ['requestMiddleware'])).length, 1);
			assert.equal(middleware.document(middlewareCatalog).length, 1);
			const binding = middleware.handler(requestMiddleware, async (_ctx, next) => await next());
			const useOnce = middleware.once(binding);
~~~~

`wholeRequest` appears in `.agents/support/production-fixture.ts:331`:

~~~~ typescript
middleware: [middleware.wholeRequest(WholeRequest), middleware.aroundOperation(AroundOperation)],
	problems: [Forbidden, EntitlementRequired],
});
~~~~

`beforeValidation` appears in `utils/server/service/compile.ts:690`:

~~~~ typescript
beforeValidation: Object.freeze(operation.middleware.beforeValidation.map((entry) => entry.id)),
			afterValidation: Object.freeze(operation.middleware.afterValidation.map((entry) => entry.id)),
			aroundOperation: Object.freeze(operation.middleware.aroundOperation.map((entry) => entry.id)),
		}),
~~~~

`afterValidation` appears in `utils/server/service/compile.ts:691`:

~~~~ typescript
afterValidation: Object.freeze(operation.middleware.afterValidation.map((entry) => entry.id)),
			aroundOperation: Object.freeze(operation.middleware.aroundOperation.map((entry) => entry.id)),
		}),
		resiliency: Object.freeze(operation.resiliency.map((policy) => policy.type)),
~~~~

`aroundOperation` appears in `.agents/support/production-fixture.ts:331`:

~~~~ typescript
middleware: [middleware.wholeRequest(WholeRequest), middleware.aroundOperation(AroundOperation)],
	problems: [Forbidden, EntitlementRequired],
});
~~~~

`validate` appears in `utils/server/service/compile.ts:132`:

~~~~ typescript
const middlewareValidation = middleware.validate(middlewareInput);
		if (!middlewareValidation.valid) {
			for (const item of middlewareValidation.issues) issues.push(issue('invalid-definition', item.message, item.definition));
			continue;
~~~~

`document` appears in `.agents/tests/public-api-matrix.test.ts:252`:

~~~~ typescript
assert.equal(middleware.document(middlewareCatalog).length, 1);
			const binding = middleware.handler(requestMiddleware, async (_ctx, next) => await next());
			const useOnce = middleware.once(binding);
			assert.equal(useOnce.kind, 'middleware-handler');
~~~~

`catalog` appears in `.agents/tests/public-api-matrix.test.ts:249`:

~~~~ typescript
const middlewareCatalog = middleware.catalog(`matrix.middleware.catalog.${index}`, { requestMiddleware });
			assert.equal(middleware.select(middlewareCatalog, ['requestMiddleware']).requestMiddleware, requestMiddleware);
			assert.equal(middleware.compose(requestMiddleware, middleware.select(middlewareCatalog, ['requestMiddleware'])).length, 1);
			assert.equal(middleware.document(middlewareCatalog).length, 1);
~~~~

`MiddlewareContextDefinition` appears in `utils/server/service/runtime.ts:714`:

~~~~ typescript
const values = new Map<MiddlewareContextDefinition, unknown>();
	return Object.freeze({
		/**
		 * Checks whether the required state is present for the compiled service runtime.
~~~~

`MiddlewareContextValue` appears in `utils/server/service/runtime.ts:729`:

~~~~ typescript
get<Definition extends MiddlewareContextDefinition>(definition: Definition): MiddlewareContextValue<Definition> {
			if (!values.has(definition)) {
				throw new TypeError(`Middleware context ${JSON.stringify(definition.id)} is unavailable.`);
			}
~~~~

`MiddlewareDefinition` appears in `.agents/support/production-fixture.ts:570`:

~~~~ typescript
const middlewareHandler = (name: string, definition: middleware.MiddlewareDefinition) => middleware.handler(
		definition,
		async (_state, next) => {
			await trace.record('middleware', `${name}-before`);
~~~~

`MiddlewareHandler` appears in `utils/server/service/compile.ts:415`:

~~~~ typescript
handlers: readonly MiddlewareHandler[],
	issues: ServiceValidationIssue[],
): ReadonlyMap<MiddlewareDefinition, MiddlewareHandler> {
	const result = new Map<MiddlewareDefinition, MiddlewareHandler>();
~~~~

`MiddlewareInput` appears in `utils/server/endpoint/types.ts:84`:

~~~~ typescript
readonly middleware?: MiddlewareInput;
	readonly authentication?: DefinitionInput<CatalogEntryIdentity>;
	readonly permissions?: DefinitionInput<CatalogEntryIdentity>;
	readonly entitlements?: DefinitionInput<CatalogEntryIdentity>;
~~~~

`MiddlewarePlan` appears in `utils/server/service/types.ts:135`:

~~~~ typescript
readonly middleware: MiddlewarePlan;
	readonly authentication: readonly CatalogEntryIdentity[];
	readonly permissions: readonly CatalogEntryIdentity[];
	readonly entitlements: readonly CatalogEntryIdentity[];
~~~~

`MiddlewareResourceResolver` appears in `utils/server/service/runtime.ts:790`:

~~~~ typescript
): endpoint.EndpointResourceResolver & MiddlewareResourceResolver {
	return Object.freeze({
		/**
		 * Checks whether the required state is present for the compiled service runtime.
~~~~

@utils/server/middleware/types
------------------------------

| Export | Kind | Purpose | Use form | Repository use |
| ------ | ---- | ------- | -------- | -------------- |
| `MiddlewareContextDefinition` | interface | Typed request-context value that middleware may require or provide. | `value: MiddlewareContextDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareContextDefinitionInput` | interface | Input accepted by {@link context}. | `value: MiddlewareContextDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareContextStore` | interface | Typed context store visible to one middleware handler. | `value: MiddlewareContextStore` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareContextValue` | type | Value represented by one middleware context definition. | `value: MiddlewareContextValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareDefinition` | interface | Static import-safe middleware contract. | `value: MiddlewareDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareDefinitionInput` | interface | Input accepted by {@link define}. | `value: MiddlewareDefinitionInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareDocument` | interface | JSON-safe middleware documentation projection. | `value: MiddlewareDocument` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareHandler` | interface | Runtime behavior bound to one exact middleware definition. | `value: MiddlewareHandler` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareHandlerContext` | interface | Runtime context supplied to a middleware handler by the server adapter. | `value: MiddlewareHandlerContext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareInput` | type | Direct or explicitly placed middleware value accepted by composition fields. | `value: MiddlewareInput` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareLane` | type | Supported compiler placement lanes. | `value: MiddlewareLane` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareNext` | type | Onion-style continuation used by middleware handlers. | `value: MiddlewareNext` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareOnceKey` | type | Stable key for middleware work that must execute at most once per request. | `value: MiddlewareOnceKey` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewarePlan` | interface | Normalized deterministic middleware lanes. | `value: MiddlewarePlan` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareProblems` | type | Problem definitions represented by one middleware input. | `value: MiddlewareProblems` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareProvides` | type | Provided contexts represented by one middleware authoring input. | `value: MiddlewareProvides` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareRequires` | type | Required contexts represented by one middleware authoring input. | `value: MiddlewareRequires` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareResourceDefinition` | type | Static resource reference accepted by portable middleware contracts. | `value: MiddlewareResourceDefinition` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareResourceResolver` | interface | Resource resolver constrained to the middleware declaration envelope. | `value: MiddlewareResourceResolver` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareResources` | type | Resource definitions represented by one middleware input. | `value: MiddlewareResources` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareResourceValue` | type | Runtime value represented by one middleware resource reference. | `value: MiddlewareResourceValue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareUse` | interface | Use-site placement wrapper around one middleware definition. | `value: MiddlewareUse` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareValidationIssue` | interface | One validation issue in a middleware definition or composition. | `value: MiddlewareValidationIssue` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |
| `MiddlewareValidationResult` | type | Deterministic validation result for middleware composition. | `value: MiddlewareValidationResult` | No current in-repository consumer. Treat this as a public extension or typing surface until a real consumer adopts it. |

Coverage note
-------------

This generated map contains 315 public names across 12 package export targets. 94 names have a direct in-repository use detected through TypeScript imports.

A missing in-repository use is not converted into a fake example. It is a signal that the export is currently an extension point, a type-level support surface, or an API that still needs a concrete adopter.

