---
name: build-data
description: Design, implement, migrate, review, diagnose, benchmark, or verify data architecture, operational databases, analytical stores, search and graph projections, schemas, migrations, query layers, ingestion artifacts, and ORM or driver integrations. Use for PostgreSQL, ClickHouse, Drizzle, DuckDB, Typesense, QLever, RDF/SPARQL stores, JSONL, Parquet, custom dialects, pagination, counts, retention, deduplication, schema evolution, rebuilds, or data-quality failures.
---

# Build data systems

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



## Select the complete task

Read [applying standards](../../guides/applying-standards.md) before domain work.
Select companions by the contracts being changed, with one discovery pass,
plan, and verdict. For repository work, use the shared quality contract when installed
for naming, schemas, tests, documentation, validation, and completion. Apply
rules by purpose; test-runner imports and trivial private fixtures are not
public runtime APIs. If a companion is absent, use the bundled compact defaults
and inspect local instructions rather than inventing unavailable guidance.

This skill owns data authority, storage roles, schema/migration contracts, query
semantics, durable artifacts, and rebuildable projections. Do not choose an
engine or ORM abstraction before classifying the workload and the data that is
authoritative.

`build-workflows` owns durable coordination around multi-stage work.
`build-apis` owns public request contracts. the shared quality contract owns the final
completion verdict.

## Outcome

A reader should be able to trace one logical fact/record from authority to every
projection that matters:

```text
authoritative input/write
       |
       v
validated normalized record
       |
       +--> OLTP store
       +--> immutable/raw artifact
       +--> analytics projection
       +--> search projection
       +--> graph projection
       |
       v
manifest / checkpoint / reconciliation evidence
       |
       v
queries and reports
```

A process exit code or row count alone is not proof that all required outputs
committed correctly.

## Ownership preflight

For each dataset or projection, record:

- authoritative source and rebuildable copies;
- workload: transactional, analytical, search, graph, stream, artifact, cache;
- keys, uniqueness, ordering, partitioning, and identity evolution;
- schema owner, versioning, migration owner, and compatibility posture;
- volume, ingest rate, query latency, consistency, and concurrency;
- late, duplicate, corrected, missing, deleted, and replayed data behavior;
- retention, privacy, tenant scope, audit, and deletion requirements;
- transaction/commit semantics and partial-failure behavior;
- connection/client/resource lifetime and deployment ownership;
- recovery, rebuild, reconciliation, and validation paths.

Do not force OLTP and OLAP through one abstraction merely because the query API
looks similar.

## Schema and field rules

1. Project-owned executable data contracts are schema-first. Zod constants end
   in `Schema`; inferred data normally ends in `Type`; drivers/sessions/stores
   remain behavior interfaces with concrete nouns.
2. Document field units, provenance, authority, null versus missing semantics,
   timestamps/timezones, version meaning, retention, and sensitive-data policy
   on the schema/record field that owns the contract.
3. Keep authoring, normalized, persisted, wire, and analytical shapes distinct
   when their semantics differ. Do not create one giant optional schema to avoid
   a real migration/normalization step.
4. Standard Schema is an interop protocol, not a replacement for data modeling.
   Standard JSON Schema is a separate representation concern.

## Storage-role rules

- **PostgreSQL/OLTP:** authoritative transactional records, constraints,
  concurrency, durable mutations, and relational queries.
- **ClickHouse/OLAP:** analytical scans/aggregates and append/upsert patterns
  designed for its engines. Do not pretend PostgreSQL transaction semantics
  carry over.
- **Search:** rebuildable serving projection with explicit index version,
  document mapping, aliases/cutover, per-item bulk results, and reindex path.
- **Graph/RDF:** project graph vocabulary and identity are distinct from query
  engine choice. Keep canonical facts/quads/artifacts independent enough to
  rebuild a QLever/Blazegraph/other projection where intended.
- **Artifacts:** raw evidence, JSONL, Parquet, manifests, source maps, and
  immutable snapshots have explicit schemas, checksums, versions, and
  publication points.
- **Caches:** never become unrecorded authority by accident.

## Procedure

1. Classify data authority and workload before selecting engines.
2. Derive schemas/indexes/partitions from concrete read/write/recovery queries.
3. Inspect exact ORM/driver/dialect source, installed exports, generated SQL,
   transaction behavior, result mapping, and close semantics. Types that resemble
   another dialect do not prove semantic parity.
4. Give migrations one owner. Prove generation, application, rollback/forward
   repair where supported, and fresh-database bootstrap separately.
5. Connect authoritative writes to projections through an explicit durable
   mechanism: transaction/outbox/change capture/event log/idempotent ingestion
   plus reconciliation.
6. Make pagination order deterministic and count strategy explicit.
7. Publish multi-file artifacts with a manifest or equivalent commit record only
   after all required files are durable and validated.
8. Make search/graph/analytics rebuilds versioned and cut over only after
   validation.
9. Keep ingestion bounded: streaming/batches/concurrency/retries/memory/open
   resources all need explicit limits.
10. Document non-obvious internal data invariants, including partition keys,
    dedupe rules, cursor encodings, merge semantics, projection identity, and
    benchmark/fixture assumptions.

## Failure and recovery review

Exercise or inspect:

- duplicate and reordered ingestion;
- late/corrected/deleted records;
- process crash before and after commit points;
- migration applied partly or to the wrong database;
- schema drift between producer, artifact, table, and query model;
- cursor instability under equal sort values;
- transaction assumption not supported by a driver/dialect;
- ClickHouse dedupe/merge lag or incorrect materialized-view assumption;
- bulk search partial rejection hidden as success;
- graph/search alias cutover before validation;
- disk/quota exhaustion while publishing artifacts;
- replay after a required downstream sink failed;
- database/client/resource leak on error or cancellation.

Required projections remain incomplete until their receipts/reconciliation
succeed. Do not print an error and then report the run as complete.

## Verification ladder

1. schema and migration tests;
2. generated SQL/query-plan/result mapping inspection;
3. representative read/write/transaction behavior;
4. duplicate/late/correction/deletion cases;
5. crash/failpoint recovery around commit points;
6. artifact checksum/schema/manifest inspection;
7. projection rebuild and cutover/reconciliation;
8. representative-volume performance and bounded-memory checks;
9. clean bootstrap/rebuild from authoritative source.

## Reference routing

- [storage-ownership.md](references/storage-ownership.md): workload taxonomy,
  authority, engine roles, and placement decisions.
- [postgres-drizzle.md](references/postgres-drizzle.md): PostgreSQL schemas,
  Drizzle, migrations, drivers, concurrency, and resource lifetime.
- [drizzle-architecture.md](references/drizzle-architecture.md): Drizzle AST,
  dialects, sessions, prepared queries, result mapping, Kit/ORM ownership, and
  new-dialect design.
- [clickhouse.md](references/clickhouse.md): MergeTree choices, analytics,
  ingestion, deduplication, mutations, views, backfills, and operations.
- [clickhouse-adapter.md](references/clickhouse-adapter.md): custom
  ClickHouse adapter design, native client ownership, capability evidence and
  publication checks.
- [projections.md](references/projections.md): Typesense, QLever/Blazegraph,
  search/graph versioning, synchronization, rebuild, and reconciliation.
- [artifacts.md](references/artifacts.md): raw evidence, JSONL, Parquet,
  manifests, staging, schema versions, bounded processing, and publication.
- [queries.md](references/queries.md): filters, sorts, cursors, counts,
  authorization-safe query construction, and stable pagination.
- [failures.md](references/failures.md): source-grounded failure signatures,
  failpoints, and recovery paths.

## Completion gate

Do not call data work complete until representative reads and writes succeed,
schema/migration state is known, required projections/artifacts can be validated
and reconciled, crash or partial-failure behavior is understood, resource
lifetime is proven, and performance claims use representative volume. A green
typecheck, migration generation, or process exit is not enough.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Procedures](../../handbook/procedures/README.md), [Service readiness](../../handbook/services/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
