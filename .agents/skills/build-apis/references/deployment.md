# API deployment and resource ownership handoffs

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


## Contents

- [Deployment contract](#deployment-contract)
- [Configuration ownership](#configuration-ownership)
- [Resource graph](#resource-graph)
- [Health and readiness](#health-and-readiness)
- [Shutdown and draining](#shutdown-and-draining)
- [Independent-deployability matrix](#independent-deployability-matrix)
- [Verification](#verification)
- [Failure signatures](#failure-signatures)

## Deployment contract

For every API artifact, record:

- runtime and executable entrypoint;
- public/internal base URL and route prefix;
- environment/config schema;
- required databases, queues, workflow engines, object stores, auth providers,
  network peers, secrets, and certificates;
- migration owner and minimum/maximum compatible schema versions;
- worker processes and task queues required for accepted work;
- observability sinks and failure policy;
- health, readiness, startup, and shutdown semantics;
- expected concurrency, timeouts, body/stream limits, and proxy behavior;
- rollout and rollback order.

An import-safe library package is not an independently deployable service until
an executable host proves this contract.

## Configuration ownership

Resolve configuration once. If c12/defu merge files, environment, and CLI
overrides, complete that merge before constructing service resources. Validate
the final result with Zod and preserve safe provenance for `config explain`.

Do not:

- read required env at module import;
- let each database/auth/workflow module invent precedence;
- merge arrays by accidental concatenation;
- treat empty string, false, zero, null, and absence as equivalent;
- log resolved secrets;
- silently default security-sensitive production values.

Separate deployment config from request input and domain records. Version the
config schema when operators need a migration path.

## Resource graph

Inventory each resource:

| Resource | Owner | Acquire | Health | Drain/close |
|---|---|---|---|---|
| HTTP listener | Host | Start after readiness prerequisites | Accept loop | Stop admission, drain |
| Postgres pool | Host Layer | Once | Lightweight query/pool stats | Close after requests/workers |
| Auth instance | Host | Once per config | Dependency-specific | Close adapter if supported |
| Workflow client | Host | Once | Engine connectivity | Drain/close client |
| Log/trace sinks | Observability Layer | Once | Exporter status | Flush with timeout |
| SSE subscription | Request scope | Per stream | Delivery activity | Cancel on disconnect |

Resources created inside request handlers need an explicit reason. Transactions,
temporary artifacts, and subscriptions are request-scoped; pools and sinks are
not.

## Health and readiness

- Liveness answers whether the process should be restarted. It should not fail
  solely because a downstream dependency is temporarily unavailable.
- Readiness answers whether new traffic should be admitted. It can include
  required dependency and registry checks.
- Startup checks can validate configuration, migrations, registries, workflow
  catalogs, and ports before readiness becomes true.

Accepted durable-start routes must not report ready when they cannot persist or
submit accepted work according to contract. A read-only degraded mode can remain
ready only if routing/capability status makes that behavior explicit.

## Shutdown and draining

Use this order:

1. mark unready and stop new admission;
2. stop accepting new listeners/streams;
3. ask workers to stop claiming new work;
4. drain in-flight requests, activities, and stream writes within a deadline;
5. release leases or let their durable expiry recover them;
6. flush telemetry;
7. close workflow clients, auth adapters, database pools, and listener;
8. force termination only after the published deadline.

Test both cooperative shutdown and abrupt termination. Finalizers cannot repair
a SIGKILL; leases, idempotency, and reconciliation must.

## Independent-deployability matrix

| Question | Required evidence |
|---|---|
| Can it boot alone? | Minimal production-like config and boot test |
| Can clients discover its contract? | Versioned OpenAPI/event schemas |
| Can it roll forward/back? | Compatibility matrix and migration policy |
| Can it operate without monolith imports? | Artifact dependency inspection |
| Can it expose accepted work honestly? | Worker/engine reachability readiness |
| Can it shut down safely? | Drain and forced-restart tests |
| Can operators diagnose it? | Structured health, logs, traces, metrics, config provenance |

## Verification

- Build the exact deployment artifact.
- Boot it with minimal config and with each missing required dependency.
- Send real requests through the deployed adapter, not only `app.request`.
- Compare runtime routes and OpenAPI.
- Exercise auth, CORS, proxy headers, body limits, cancellation, and streaming.
- Run migration compatibility against current and previous application versions.
- Kill during requests and durable starts; verify retry/recovery and no false 202.
- Drain under load and assert resource close/telemetry flush deadlines.
- Scan the artifact for unintended modules, secrets, and development middleware.

## Failure signatures

| Signature | Likely defect |
|---|---|
| Health is green but every request 500s | Liveness used as readiness |
| 202 returned while worker absent | Durable admission not part of readiness |
| Service imports monolith root | Separation is organizational only |
| Deploy requires undocumented env | Import-time or scattered config |
| Rollback fails after migration | No schema compatibility window |
| Shutdown drops accepted work | Admission/drain ordering wrong |
| Tests pass only with shared dev server | No standalone artifact verification |

## Sources and freshness

- Hono official documentation: https://hono.dev/docs/getting-started/basic
  (primary source; deployment adapters differ).
- Deno deployment/runtime documentation: https://docs.deno.com/runtime/
  (primary source; verify selected host and current Deno release).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/service/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
