# Services, HTTP, queries and effects

## Choose the required level

A plain Fetch handler can be enough. Add a declared service when implementations,
clients, gateways and documentation need shared method, path and schema facts.

| Stage | Owns | Does not establish |
| --- | --- | --- |
| Definition | Import-safe contracts and exact identity | Open clients or a listening port |
| Implementation | Exact handler/resource bindings | Validity of the complete graph |
| Compilation | Checked graph and prepared route plan | Deployment or authenticated requests |
| Runtime | Live requests and owned resource lifetimes | Ownership of injected clients |
| Host | Listener, environment, credentials and shutdown | Business acceptance from transport success |

Use the public [source export map](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/package.json), then the
consumer's resolved version. `service.compile(implementation)` builds the
executable graph; `service.compileDefinition(definition)` prepares a graph
without handlers for client/gateway/documentation work. Both are exported.

## Select the public entry

| Need | Entry |
| --- | --- |
| Request parsing, cookies, headers, responses and problems | `@okikio/http/request`, `/cookie`, `/response`, `/problem` |
| Methods, paths, input and response definitions | `@okikio/server/endpoint` |
| Declared request values and middleware lanes | `@okikio/server/middleware` |
| Bind, compile and create a service | `@okikio/server/service` |
| Native Fetch routing | `@okikio/server/http` |
| Route ownership and forwarding | `@okikio/server/gateway` |
| Typed service client | `@okikio/server/client` |
| OpenAPI | `@okikio/server/endpoint/openapi`, `/gateway/openapi`, `service.openapi` |
| Existing Hono application | `@okikio/hono` |

There is no `@okikio/http/client` entry in the inspected source. A root function
does not imply a matching subpath. Match exact definition objects when binding
handlers; equal string IDs do not recreate identity.

## Compose a small service

This example targets the inspected source, not an assumed published release.
Resolve imports through that checkout or verify a release first. The optional
polyfill modules belong to the host when its globals are absent.

```ts
import '@okikio/duration/polyfill';
import '@okikio/dispose/polyfill';
import * as endpoint from '@okikio/server/endpoint';
import * as service from '@okikio/server/service';
import * as response from '@okikio/http/response';
import * as schema from '@okikio/schema';

const GreetingSchema = schema.object({ message: schema.string() });
const QuerySchema = schema.object({ name: schema.string({ minLength: 1 }) });
const Greeting = response.ok(GreetingSchema, {
  id: 'greeting.ok', description: 'A greeting for the supplied name.',
});
const Greet = endpoint.get({ id: 'greeting.get', path: '/greeting', query: QuerySchema, responses: [Greeting] });
const Api = service.define({ id: 'greeting-api', path: '/api', endpoints: [Greet] });
const implementation = service.implement(Api, {
  endpoints: [endpoint.handler(Greet, ({ input }) =>
    response.create(Greeting, { message: `Hello, ${input.query.name}!` }))],
});
await using runtime = service.create(service.compile(implementation), { host: {} });
const reply = await runtime.fetch(new Request('https://service.invalid/api/greeting?name=Sam'));
console.log(reply.status, await reply.text()); // 200 {"message":"Hello, Sam!"}
```

The request stays in process and starts no listener. Consuming the response body
and awaiting runtime disposal finish the demonstrated ownership path. The source
exports support this composition; an installed-package or deployment claim
requires its own fixture. The handler receives checked `input`; Hono's
`c.req.valid()` is not part of this handler API.

## Keep resources and policy with their owners

Use `@okikio/capability/resource` to declare a typed value, bind its constructor
and acquire it lazily. A collection owns what it creates. Consumers borrow
values and must not close their caller's database or transport.

`resource.implement()` defaults to owned values; an explicit `borrowed` option
keeps ownership with the caller. Factories receive `definition`, `dependencies`,
`environment`, `host` and `ctx`. The collection joins admitted acquisition and
cleans up partial construction. Use requirements are checked for every borrower,
including cache hits, so one actor cannot inherit another actor's authority.

A `Context` carries lifetime, cancellation, clock and identity. Endpoint input,
host configuration and declared resources remain separate arguments. Requirements
declare policy; the host interprets it. Permissions, entitlements, quota and
placement have different contracts.

## Treat queries and effects according to their guarantees

`query.define()` checks the caller's allowed fields, operators, sorting and
pagination. The [PostgreSQL adapter](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/query/postgres.ts) exports
`compile` and `compilePage`; it produces SQL and parameters and never executes
them. The application owns execution, transactions, tenant policy, cursor scope
and counts. Reject unsupported query features before touching storage.

`@okikio/capability/effect` describes required consequence announcements. It is
distinct from the third-party Effect library. `effect.emit()` transfers an
occurrence to the chosen accepting emitter. A successful return proves only
that emitter's acceptance contract. A business write and announcement are atomic
only when the actual transaction and outbox implement that guarantee; inspect
`@okikio/storage/outbox/postgres` for that integration.

## Verify the composed path

Check import safety, exact identity, missing bindings, valid/malformed requests,
response contracts, current-actor authorization, cancellation and body cleanup.
Use the real host for listener/readiness/shutdown claims and the real storage
adapter for transaction claims. Route detailed API work to
[build-apis](../../build-apis/SKILL.md) and data execution to
[build-data](../../build-data/SKILL.md).

## Sources and freshness

Checked 2026-11-26 at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`:
[service](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/service/mod.ts),
[compilation](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/server/service/compile.ts),
[HTTP responses](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/http/response/mod.ts),
[resources](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/capability/resource/mod.ts),
[queries](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/query/postgres.ts), and
[effects](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/capability/effect/mod.ts).
See [adoption](adoption.md) for source-versus-release status.
