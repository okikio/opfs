`@utils/server/service`
=======================

`@utils/server/service` is the composition, compilation, and Hono runtime layer
for one independently deployable HTTP service.

It does not own Clerk, Better Auth, Unkey, permissions, entitlements, billing,
Postgres, ClickHouse, SPARQL, or workflow persistence. Those packages export
provider-neutral definitions and runtime implementations. The service layer
links those imported values into one verified operation graph.

```text
static definitions + runtime bindings
                 |
                 v
          service.compile()
                 |
       +---------+----------+
       |                    |
       v                    v
effective operations   generated artifacts
       |                    |
       v                    +-- OpenAPI
 service.create()           +-- route manifest
       |                    +-- resource/environment manifest
       v                    +-- security/billing/workflow inventory
   Hono runtime
```

Define, implement, compile, create
----------------------------------

```ts
const EnrichmentService = service.define({
  id: 'enrichment',
  path: '/api/enrichment/v1',
  environment: EnrichmentEnvironment,
  middleware: [
    middleware.wholeRequest(RequestDiagnostics),
  ],
  resources: [Postgres, ObjectStorage],
  endpoints: [Imports],
  workflows: [ProcessImport],
});

const EnrichmentImplementation = service.implement(
  EnrichmentService,
  {
    endpoints: [CreateImportHandler, ListImportsHandler],
    middleware: [RequestDiagnosticsHandler],
    resources: resource.implementations(
      PostgresImplementation,
      ObjectStorageImplementation,
      ImportRepositoryImplementation,
    ),
    workflows: [ProcessImportHandler, ParseImportHandler],
  },
);

const compiled = service.compile(EnrichmentImplementation);

await using runtime = service.create(compiled, {
  host: { deploymentId },
  concerns: {
    authenticate,
    authorize,
    entitlements: enforceEntitlements,
    billing: enforceBilling,
    resilience: service.composeRuntimes(
      durableAdmissionRuntime,
      service.standardRetry(),
      providerCircuitRuntime,
    ),
  },
});
```

What “compile” means here
-------------------------

Compilation is not TypeScript transpilation or bundle generation. It is closer
to linking and partial evaluation:

1. flatten imported endpoint/group/selection trees;
2. calculate full service/group/endpoint paths;
3. gather service, targeted-policy, group, endpoint, and operation
   contributions;
4. normalize middleware lanes and resilience policies;
5. calculate the effective authentication, permission, entitlement, billing,
   resource, response, problem, and workflow envelopes;
6. bind exact imported definitions to supplied implementations;
7. reject missing, duplicate, conflicting, or unreachable implementations;
8. produce immutable per-operation execution plans and generated artifacts.

The compiler makes several failures impossible to discover only after a real
request arrives. For example, it rejects an endpoint without a handler, a
resource without an implementation, an operation with two conflicting timeout
policies, an unsafe retry without idempotency, and two operations that own the
same method/path.

```text
service definition
  |
  +-- service contributions
  +-- targeted service policies
  +-- endpoint group contributions
  +-- endpoint path contributions
  +-- operation contributions
  |
  v
one EffectiveServiceOperation
  |
  +-- exact handler
  +-- ordered middleware plan
  +-- concern envelopes
  +-- resource closure
  +-- response/problem envelope
  +-- staged resilience plan
```

Provider-neutral concern state
------------------------------

The identity, authorization, entitlement, and billing packages specialize the
request state with their exact application types. `utils/server` does not use
provider SDK sessions or untyped dependency bags.

```ts
interface EnrichmentConcerns extends service.ServiceConcernValues {
  readonly authentication: Authentication;
  readonly actor: Actor;
  readonly organization: OrganizationAccess;
  readonly authorization: AuthorizationContext;
  readonly entitlements: EntitlementSnapshot;
  readonly billing: BillingAdmission;
}

const runtime = service.create<EnrichmentHost, EnrichmentConcerns>(
  compiled,
  {
    host,
    concerns: {
      async authenticate(requirements, state) {
        const authentication = await identityRuntime.authenticate(
          requirements,
          state.request,
        );
        return {
          authentication,
          actor: authentication.actor,
          organization: authentication.organization,
        };
      },

      async authorize(permissions, state) {
        const authorization = await permissionRuntime.enforce(
          permissions,
          state.actor,
          state.organization,
        );
        return { authorization };
      },

      async entitlements(definitions, state) {
        const entitlementState = await entitlementRuntime.enforce(
          definitions,
          state.organization,
        );
        return { entitlementState };
      },

      async billing(contracts, state) {
        const billingState = await billingRuntime.enforceRequestSafe(
          contracts,
          state,
        );
        return { billingState };
      },
    },
  },
);
```

Domain packages own those concrete types. Clerk and Better Auth adapters return
the same provider-neutral authentication value. Permission evaluators consume
that value rather than provider claims. Billing reads locally authoritative
entitlement, balance, capacity, and usage state instead of calling Polar during
every request.

Exact request lifecycle
-----------------------

```text
raw Request
|
+-- establish request ID, trace, cancellation, absolute deadline
+-- enforce native body limit
|
+-- wholeRequest middleware
|   |
|   +-- beforeValidation middleware
|       |
|       +-- authentication concern
|       +-- bounded wire parsing
|       +-- Standard Schema validation
|       |
|       +-- afterValidation middleware
|           |
|           +-- admission resilience
|               rate limit -> idempotency -> bulkhead
|               |
|               +-- authorization concern
|               +-- entitlement concern
|               +-- request-safe billing concern
|               |
|               +-- operation resilience
|                   retry -> circuit breaker
|                   |
|                   +-- aroundOperation middleware
|                       transaction/unit of work
|                       |
|                       +-- endpoint handler
|
+-- verify returned response/problem definition
+-- validate successful response body
+-- finalize pagination/envelopes/metadata
+-- materialize through the Hono Context
+-- observe body drain/cancel/error
+-- dispose request-owned memoized values and execution timer
```

The resilience split is deliberate. A retry wraps a complete operation attempt,
including `aroundOperation` middleware, so each attempt gets a fresh database
transaction. It does not automatically re-run authentication, authorization,
entitlement evaluation, or billing admission. Idempotency and rate-limit
admission surround the concern checks and operation as one request admission.

Validation layers
-----------------

The service runtime validates at several different times:

| Time | Validation | Examples |
|---|---|---|
| Definition creation | Local authoring invariants | canonical path, non-empty ID, compatible body slots |
| Service compilation | Whole graph integrity | route collisions, missing handlers, resource cycles, conflicting policies |
| Runtime creation | Host capability coverage | missing auth/billing/resilience runtime |
| Wire parsing | Bounded HTTP syntax | header bytes, duplicate cookies, malformed JSON, body size |
| Standard Schema | Endpoint input semantics | IDs, dates, enums, transformed query values |
| Concern stages | Security and commercial rules | actor access, entitlement grant, credit admission |
| Handler return | Declared result membership | undeclared problem/response, raw response without opt-in |
| Response body | Output schema | handler produced an invalid payload |
| Transport finalization | Request-aware HTTP behavior | content negotiation, pagination links, conditional response |

Raw responses
-------------

An operation must opt into `rawResponse: true` before its handler may return a
native `Response`. Use that for WebSockets, SSE, transparent proxying, byte
ranges, or provider-native streams. Ordinary domain handlers return declared
`ResponseResult` or `ProblemResult` tuples so membership, schemas, OpenAPI, and
instrumentation remain enforceable.
