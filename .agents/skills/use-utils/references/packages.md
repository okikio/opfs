# Okikio Utils source package map

Find the smallest owner in [okikio/utils](https://github.com/okikio/utils).
Every row names an `@okikio/<package>` source package. Slash entries are public
subpaths at the recorded revision; choose an exact entry rather than importing
literal wildcard or brace notation.

**Source snapshot:** `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`, checked 2026-11-26.
The table's versions come from source manifests, not confirmed registry
releases. npm exposed only placeholders or missing packages at that check;
JSR publication could not be verified. Follow [adoption](adoption.md) before
installation. Preserve the consumer's existing owner when it already fits.

## Lifetime, control and cleanup

| Package    | Source version | Use it to                                                             | Main subpaths                                                      | Guide                                                                          |
| ---------- | ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `context`  | 1.0.0   | Give related work one lifetime, deadline and cancellation signal      | `/state`, `/events`, `/testing`                                    | [Context](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/context/01-guide.md) |
| `dispose`  | 0.1.0   | Give cleanup one owner                                                | `/once`, `/run`, `/polyfill`, `/ponyfill`                          | [Dispose](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/dispose.md)        |
| `duration` | 0.1.0   | Write and convert time budgets such as `sec(8)`                       | `/units`, `/conversion`, `/instant`, `/temporal`, `/polyfill`      | [Duration](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/05-duration.md) |
| `task`     | 0.1.0   | Pause, resume or cancel one local operation and await its result      | `/group`, `/progress`                                              | [Task](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/task/01-guide.md)     |
| `result`   | 1.0.0   | Return success or failure as a value; declare failures; bound faults  | `/failure`, `/fault`, `/async`                                     | [Result](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/17-result.md) |

## Work, scheduling and recovery

| Package     | Source version | Use it to                                                              | Main subpaths                                                   | Guide                                                                         |
| ----------- | ------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `activity`  | 1.0.0   | Declare a named job with checked input and output, and run it          | `/engine`, `/local`, `/process`, `/worker`, `/http`, `/selection` | [Activity](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/activity.md)     |
| `workflow`  | 1.0.0   | Record a program's steps so a new worker can resume it after a crash   | `/dispatch`, `/history`, `/replay`, `/execution`, `/testing`    | [Workflows](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/workflows/README.md) |
| `scheduler` | 1.0.0   | Reserve capacity, bound concurrency and queue accepted work            | `/capacity`, `/concurrency`, `/queue`                           | [Capacity](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/capacity.md), [Concurrency](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/concurrency.md), [Queue](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/queue.md) |
| `pool`      | 0.1.0   | Reuse a costly resource, such as a connection or a page, with leases   | root                                                            | [Pool](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/pool.md)             |
| `worker`    | 1.0.0   | Own a child process or thread, its streams and its messages            | `/process`, `/thread`, `/protocol`, `/supervisor`, `/stream`    | [Process](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/process.md), [Worker](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/worker.md) |
| `storage`   | 1.0.0   | Store workflow history, queues, state, sessions and outbox records | `/workflow/postgres`, `/queue/postgres`, `/state`, `/session/postgres`, `/outbox/postgres` | [PostgreSQL](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/postgres/01-workflow.md), [Outbox](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/postgres/02-outbox.md) |
| `capability` | 1.0.0  | Declare resources and requirements; announce effects; choose retries   | `/resource`, `/requirement`, `/effect`, `/resilience`, `/execution` | [Resource](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/resource.md), [Effect](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/effect/01-guide.md), [Resilience](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/resilience.md) |

## Services and the wire

| Package  | Source version | Use it to                                                              | Main subpaths                                                     | Guide                                                                      |
| -------- | ------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `server` | 1.0.0   | Define endpoints and services, compile them and host them; gateways    | `/endpoint`, `/service`, `/gateway`, `/middleware`, `/http`, `/client` | [Server](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/server/01-guide.md) |
| `http`   | 1.0.0   | Read requests, cookies and headers; write responses and RFC 9457 problems | `/request`, `/response`, `/problem`, `/cookie`, `/webhook` | [HTTP](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/http/01-guide.md) |
| `hono`   | 0.1.0   | Host an existing Hono application through the server contract          | root                                                              | [Hono](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/11-hono.md) |
| `query`  | 1.0.0   | Declare the fields a caller may filter, sort and select; parse requests | `/definition`, `/expression`, `/pagination`, `/cursor`, `/url`, `/postgres` | [Query](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/query.md) |
| `authz`  | 0.1.0   | Declare permissions, roles and plan entitlements; check access         | `/permission`, `/role`, `/entitlement`                            | [Authorization](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/authz/01-guide.md) |

## Data, formats and configuration

| Package      | Source version | Use it to                                                         | Main subpaths                                        | Guide                                                                          |
| ------------ | ------- | ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `schema`     | 1.0.0   | Validate values and two-way conversions (codecs), share contracts | `/zod`, `/codec`, `/time`, `/types`                  | [Schema](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/schema/01-schema.md) |
| `env`        | 1.0.0   | Read raw configuration once and validate it into typed options    | `/zod`, `/standard`, `/valibot`, `/resolve`          | [Env](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/env.md)                |
| `format`     | 1.0.0   | Parse and write CSV; parse sitemaps under input budgets           | `/csv`, `/sitemap`                                   | [CSV](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/csv.md), [Sitemap](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/21-sitemap.md) |
| `streams`    | 0.1.0   | Pass bounded bytes, text, JSON and frames while respecting the reader | `/bytes`, `/text`, `/json`, `/frame`, `/reader`, `/events` | [Streams](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/streams.md)    |
| `hash`       | 0.1.0   | Hash exact bytes; derive stable IDs; HMAC                         | `/digest`, `/id`, `/uuid`, `/hmac`, `/stream`         | [Hash](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/10-hash.md)  |
| `collection` | 1.0.0   | Catalogs of named definitions; record fields and bounded JSON changes | `/catalog`, `/record`, `/iterable`                 | [Catalog](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/01-catalog.md), [Record](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/15-record.md) |
| `input`      | 1.0.0   | Collect form, keyboard, pointer, file and clipboard input in a UI | `/forms`, `/keys`, `/pointer`, `/files`, `/commands` | [Input](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/input/01-collection.md) |

## Runtimes and observation

| Package     | Source version | Use it to                                                          | Main subpaths                                         | Guide                                                                        |
| ----------- | ------- | ------------------------------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------- |
| `runtime`   | 1.0.0   | Use Deno, Node, Bun and browser APIs behind one contract            | `/deno/*`, `/node/*`, `/bun/worker`, `/browser/worker` | [Deno](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/04-deno.md) |
| `telemetry` | 0.1.0   | Report events, traces and metrics; the application picks backends  | `/logtape`, `/otel`, `/server`, `/observe`, `/lifecycle` | [Telemetry](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/telemetry/01-guide.md) |
| `utils`     | 1.0.0   | Forward focused package entries from one umbrella           | `/<package>/…`, `/all`                                | [Utils](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/packages/22-utils.md) |

Prefer the focused package in a library. An application may use `@okikio/utils/<package>`; `/all` loads the whole
graph and is only for deliberate broad composition.

## Owner and export checks

- Use `context/state` for local/persisted cells and read-only observations;
  `capability/resource` owns resource acquisition. There are no standalone
  `state` or `resource` packages in this map.
- Keep external `@okikio/observables` for Observable operators and EventBus.
  Context and Input use it; `@okikio/utils/observables` is not an export.
- `server/service` exports both `compile` and `compileDefinition` for executable
  and definition-only graphs. `server/client` and `server/gateway/openapi` exist;
  `http/client` does not.
- `query/postgres` compiles SQL and parameters. It never executes SQL and does
  not replace a database client, ORM, auth factory or SPARQL engine.
- Old standalone entitlement, meter and codec APIs moved to
  `authz/entitlement`, `capability/effect/meter` and `schema/codec`. Follow the
  [consolidation guide](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/maintenance/04-consolidation.md), not a scope-only rename.
- Application-specific entities, facts, extractors, registries, crawl definitions,
  SQL/Drizzle wrappers and private application packages have no implied counterpart.
  Inspect their actual contract and migrate only verified operations.

## Sources and freshness

The public [package directory](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/docs/01-packages.md), each linked package
README/manifest and export target were inspected at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7` on 2026-11-26.
The source contains 27 packages with 516 declared entries including umbrella
forwarders. These counts describe the checkout, not independently installed
packages. Source versions and registry availability are separate evidence.
