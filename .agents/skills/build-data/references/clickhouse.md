# ClickHouse storage, ingestion, and operations

## Contents

- Mental model
- MergeTree-family selection
- Sorting, primary index, partitions, and granules
- Inserts, batching, and deduplication
- Corrections, mutations, and consistency
- Materialized views and projections
- TTL and storage lifecycle
- Replication and distribution
- Observability and diagnosis
- Schema evolution and verification
- Failure signatures
- Sources and freshness

## Mental model

ClickHouse is an analytical, column-oriented database. A MergeTree-family table stores inserted rows in immutable data parts. Each part is sorted by the table's `ORDER BY` expression, split into granules, compressed by column, and merged with other compatible parts in the background. An insert creates parts; it does not update a B-tree one row at a time.

Keep these terms distinct:

| Term | Operational meaning | Common mistake |
|---|---|---|
| `ORDER BY` | Physical sort key and main data-skipping design | Treating it as display order or uniqueness |
| `PRIMARY KEY` | Sparse index expression; defaults to the sorting key | Expecting an OLTP uniqueness constraint |
| `PARTITION BY` | Coarse lifecycle and pruning unit | Partitioning by a high-cardinality identifier |
| part | Immutable sorted unit written and merged | Assuming a row is updated in place |
| granule | Smallest block selected through the sparse index | Expecting point lookup precision |
| mark | Index/offset entry for a granule | Assuming one index entry per row |
| merge | Background consolidation and engine-specific reconciliation | Treating it as a synchronous commit step |
| mutation | Asynchronous rewrite of affected parts | Using it as an OLTP update loop |

The default index granularity is commonly 8,192 rows, but inspect the deployed server and table settings. Sparse indexing is efficient only when filters align with the leading sorting-key expressions.

## MergeTree-family selection

Choose the engine from the correction and aggregation model, not from the table name.

| Engine | Use when | Required correctness rule |
|---|---|---|
| `MergeTree` | Append-only facts or events | Duplicates remain unless ingestion prevents them |
| `ReplacingMergeTree(version[, deleted])` | New versions of a logical row arrive append-only | Query-time `FINAL`, `argMax`, or version-aware view is needed until merges reconcile |
| `SummingMergeTree(columns...)` | Numeric states can be safely summed by sorting key | Non-summed columns require deterministic semantics |
| `AggregatingMergeTree` | Store aggregate-function states | Insert and query with matching `*State`/`*Merge` functions |
| `CollapsingMergeTree(sign)` | Paired state/cancel rows are produced correctly | Unbalanced or reordered sign rows corrupt meaning |
| `VersionedCollapsingMergeTree(sign, version)` | Collapsing data can arrive out of order | Identity, sign, and version must be stable |
| replicated variants | Self-managed replicas use Keeper coordination | Replication is not sharding and does not remove retry design |
| `Distributed` | Route queries/inserts across shards | Local tables, sharding key, replica topology, and failure semantics remain explicit |

Do not select a specialized engine merely to obtain “upsert” behavior. Write the query that must be correct before merges, then test it with multiple versions in separate parts.

Example starting point for observations:

```sql
CREATE TABLE observations
(
  tenant_id UUID,
  observed_at DateTime64(3, 'UTC'),
  host String,
  kind LowCardinality(String),
  event_id UUID,
  payload String,
  ingested_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(observed_at)
ORDER BY (tenant_id, host, kind, observed_at, event_id);
```

This favors tenant/host/kind/time-range access. It is wrong for a workload whose dominant filters begin with another dimension. Validate with real predicates and `EXPLAIN indexes = 1`.

## Sorting, primary index, partitions, and granules

Design in this order:

1. List high-value query shapes with filter frequency, selectivity, time range, and latency target.
2. Put frequently filtered low-to-moderate-cardinality dimensions early in `ORDER BY` when they cluster useful ranges.
3. Put time after stable scoping dimensions for tenant/entity time-series queries.
4. Add a deterministic identity/tie-breaker where ordering, versioning, or pagination needs it.
5. Use a different `PRIMARY KEY` only when a shorter sparse index has measured value; it must remain a prefix-compatible expression for the engine/version.
6. Partition for bounded retention, replacement, or backfill—not as a substitute for the sorting key.
7. Add data-skipping indexes only after query plans prove the primary sort cannot prune enough.

Partition cautions:

- A partition key creates separate part sets. Inserts touching many partitions create many parts.
- High-cardinality partitions increase filesystem/metadata/merge overhead.
- Monthly partitions are a common event-data starting point, not a universal default.
- A logical row's versions should stay in the same partition if query-time `FINAL` may process partitions independently.
- Partition pruning helps only when predicates can be related to the partition expression.

Inspect pruning rather than inferring it:

```sql
EXPLAIN indexes = 1
SELECT count()
FROM observations
WHERE tenant_id = {tenant:UUID}
  AND host = {host:String}
  AND observed_at >= {from:DateTime64(3)}
  AND observed_at < {to:DateTime64(3)};
```

Check `system.parts` for active part count, rows, bytes, partition spread, and merge pressure. Check query logs for rows/bytes read versus returned. A query that returns ten rows after reading billions is a schema/query contract failure even when it is syntactically valid.

## Inserts, batching, and deduplication

Prefer client-side batches of at least 1,000 rows and commonly 10,000–100,000 rows for synchronous ingestion, subject to row width, memory, and latency. Tiny frequent inserts create small parts faster than background merges can consolidate them.

When client batching is not feasible, evaluate asynchronous inserts:

```sql
SET async_insert = 1;
SET wait_for_async_insert = 1;
```

`wait_for_async_insert = 1` acknowledges after a successful buffer flush and returns flush errors. Fire-and-forget acknowledgement can lose in-memory buffered data and conceal errors. ClickHouse 26.3 enables async inserts by default, so record the server version and explicit settings instead of assuming historical defaults.

Define retry identity separately from engine reconciliation:

- preserve a stable upstream event or batch identity;
- reuse the same deduplication token for the exact same retry payload;
- do not reuse a token for changed data;
- bound the deduplication window and document what happens after it;
- test retry after “server committed, client timed out”;
- verify dependent materialized-view behavior at the deployed version.

From ClickHouse 26.1, async-insert deduplication can extend consistently through dependent materialized views. Do not project that behavior onto older versions.

Avoid “exactly once” as an unqualified claim. State the durability stage: accepted request, durable source part, dependent views, replicated copies, downstream export, or externally visible effect.

## Corrections, mutations, and consistency

Choose a correction strategy:

| Strategy | Best fit | Visibility and cost |
|---|---|---|
| Append corrected fact and select latest | Event/version model | Immediate if query is version-aware; extra rows remain |
| `ReplacingMergeTree` | Versioned logical rows | Background merge is eventual; `FINAL`/`argMax` may be needed |
| lightweight `DELETE`/`UPDATE` where supported | Sparse corrections | Version and workload dependent; test actual semantics |
| `ALTER TABLE ... UPDATE/DELETE` mutation | Bounded bulk correction | Rewrites affected parts asynchronously; monitor completion |
| replacement table + backfill + swap | Sorting/partition/engine change | Operationally explicit; needs dual-read/write or cutover plan |

Never run a broad mutation without estimating affected parts and bytes. Use a required predicate in adapter builders. Decide whether the caller waits using settings such as `mutations_sync`, polls system tables, or returns an operation identifier.

ClickHouse consistency is not a single switch. Specify:

- whether an insert acknowledgement covers one replica or a quorum;
- which replica a subsequent read may reach;
- whether distributed inserts queue locally;
- whether materialized views and projections are current;
- whether version reconciliation needs `FINAL`;
- how replica lag, failed parts, and Keeper availability surface.

Expose a transaction facade only when the selected server and adapter support its stated atomicity and rollback behavior. Otherwise reject the operation explicitly and design idempotency or compensation for partial writes.

## Materialized views and projections

Distinguish the acceleration mechanisms:

| Mechanism | Ownership | Write/rebuild behavior |
|---|---|---|
| Incremental materialized view | Insert-triggered transformation into a target table | Processes newly inserted blocks; historical backfill is separate |
| Refreshable materialized view | Periodically recomputed query result | Suitable for bounded recomputation and joins whose sources change independently |
| Projection | Alternate stored layout attached to a table | Optimizer may select it; materialization and compatibility require proof |
| Data-skipping index | Per-granule metadata | Prunes granules but does not replace a correct sorting key |

An incremental materialized view observes inserted blocks, not a magical current-state table. If the transformation joins another table, later changes to that other table do not retroactively update existing target rows. Define target engine, deduplication, backfill, cutover, and repair.

Before adding a projection or view:

1. capture the slow query and plan;
2. prove sorting-key and predicate fixes are insufficient;
3. define storage and insert amplification;
4. materialize historical data explicitly;
5. verify the optimizer selects the projection or consumers query the target;
6. test schema changes and rebuild time;
7. retain a base-table correctness path.

## TTL and storage lifecycle

TTL can delete, move, or recompress data and can aggregate expired rows for supported table designs. Treat TTL changes as data migrations: an altered rule may make old rows immediately eligible.

Record:

- timestamp expression and timezone;
- retention by tenant/data class;
- delete versus move/recompress action;
- merge scheduling and lag expectations;
- legal hold and user-deletion exceptions;
- backup/recovery interaction;
- how to prove expired data is gone from replicas and projections.

Do not use `OPTIMIZE TABLE ... FINAL` as routine cleanup. It can create large write amplification and parts that normal merges will not combine efficiently. Reserve partition-scoped optimization for measured, bounded maintenance.

## Replication and distribution

Replication copies parts; sharding distributes rows. A `Distributed` table is usually a routing/query surface over local MergeTree-family tables.

Define:

- shard and replica counts plus failure domains;
- sharding expression and consequences of changing it;
- local and distributed table names;
- insert path (`Distributed` versus direct shard) and queue durability;
- quorum and sequential-read requirements;
- schema DDL coordination (`ON CLUSTER`) and partial-node recovery;
- Keeper path/macros for replicated engines;
- duplicate blocks and retry tokens;
- cross-shard aggregation, joins, and limits;
- failover and replica-lag observability.

ClickHouse Cloud uses shared-storage architecture rather than the same local-part replication model as self-managed clusters. Verify deployment type before prescribing ZooKeeper/Keeper paths or local-disk repair.

## Observability and diagnosis

Inspect, with version-appropriate columns:

- `system.parts`: active parts, partitions, rows, bytes, levels;
- `system.merges`: active merge/mutation work and progress;
- `system.mutations`: completion and failure reason;
- `system.replicas` and replication queues: lag and read-only state;
- `system.query_log`: duration, rows/bytes read, memory, exceptions, query IDs;
- `system.asynchronous_insert_log`: buffered insert/flush outcomes where enabled;
- `system.errors`: recurring server failures;
- materialized-view and projection sizes/usage through tables, parts, and query plans.

Propagate stable `query_id`/correlation IDs. Log normalized operation metadata, not credentials or raw sensitive SQL parameters. Capture rows, bytes, elapsed time, retries, endpoint, and settings relevant to semantics.

Failure signatures:

| Signature | Likely cause | Next evidence |
|---|---|---|
| `Too many parts` | tiny inserts or too many touched partitions | insert rate/batch size and `system.parts` |
| `FINAL` dominates CPU | versioned engine used without query-friendly reconciliation | versions per key, partitions, `argMax` alternative |
| query reads most rows | sort key does not align with predicate | `EXPLAIN indexes = 1`, query log |
| mutation never finishes | huge rewrite, blocked replica, or resource pressure | `system.mutations`, merges, replica queue |
| source count differs from view | backfill omitted, retry duplicated, transform filtered | source blocks, MV target, version-specific dedup |
| distributed read is stale | replica lag/read routing | distributed topology and replication queues |
| TTL deletes unexpected rows | expression/timezone/change applied to old data | DDL history and affected partitions |

## Schema evolution and verification

Classify changes:

- additive metadata-only or safe column addition;
- cautionary type/default/index/projection/TTL change;
- destructive drop or narrowing;
- physical layout change to engine, partition, sorting, primary, or sampling key;
- server-version-dependent operation.

Physical layout changes generally require a replacement table, controlled backfill, validation, and swap. A migration generator must emit “manual” rather than fabricating a safe `ALTER`.

Executable verification:

```bash
docker compose up -d clickhouse
deno test -A libs/clickhouse/tests
deno test -A libs/clickhouse/tests/integration
```

Then prove a clean lifecycle:

1. create schema from an empty server;
2. apply migrations twice and verify idempotent history/hash behavior;
3. insert representative batches, duplicates, late data, and corrected versions;
4. execute prepared selects, joins, aggregates, and streaming iteration;
5. execute bounded update/delete mutations and observe completion;
6. inspect generated SQL and `EXPLAIN indexes = 1`;
7. exercise view/projection backfill and TTL on disposable partitions;
8. interrupt migration/seed/insert and verify repair/resume;
9. close result sets and the underlying client;
10. repeat against the minimum and target ClickHouse versions.

## Sources and freshness

Primary source: [ClickHouse documentation](https://clickhouse.com/docs/) for
parts, indexes, ingestion, mutations, views, projections, TTL and replication.
The [official JavaScript client](https://clickhouse.com/docs/integrations/javascript)
defines its own transport and lifecycle contract. This guide does not establish
a custom adapter's package identity or feature support.

The detailed server examples include dated version references. Verify settings,
SQL grammar and feature availability against the deployed ClickHouse release,
then test the actual adapter and workload before making support claims.
