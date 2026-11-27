# Compose backend libraries through explicit contracts

Select the existing application's owners first. Standalone libraries can add a
specific capability, such as SPARQL serialization or Observable composition.
The public [okikio/utils source](https://github.com/okikio/utils/tree/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7)
provides a separate set of service, HTTP, query, schema and resource contracts.
Use [use-utils](../../use-utils/SKILL.md) for its source-versus-release checks.

## Match the need to the current owner

| Need | Candidate | Integration question |
| --- | --- | --- |
| Shared route/input/response facts | `@okikio/server/endpoint` | Do bindings use the same definition objects? |
| Bind, compile and execute a Fetch service | `@okikio/server/service` | Who owns resources and response-body completion? |
| HTTP response representation or problem | `@okikio/http/response`, `/problem` | Are status, headers, payload and public errors declared? |
| Check a public query language | `@okikio/query` | Which fields, operators and pagination are allowed? |
| Produce PostgreSQL statements | `@okikio/query/postgres` | Who executes SQL and applies tenant/transaction policy? |
| Construct SPARQL | `@okikio/sparql` | Which versioned exports serialize terms, transport and results? |
| Observe local events | `@okikio/observables` | Who owns subscriptions, buffering and teardown? |
| Acquire a shared client | `@okikio/capability/resource` | Is the created value owned or borrowed? |
| Parse host configuration | `@okikio/env` | Which explicit source and schema own validation? |

Candidate names describe verified source owners, not universal dependencies or
published release guarantees. There is no generic current `@okikio/db`,
`@okikio/backend-utils`, SQL/Drizzle executor or Better Auth factory established
by the utility workspace. `authz` has authorization contracts; it does not
establish authentication-provider or session behavior.

## Follow the request and ownership path

Keep import-safe endpoint definitions separate from implementation binding,
graph compilation, live service creation and the host listener. Use
[the complete service example](../../use-utils/references/services.md) when that
model fits. A plain Fetch route does not require a compiled graph.

Current endpoint slots are lower-case, including `param`, `query`, `header`,
`cookie`, `json`, `form` and `raw`. A compiled handler receives checked `input`;
a framework-specific `c.req.valid()` belongs only to an independently selected
framework validation path. Preserve one validation owner for each contract.

Use exact identity when binding handlers/resources. Compilation checks the graph;
it does not authenticate a request. Check current membership, tenant and record
policy at the application's actual operation. A shared resource cache must not
reuse the first borrower's authorization for later callers.

Keep database/transport disposal with the creating owner. Return an explicit
lifetime handle or accept a borrowed client. Response streams must propagate
cancellation and expose completion so request resources are not closed while
bytes are still in use.

## Verify data and errors at the actual executor

Parse public queries before compiling storage operations. `query/postgres`
returns SQL and parameters without executing them. Select counts, cursor scope,
stable ordering, transaction rules and tenant filters in the application.
For SPARQL, serialize values through verified term helpers; never concatenate
untrusted expression fragments into `raw()`.

Separate domain failures, unexpected faults and public HTTP problems. Do not
expose database credentials, provider bodies or stack traces. Application
composition owns environment discovery, LogTape/OpenTelemetry configuration,
provider clients, listeners and shutdown.

Verify valid and rejected requests, undeclared handler results, wrong-tenant
access, cancelled/failed streaming responses and repeated resource borrowing.
Use the actual adapter for database and deployment claims. Follow
[build-apis](../../build-apis/SKILL.md), [build-data](../../build-data/SKILL.md)
and [build-auth](../../build-auth/SKILL.md) for the corresponding behavior.

## Sources and freshness

Utility contracts checked on 2026-11-26 at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`:
[endpoint](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/endpoint/mod.ts),
[service](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/service/mod.ts),
[resources](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/capability/resource/mod.ts),
[SQL compilation](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/query/postgres.ts),
[HTTP response](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/http/response/mod.ts), and
[environment](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/env/mod.ts).
Standalone-library references retain their own version scope; recheck the
consumer rather than treating an old workspace alias as a current package.
