# Custom ClickHouse adapter design

Use this reference when a consumer is building or reviewing an adapter around
ClickHouse and Drizzle's SQL representation. It describes acceptance criteria;
it does not identify a published adapter package or assert Drizzle dialect parity.
The public `okikio/utils` workspace has no implied ClickHouse/Drizzle replacement.

## Start with the actual adapter

Resolve the consumer's package, source commit, public exports, native client,
Drizzle version and ClickHouse server. Inspect which builder methods actually
compile and execute. Keep unsupported operations explicit. An export, type or
successful SQL snapshot does not establish server behavior.

Use the upstream ClickHouse client directly when it already fits the task.
A custom adapter is useful only when its typed schema, result mapping or query
composition removes enough application duplication to justify maintaining a
second contract.

## Capability matrix

Record supported, unsupported and unverified status against the actual source.
Do not fill the status column from this guide.

| Surface | Evidence required before support is advertised |
| --- | --- |
| Native columns and table metadata | DDL rendering and value round trips |
| MergeTree engine arguments | Supported server grammar and identifier escaping |
| Settings, codecs, TTL, indexes and projections | Snapshot, diff and live DDL coverage |
| Select, joins, CTEs and set operations | SQL fixtures and live result mapping |
| ClickHouse-specific clauses | Clause order and a supported server version matrix |
| Prepared placeholders | Typed parameter binding and repeated execution |
| Streaming iteration | Backpressure, failure and early-return cleanup |
| Values inserts and insert-select | Correct native transport, types and defaults |
| Update/delete mutations | Required predicates and completion/error policy |
| Transactions | Real supported semantics or an immediate explicit rejection |
| Relational query APIs and `RETURNING` | Implemented behavior; names alone prove nothing |
| Migration generation and application | Schema transitions and interrupted-run recovery |
| Introspection, push and Studio | Explicit implemented integration |
| Seeds | Stable identity, retry policy and partial-write recovery |

## Keep ownership visible

A possible module split is:

```text
schema/       columns, table identity, engine arguments, DDL metadata
params.ts     bound values and ClickHouse type identity
dialect.ts    SQL representation to ClickHouse syntax
session.ts    native execution, cancellation and result lifetime
result.ts     ordered selection and decoder mapping
select.ts     supported read operations
insert.ts     values and insert-select
mutation.ts   guarded mutation operations
migrations/   snapshots, diffs, statement execution and history
```

Choose names that fit the repository. Keep the native client behind a small
structural interface so compiler tests need no server. Public types should not
expose Drizzle internals merely because the implementation uses them. Isolate any
unavoidable internal dependency and verify it at the pinned version.

## Schema and query contracts

Represent engine arguments according to what they mean. An identifier, a string
literal, a number and a trusted SQL expression need different rendering rules.
Keep raw-expression escape hatches explicit and restrict them to trusted code.

Table metadata may need engine, partition/sort/primary/sample keys, TTL, indexes,
projections, settings, database and cluster. Only expose fields the compiler and
migration system actually support. Test native types by behavior:

- signed and unsigned integer ranges, including values larger than safe JS integers;
- Decimal, floating-point values and booleans;
- String, FixedString, UUID and enum values;
- dates, timestamps, precision and timezones;
- Nullable, LowCardinality, arrays, maps, tuples and nested values;
- server-specific JSON, Variant or aggregate-state types when supported;
- materialized/default expressions, aliases, codecs and comments.

Compile clause order from the deployed server's grammar. Keep result format with
the session when its decoder relies on a particular format. Parameterize values
with ClickHouse type information; public input must not choose SQL identifiers
or raw expressions.

Test compilation independently of transport. Assert exact SQL, parameter names,
values and types. Then run the same operation against supported server versions.
A valid TypeScript builder can still produce invalid or semantically wrong SQL.

## Native client and result lifetime

The official JavaScript client documents `query`, `command`, `insert` and `exec`
for distinct operations, plus `close` for client lifetime. Query results support
whole-result `json`/`text` consumption or streaming. Node and web clients use
different stream implementations; inspect the chosen client's cancellation and
cleanup API instead of assuming every result exposes the same close method.

This example uses the official Node client API. It needs a reachable server and
is not a claim that a custom adapter has equivalent methods:

```ts
import { createClient } from '@clickhouse/client';

const client = createClient({ url: 'http://localhost:8123' });
try {
  const result = await client.query({
    query: 'SELECT toUInt32(number) AS value FROM numbers({count:UInt32})',
    query_params: { count: 3 },
    format: 'JSONEachRow',
  });
  const rows = await result.json<Array<{ value: number }>>();
  console.log(rows);
} finally {
  await client.close();
}
```

Whole-result materialization must fit the memory budget. A streaming wrapper
must release its reader or native stream after completion, failure and early
iterator return. Test this with the actual Node or web client.

For positional formats, keep selection order and decoder order identical.
Apply each column's decoder and define outer-join nullability. Return or retain
the native client's disposer so the host can drain and close it. A borrowed
client must not be closed by an individual query. Redact parameter logs and bound
payload previews.

## Writes, mutations and recovery

A values insert needs a deliberate contract for empty input, column names,
encoders, absent defaults, `undefined`, batching, settings, query IDs and aborts.
An insert-select is a SQL operation; it does not use a values serialization path.
Test retries against the selected server's deduplication settings and limits.

Require a predicate before a mutation can execute. Accept known target columns
and encode assignments through their types. Define whether the caller waits,
polls or receives an operation identity. Name and document update/delete methods
so callers understand the actual server operation.

A migration system must preserve every physical feature it claims to manage.
Classify additive, expensive, destructive and manually staged changes. Changes
to sorting or partition layout can need replacement, backfill and cutover;
generation must not imply safe in-place migration.

For generated files, design recovery for a crash between writing SQL, a snapshot
and a journal. A pending record plus atomic file replacement is one possible
protocol. Risk rejection must leave the previous committed snapshot intact.
For applied statements, track stable migration identity, content hash, attempts
and completion. If earlier statements remain applied after a later failure,
record that partial state and provide a repair path.

Seeds need their own identity and retry policy. A failed callback may already
have written data. Do not claim rollback or exactly-once external effects from
a seed journal or a query ID alone.

## Public exports and unsupported operations

Publish only implemented contracts through the actual export map. Separate
runtime querying, schema construction, migration generation and migration
application when consumers have different dependencies or permissions. Never
copy conceptual file paths from this guide into consumer imports.

Reject or omit capabilities that the selected adapter cannot guarantee:

- transactional sessions or rollback beyond the server/client contract;
- foreign-key or unique-constraint enforcement that is not implemented;
- PostgreSQL/MySQL conflict or returning clauses;
- relational-query methods that only exist as types or placeholders;
- automatic migration of physical layouts without a tested plan;
- Kit, Studio or introspection compatibility inferred from a Drizzle dependency.

## Verification and delivery

Unit checks cover rendering, injection rejection, parameter types, result
mapping, decoder behavior, early cleanup, empty/default insert cases, predicate
guards, deterministic snapshots, diff transitions, hash mismatches and recovery.

Use disposable live databases for DDL, inserts, queries, mutations and migration
upgrade paths. Exercise timestamps, decimals, large integers, nested values,
async inserts, deduplication, cancellation, interrupted work and client shutdown.
Run against the minimum and target versions the adapter actually claims.

Before a release, install the packed artifact into an independent consumer and
check types, exports, generated files and required runtimes. Report unsupported
and untested behavior with the release. A public package name is justified by
publication evidence, not by an architecture diagram or a local manifest.

## Sources and freshness

- [Official ClickHouse JavaScript client documentation](https://clickhouse.com/docs/integrations/javascript), consulted 2026-11-26 for the native operations and result/stream distinctions.
- [ClickHouse JavaScript client source](https://github.com/ClickHouse/clickhouse-js) for the exact installed client's interface and lifetime implementation.
- [Drizzle documentation](https://orm.drizzle.team/docs/overview) for its public query, schema and driver contracts.

The proposed module split and acceptance criteria are design guidance. No custom
adapter implementation or release is asserted here. Verify private/internal
Drizzle interfaces and server features against the actual pinned dependency set.
