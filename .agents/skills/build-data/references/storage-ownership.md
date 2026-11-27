# Storage ownership and authority

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


Use this reference before introducing, removing, or integrating a database, search engine, graph store, cache, artifact format, or queue. The goal is not to assign one fashionable product per workload. The goal is to name the authority, guarantees, failure path, recovery path, and operational owner for every fact.

## Contents

- Evidence-first classification
- Authority map
- Store capability model
- Common store roles
- Cross-store consistency
- Tenant and privacy ownership
- Lifecycle and resource ownership
- Migration sequence
- Failure and recovery
- Test matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Evidence-first classification

Inventory before deciding:

```text
manifests and lockfiles
  -> runtime imports and client factories
  -> schema/migration files
  -> deployment manifests and environment bindings
  -> writer call sites
  -> reader/query call sites
  -> worker/backfill/reconciliation code
  -> production tasks and health checks
```

A README label is a discovery lead. A repository can contain current deployment files, older migrations, experimental engines and documentation from different phases. Trace startup, write and read paths before assigning operational authority to any component.

For each fact/domain, record:

| Question | Required answer |
|---|---|
| Who accepts the authoritative write? | Named store/table/object plus transaction scope |
| What invariant is guaranteed there? | Constraint, isolation, append identity, or documented absence |
| Who serves reads? | Direct authority or named projection/cache |
| What lag is allowed? | Objective and measurement |
| How are corrections/deletes propagated? | Change identity, rebuild, tombstone, mutation, or repair |
| How is state recovered? | Backup/restore, replay, rebuild, reconciliation |
| Who owns schema and lifecycle? | Package/service/team/process |

## Authority map

Use one authority per fact, not necessarily one store per domain:

```yaml
facts:
  account-membership:
    authority: postgres.auth.member
    write-owner: identity-service
    projections:
      - typesense.account-search
    invariants:
      - unique organization_id,user_id
      - current membership checked on protected reads
  raw-provider-event:
    authority: object-storage/import-run/raw
    write-owner: import-worker
    identity: provider + event_id + payload_sha256
  analytics-event:
    authority: clickhouse.events
    write-owner: event-ingest
    correction: versioned replacement with reconciliation
```

“PostgreSQL is primary” is too vague. A user row can be authoritative in PostgreSQL while a provider payload is authoritative in immutable raw capture and an analytical event is intentionally authoritative in ClickHouse. State the granularity.

## Store capability model

Evaluate the installed system against the actual workload:

- write model: transactional, append, bulk, streaming, mutation, replacement;
- consistency and isolation;
- uniqueness, constraints, and referential integrity;
- query/access patterns and indexes;
- schema evolution and migration ownership;
- concurrency and conflict behavior;
- partitioning/sharding/tenant isolation;
- backup, restore, replay, and point-in-time recovery;
- retention, deletion, and legal/privacy obligations;
- connection/resource lifetime;
- observability, failure injection, and operator repair;
- local development and CI parity.

Do not infer capabilities from a familiar method shape. A custom adapter exposing `select().from()` does not imply transactions, relational queries, `RETURNING`, Drizzle Kit migrations, prepared statements, or PostgreSQL semantics.

## Common store roles

These are strong starting hypotheses, not mandates:

| Store | Common role | Must define |
|---|---|---|
| PostgreSQL | Transactional identities, relationships, workflow control state | constraints, isolation, migration, tenant policy, pool lifetime |
| ClickHouse | High-volume events, time-range analytics, aggregates | ordering, partitions, batches, late data, correction convergence, TTL |
| DuckDB | Local/in-process analytics and file transformation | file ownership, concurrency, memory/disk limits, extension policy |
| Typesense/search engine | Rebuildable search projection | document schema, ranking, filters, aliases, lag, deletion, rebuild |
| QLever/graph engine | RDF/SPARQL serving projection | term/ontology identity, complete dataset, index build, update/rebuild policy |
| Object storage | Immutable raw evidence and artifacts | object identity, publication manifest, retention, encryption, delete policy |
| JSONL | Streaming replay/interchange segments | line schema, committed offsets, corruption/compression policy |
| Parquet | Typed analytical staging/batches | explicit schema, row groups, partitions, reader compatibility |
| Queue | Delivery of work, not business state by default | delivery/ordering, visibility/lease, retry/DLQ, deduplication, redrive |

Avoid the “one database for everything” reflex and the opposite “one product per feature” reflex. Operational cost, recovery complexity, and dual-write risk are first-class selection evidence.

## Cross-store consistency

Cross-store writes are not atomic unless an inspected protocol proves they are. Prefer:

```text
transactional authority commit
  -> durable outbox/change record in same commit
  -> projector leases change
  -> idempotent sink write
  -> durable sink receipt/checkpoint
  -> lag and failure visibility
  -> reconciliation/repair
```

For an immutable artifact source, the final manifest can play the durable handoff role. For an external provider, persist the normalized event identity before starting projections.

Define what happens in every crash window:

- authority commit succeeds, change publication fails;
- sink write succeeds, checkpoint fails;
- checkpoint succeeds prematurely;
- projector applies events out of order;
- one of several required sinks fails;
- a privacy deletion reaches some stores but not others.

Exactly-once is rarely the useful claim. Require at-least-once delivery plus idempotent/version-aware application and reconciliation unless a narrower guarantee is proved end to end.

## Tenant and privacy ownership

Tenant authority belongs in server-controlled policy and the authoritative schema:

- include tenant/organization identifiers on owned rows where appropriate;
- use composite unique/foreign-key shapes when relationships must remain within a tenant;
- apply tenant predicates before user filters;
- verify authorization at the authoritative store, not from a search document alone;
- partition or row-level security only when the operational model owns it correctly;
- propagate tenant moves and membership revocations explicitly;
- inventory every projection and artifact affected by deletion/export requests.

A schema can enforce organization-scoped relationships with composite keys. It cannot prove every query enforces the caller's organization policy. Inspect query call sites and request authorization separately; use the consuming application's domain names.

## Lifecycle and resource ownership

For every runtime client, identify:

- construction owner (composition root, worker boot, request scope, test);
- underlying pool/socket/file handle;
- maximum connections/concurrency and timeout behavior;
- readiness/health semantics;
- shutdown and drain method;
- cancellation of in-flight requests;
- test replacement/fake interface.

A database factory that returns only a query wrapper can hide the driver's close operation. Expose a disposable owner, an explicit close handle, or an injected borrowed client. Test shutdown at the composition root; a wrapper type alone does not establish graceful cleanup.

Global logging or environment reads are separate owners. Database construction must not silently configure the application's logger or require environment access at import time. Preserve the consumer's selected owners.

## Migration sequence

When changing ownership:

1. Document current writer/readers and recovery evidence.
2. Define the future authority and invariant contract.
3. Add durable change capture or a named snapshot point.
4. Backfill a versioned target.
5. Reconcile identities, content, tenant policy, and domain invariants.
6. Dual-read or shadow-query when it produces useful evidence.
7. Cut over readers with rollback available.
8. Cut over the single authoritative writer.
9. Observe lag/errors and repair gaps.
10. Remove old writes/read paths only after connected consumers and recovery are verified.

Avoid prolonged dual-authority writes. If both systems accept independent changes, conflict resolution and ownership are unresolved.

## Failure and recovery

| Signature | Likely ownership defect | Correction evidence |
|---|---|---|
| Search result grants access after membership revocation | Projection treated as authorization authority | Current membership read plus server-owned source query |
| PostgreSQL and Typesense differ after request success | Direct dual write has no durable handoff | Outbox/checkpoint and reconciliation |
| ClickHouse is expected to reject duplicate business IDs | OLTP invariant assigned to analytical store | Upstream constraint/idempotency plus convergence model |
| README says Blazegraph, deployment starts QLever | Store selected from documentation label | Active manifests, endpoint, query test |
| Drizzle wrapper exists but process never exits | Pool lifetime owner hidden | Reachable close/drain and in-flight shutdown test |
| Restore brings DB back but search is stale | Recovery stops at authority | Projection rebuild/catch-up runbook |
| Queue says delivered but workflow has no durable state | Delivery confused with acceptance | State transaction/outbox and idempotent consumer |
| Two stores both called source of truth | Conflict policy absent | Fact-level authority map |

## Test matrix

Test:

- constraint enforcement under concurrent writes;
- server-owned tenant filters and cross-tenant attack inputs;
- source commit followed by projector crash in each commit window;
- duplicate and out-of-order change delivery;
- full backup/restore followed by projection rebuild/catch-up;
- privacy delete/export across authority, projections, caches, and artifacts;
- schema migration from representative previous versions;
- empty install and seed idempotency;
- pool exhaustion, database restart, timeouts, and graceful shutdown;
- projection lag and alert thresholds;
- target cutover/rollback during active reads;
- reconciliation with missing, extra, and stale-version records;
- explicit behavior of unsupported adapter capabilities.

## Executable verification

Build a storage inventory from code and deployment, then run store-native checks. Examples to adapt:

```bash
rg -n 'postgres\(|drizzle\(|createClient|Typesense|QLever|ClickHouse|Parquet' .
rg -n 'DATABASE_URL|TYPESENSE|QLEVER|CLICKHOUSE' . --glob '!**/*.lock'
```

Apply migrations to an empty disposable database and upgrade from a representative snapshot. Execute concurrent invariant tests, issue real projection queries, compare identity/version sets, restart processes, and prove close/drain behavior. A typecheck or client-construction test is not storage verification.

## Deliberate exclusions

- Do not mandate a store solely from the table above.
- Do not force PostgreSQL for raw immutable evidence or ClickHouse for small relational workloads without evidence.
- Do not add a queue or outbox when the projection is safely rebuilt from immutable snapshots and the product contract allows that recovery.
- Do not call a cache/search/graph store authoritative by convenience.
- Do not infer transaction or migration support from Drizzle-like syntax.
- Do not force Zod, LogTape, Effect, or any specific configuration/observability framework.
- Do not hide a client's lifecycle behind a wrapper with no close path.
- Do not claim exactly-once, zero-downtime, or point-in-time recovery without executable system evidence.

## Sources and freshness

Use the consumer's active deployment, migrations, startup and query paths to establish authority. Public utility storage contracts are available in [`storage`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/storage/mod.ts); a focused store adapter does not supply an application-wide database policy. Review the selected database or engine's official transaction and recovery documentation at the deployed version. The ownership tables are design criteria, not deployment evidence.
