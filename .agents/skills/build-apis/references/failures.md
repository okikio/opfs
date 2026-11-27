# API failure diagnosis, recovery, and reachability

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


Use this reference to diagnose API behavior that is wrong, unreachable, unsafe, duplicated, leaking internals, or operationally incomplete. Start from the executable request path. Definitions, generated OpenAPI, types, and handler files can all exist while the capability remains unreachable.

## Contents

- Evidence ladder
- Reachability failures
- Validation and contract failures
- Middleware and composition failures
- Authentication and authorization failures
- Resource and dependency failures
- Error and observability failures
- Workflow/stream failure paths
- Recovery protocol
- Failure-injection matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Evidence ladder

Classify a capability honestly:

```text
described -> defined -> registered -> bootable -> reachable
  -> behaviorally correct -> authorized -> observable -> recoverable
```

Evidence needed:

- description: documentation only;
- definition: method/path/request/response contract exists;
- registration: definition has a matching runtime handler/middleware mapping;
- bootable: the composed service starts with resolved dependencies;
- reachable: an actual request hits the handler;
- correct: response and side effects match the contract;
- authorized: positive and negative tenant/resource policy tests pass;
- observable: one correlated diagnostic and stable client failure;
- recoverable: dependency/process interruption has defined retry/repair behavior.

Never upgrade a lower rung into a higher claim.

## Reachability failures

| Signature | Likely defect | Evidence to inspect | Correction proof |
|---|---|---|---|
| OpenAPI lists route but request is 404 | definition included in docs but omitted from runtime registry | definition aggregate, handler map, registration loop | startup conformance plus real request |
| Handler exists but never runs | name/key/method/path mismatch | `Definition.Name`, handler keys, base path, mount | invocation counter/request fixture |
| Startup only warns about missing handler | partial registry tolerated | startup validation policy | fail boot or explicitly mark capability unavailable |
| Empty 200/204 from stub | unavailable behavior hidden as success | handler body, TODO/stub, side-effect oracle | unregister, explicit 501/capability response, or implement |
| Middleware executes twice | nested app/root factory or duplicate mount | app construction tree and middleware counters | one root and exact-once request test |
| Service imports but cannot boot alone | hidden root dependency/env/global side effect | import graph, config/resource creation | standalone composition-root boot |
| Correct route under wrong prefix | base path/function/mount drift | host routing and generated URLs | deployed-path request |

Separate the declared service contract from runtime composition and handler registration. The consumer owns file names and layout. Test conformance where its actual host binds handlers to the contract.

## Validation and contract failures

| Signature | Likely defect | Correction |
|---|---|---|
| `c.req.valid('json')` empty/unsafe | matching validator middleware missing or wrong source | register exact source schema before handler; request test |
| Query accepted but ignored | disabled feature silently normalizes/handler ignores | reject or document explicit disabled semantics |
| Header validation fails by casing | transport normalization mismatch | use framework/header canonical behavior and tests |
| Form/file request consumes body twice | multiple parsers/middleware ownership | one body parsing owner and size limits |
| OpenAPI response passes but client fails | schema models payload, not status/headers/envelope variants | contract actual response tuples/variants |
| Type uses schema object rather than inferred data | `typeof Schema.Input`/similar misconception | verified schema-library inference helper |
| Default sort/count changes unnoticed | semantic contract not in schema diff | behavioral compatibility snapshots |
| Validation error becomes 500 | expected issues cross wrong error mapper | stable 400/422 mapping and issue paths |

If using Standard Schema, inspect `~standard.validate` result shape and async behavior at the installed implementation. If using Zod or another owner, preserve its supported inference and error APIs. Do not force either.

## Middleware and composition failures

Middleware executes as an ordered/onion system. Establish ownership:

```text
host/root: proxy trust, request ID, correlation, access diagnostics, CORS/security, final error mapper
service: long-lived/request-scoped dependency adaptation and service policy
route: authentication/authorization, validation, rate/capability policy
handler: domain call and response shaping
```

Failure signatures:

- response diagnostics missing because middleware does not await `next()`;
- error logged multiple times at route, service, and root;
- request ID generated twice and changes mid-request;
- wildcard CORS plus credentials or unsafe “production default”;
- pretty response formatting modifies stable result/download/stream output;
- service-wide DB/client created per request;
- framework app factory called in nested endpoint groups and installs root middleware again;
- thrown exception bypasses stable problem mapping;
- proxy headers trusted from untrusted peers.

Check CORS against the actual route audience. Keep application LogTape configuration and resource startup at the executable root; importing a definition must not read environment configuration, start listeners, or configure process-wide logging.

## Authentication and authorization failures

Authentication says who the session represents. Authorization says whether the current principal may act on the current resource now.

| Signature | Defect | Required proof |
|---|---|---|
| User sees another organization's row | request org ID used as authority | current membership plus source query scoped by org/resource |
| Valid session retains revoked access | membership cached/assumed for session lifetime | revocation test and policy re-read |
| Search result grants access | projection used as permission authority | authoritative membership/resource check |
| Status endpoint leaks execution existence | start route protected but status/cancel not equally scoped | every workflow endpoint policy matrix |
| SSE continues after access revoke indefinitely | long-lived auth policy undefined | reconnect/revalidation/termination test |
| Admin/provider webhook trusts body identity | authenticity/authorization absent | signature/replay verification and source policy |

Choose and document 403 versus non-disclosing 404. Apply the same policy to counts, errors, timings where practical, streams, exports, and workflow controls.

## Resource and dependency failures

| Signature | Cause | Repair evidence |
|---|---|---|
| Import fails without env/network | construction at module scope | import-safe contract modules and explicit composition root |
| Connections grow per request | pool/client/runtime built in middleware/handler | acquisition count and host-owned lifetime |
| Shutdown hangs | hidden close/drain or intake still active | stop intake, abort/drain, dispose resources |
| Healthy endpoint while DB schema missing | liveness used as readiness | dependency/schema/capability readiness |
| Timeout returns but query continues | request abort not propagated | cancellation trace and resource release |
| Retry duplicates mutation | blanket request retry without idempotency | idempotency key and side-effect oracle |
| Test fake passes while real adapter fails | fake omits transport/driver semantics | container/deployed integration test |

Health, readiness, and startup are different. Liveness should not flap for a transient downstream; readiness should prevent serving a capability whose required dependency/schema is unavailable.

## Error and observability failures

One failure should produce:

- one stable client problem without secrets/internal messages;
- one primary correlated diagnostic at the ownership scope;
- structured cause chain retained internally;
- trace/request ID shared across middleware, dependency calls, workflow start, and stream where applicable;
- retryability and operator action classification.

Failure signatures:

- raw SQL/provider/stack text in response;
- every layer logs the same error;
- handler catches unknown error and returns empty success;
- 500 converted to 200 by generic response helper;
- stable result body receives diagnostic prefixes;
- correlation context disappears across async callbacks;
- problem `instance` exposes an internal path or sensitive query;
- errors use unstable human strings as machine codes.

Do not require LogTape. If it is selected, configure it once at the application composition root, not in a reusable server module. Otherwise use the selected observability owner with the same category/correlation/redaction contract.

## Workflow/stream failure paths

| Signature | Defect | Proof |
|---|---|---|
| Start returns 202 but no durable record/queue | acceptance precedes durable commit | execution/status immediately readable; restart test |
| Status says success while required sink failed | global workflow state collapses per-stage results | stage/sink manifest and response policy |
| Cancel endpoint returns success but runtime cannot cancel | capability inferred from definition | runtime adapter/conformance and terminal-state test |
| SSE reconnect loses events | no durable event ID/replay checkpoint | `Last-Event-ID` replay fixture |
| Slow stream client grows memory | no backpressure/bounds | slow-reader memory oracle |
| Request abort leaves work running unintentionally | cancellation ownership absent | abort trace and explicit detach policy |
| Workflow runtime adapter returns “not implemented” | public route exposed before capability | unregister/501/readiness until implemented |

## Recovery protocol

1. Identify the first failed rung in the evidence ladder.
2. Preserve request/trace ID, deployment version, resolved config (redacted), route inventory, dependency state, and affected durable IDs.
3. Reproduce with the smallest real request and record status/headers/body/side effects.
4. Determine whether the request was rejected before commit, committed, partially committed, or completed with response loss.
5. Retry only if idempotency and commit evidence make it safe.
6. Repair registry/config/schema/dependency ownership at the failing interface.
7. Run positive, negative, interruption, and restart tests.
8. Update readiness/capability reporting so the same partial state is visible.

For ambiguous mutations, query by idempotency/request/execution identity before retrying.

## Failure-injection matrix

Inject:

- missing handler/definition/middleware mapping;
- invalid each-source payload, oversized input, repeated keys, wrong content type;
- expired/tampered cursor;
- membership revoke between auth and query;
- cross-tenant resource IDs;
- dependency connect/query timeout, restart, malformed result;
- process loss before/after authoritative commit;
- request abort before and during dependency call;
- duplicate idempotency key and concurrent request;
- response serialization failure after side effect;
- SSE slow reader, disconnect, replay gap, and revocation;
- workflow start/status/cancel with unavailable runtime;
- shutdown with active requests and streams.

## Executable verification

Verification sequence:

```text
import contract module without env/network
  -> boot service from explicit config and disposable dependencies
  -> compare definitions, handlers, middleware, OpenAPI, and route inventory
  -> issue real positive/negative requests
  -> inspect authoritative side effects
  -> inject dependency/process failures
  -> restart and reconcile by request/execution ID
  -> stop intake and prove clean shutdown
```

Use repository-native tasks and a real HTTP client. Assert exact middleware invocation counts, response status/headers/body, current authorization, side effects, stable problem shape, and one diagnostic owner. A handler unit test alone does not prove routing, middleware, serialization, or host configuration.

## Deliberate exclusions

- Do not force Hono, Zod, Standard Schema, LogTape, Effect, Drizzle, or Better Auth.
- Do not call a route implemented from definition/OpenAPI existence.
- Do not keep stubs reachable as successful capabilities.
- Do not treat valid sessions as current resource authorization.
- Do not retry ambiguous mutations without idempotency/commit evidence.
- Do not configure global logging or create pools at reusable-module import.
- Do not log the same expected failure at every layer.
- Do not report structural/type checks as executable API verification.

## Sources and freshness

Primary utility source: [`server/service`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/service/mod.ts), [`http`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/http/mod.ts) and [`capability/resource`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/capability/resource/mod.ts). The tables describe conditions to investigate; they do not assert that a current library or consumer contains those defects. Reproduce a failure against the resolved framework, validation, authentication and runtime versions before assigning a cause.
