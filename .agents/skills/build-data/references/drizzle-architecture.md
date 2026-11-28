# Drizzle architecture and dialect ownership

## Contents

- Mental model
- Package and layer map
- Schema and columns
- SQL AST and dialect
- Session, driver, and prepared queries
- Query builders and results
- Migrations and Drizzle Kit
- Resource lifetime
- Version lines
- Conformance checklist
- Sources and freshness

## Mental model

Drizzle is not one generic database wrapper. It is a set of packages and dialect-specific layers that share SQL AST types, table/column metadata, query-building conventions, and result mapping. A familiar `db.select().from(...)` surface does not imply that every dialect supports the same SQL, transactions, constraints, migrations, relational queries, or driver behavior.

Use this ownership model:

```text
application schema
  -> dialect-specific table and column builders
  -> Drizzle table/column metadata
  -> query builder creates Drizzle SQL AST
  -> dialect compiles AST to SQL + typed parameters
  -> session prepares and executes through one driver
  -> result mapper applies column decoders and join nullability

schema source
  -> snapshot/serializer
  -> schema diff
  -> reviewed migration artifacts
  -> migrator applies artifacts and records history
```

Keep runtime ORM and migration-tool responsibilities distinct even when they share schema objects.

## Package and layer map

| Layer | Owns | Must not silently own |
|---|---|---|
| `drizzle-orm` core | SQL AST, expressions, aliases, tables/columns base types, selection mapping | Database-specific syntax or network transport |
| dialect module | quoting, placeholders, SQL clauses, feature grammar | Credentials, pooling, deployment policy |
| driver integration | native client adaptation and result shape | Schema diff policy |
| session | prepare/execute/iterate, parameter filling, result mapping, transaction surface | Pretending unsupported atomicity exists |
| schema module | table, column, index, constraint and relation declarations | Runtime connection construction |
| relational query layer | relation metadata and nested result assembly | Cross-dialect feature parity |
| Drizzle Kit | config, introspection, snapshot, diff, generation, push/studio workflows | Application request execution |
| migrator | ordered artifact application and history | Automatic rollback of non-transactional DDL |

Inspect imports from the installed version. Drizzle uses internal symbols and entity kinds to identify objects. Multiple incompatible `drizzle-orm` instances in a monorepo can break identity assumptions even when TypeScript types look structural. Centralize the version and, where needed, the re-export owner.

## Schema and columns

A dialect-specific column builder owns at least:

- compile-time data, driver-parameter, not-null, default, generated, enum, and table-name metadata;
- runtime column SQL type;
- application-to-driver encoder;
- driver-to-application decoder;
- default/generated/alias behavior;
- dialect-specific DDL metadata such as codecs, compression, statistics, or timezone.

The table builder must build columns against the final table identity and attach the symbols Drizzle query utilities inspect. Preserve a dialect identity rather than masquerading as PostgreSQL or MySQL to reuse types.

Schema-first does not mean “types are the database.” Verify generated DDL, runtime inserts, selected driver values, nullability, defaults, dates, big integers, decimals, arrays, maps, tuples, enums, and custom types.

## SQL AST and dialect

Prefer Drizzle's `SQL`, `SQL.Aliased`, column, table, subquery, view, placeholder, and parameter nodes over interpolated strings. The dialect decides:

- identifier escaping;
- parameter placeholder syntax and typed parameter transport;
- casing policy;
- selection aliases;
- `WITH`, `SELECT`, joins, filters, grouping, sets, order, limits, settings;
- insert/update/delete grammar;
- DDL grammar;
- unsupported features.

Raw SQL is an escape hatch, not a substitute for a grammar. Separate trusted static fragments from values and identifiers. For ClickHouse, a typed engine argument must distinguish identifiers, strings, numbers, and deliberately unsafe expressions so the renderer does not quote all four the same way.

Dialect compilation tests should assert SQL and ordered parameters. Include aliases, nested selections, placeholders, casing, reserved identifiers, Unicode, nulls, joins, CTEs, set operators, limit/offset, and dialect-only clauses.

## Session, driver, and prepared queries

The driver interface should be small enough to fake in unit tests. Define the actual client operations required: query, command, insert, result streaming, close, request settings, cancellation, and query identifiers.

The session owns:

1. dialect compilation;
2. named-placeholder filling;
3. application-value encoding and type binding;
4. native driver invocation;
5. row normalization;
6. selected-field decoder mapping;
7. joined-object nullification;
8. result-set disposal;
9. transaction behavior, including explicit rejection.

A prepared-query object should preserve SQL, parameter metadata, selected fields, join nullability, and custom result mapping. `prepare()` need not mean a server-side prepared statement: document whether preparation only caches a compiled query and fills parameters per execution.

If the native driver returns strings for 64-bit numbers, decimals, timestamps, arrays, or tuples, decode through the owning column. Do not globally coerce values based on JavaScript guesses.

## Query builders and results

Implement the smallest honest capability surface. A useful core may include:

- select from table, alias, subquery, view, and raw SQL;
- CTEs;
- inner/left/right/full/cross joins plus dialect strictness/global modifiers;
- `PREWHERE`, `WHERE`, `GROUP BY`, `WITH ROLLUP/CUBE/TOTALS`, `HAVING`, `QUALIFY`;
- order, limit, offset, limit-by, settings, final, sample;
- union/intersect/except where server support is verified;
- insert values and insert-select;
- explicit mutation builders;
- unsafe query/command for unsupported syntax.

Do not advertise Drizzle's relational query API unless schema relations, dialect SQL, and nested result assembly are implemented and tested. Flat SQL joins are not relational-query parity.

Result mapping must handle:

- explicit and inferred selections;
- aliases and SQL expressions;
- nested selection paths;
- nullable joined objects;
- column decoders;
- compact row formats whose positions must align with ordered selected fields;
- iterator early return and result-set close.

## Migrations and Drizzle Kit

Treat these as independent proof obligations:

| Capability | Proof |
|---|---|
| schema serialization | deterministic snapshot contains all physical metadata |
| diff | property tests plus golden transitions |
| risk classification | safe/caution/destructive/manual cases cannot be bypassed accidentally |
| generation | atomic files, journal, pending-write recovery, stable ordering |
| application | clean server and representative upgrade |
| history | hash mismatch, duplicate ID, failed attempt, retry behavior |
| introspection | round trip only if actually implemented |
| push/studio | absent unless separately supported |

ClickHouse cannot wrap a migration file in a cross-statement transaction. Execute statements in deterministic order, record query IDs and success/failure, make each statement retryable, and preserve a repair path when statement three fails after statements one and two committed.

Physical changes—engine, partition key, sorting key, primary key, sampling key—should be `manual`: create replacement, backfill, validate, and swap. A generator that emits plausible invalid `ALTER` syntax is more dangerous than one that stops.

## Resource lifetime

Return or retain the underlying client/pool handle. Construction and environment loading belong to the composition root, not import time. The runtime owner must be able to:

- close/drain in tests, CLI exit, worker shutdown, and server termination;
- cancel in-flight queries;
- close streaming result sets after completion, error, or early iterator return;
- configure logging without mutating global state during import;
- create isolated clients for integration tests.

## Version lines

Pin compatible versions of Drizzle ORM, Kit, native driver, TypeScript, and runtime. For every upgrade:

1. inspect changed public and internal imports;
2. run SQL golden tests;
3. run type-level API tests;
4. run native driver mapping tests;
5. generate migrations without accepting them;
6. compare snapshots and risk classifications;
7. apply clean and upgrade paths;
8. run live integration tests against supported server versions.

Avoid deep imports unless there is no public alternative. If unavoidable, isolate them behind one adapter module and lock a conformance test to the expected symbols.

## Conformance checklist

- [ ] Every public builder method either executes correctly or rejects explicitly.
- [ ] SQL and parameter order are deterministic.
- [ ] All value types round-trip through driver encoders/decoders.
- [ ] Prepared placeholders retain database type metadata.
- [ ] Join nullability maps nested objects correctly.
- [ ] Iterators release native results on early return.
- [ ] Transactions have real semantics or throw immediately.
- [ ] Schema snapshots cover all dialect DDL metadata.
- [ ] Diff tests cover every supported metadata transition.
- [ ] Manual/destructive migrations require explicit review.
- [ ] Clean install, upgrade, failed migration, and retry are tested.
- [ ] Underlying clients close and no global import side effects remain.

## Sources and freshness

Primary source: [Drizzle documentation](https://orm.drizzle.team/docs/overview)
for public schema, SQL, query, migration, relation and transaction concepts.
The module and conformance criteria in this guide describe how to evaluate an
adapter; they do not assert that a named custom adapter implements them.

Drizzle internals and deep imports are version-sensitive. Resolve the actual
package, declarations and source, then verify the adapter's compiler, native
transport and migration behavior at its supported dependency versions.
