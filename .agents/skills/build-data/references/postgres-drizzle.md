# PostgreSQL and Drizzle operational design

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


Use this reference for PostgreSQL schema, Drizzle ORM runtime, Drizzle Kit migrations, `postgres.js` client ownership, cross-schema relations, concurrency, and production verification. Treat Drizzle's schema types, query runtime, driver, and Kit artifacts as related but distinct systems.

## Contents

- Ownership layers
- PostgreSQL invariant model
- Tenant and cross-schema design
- Drizzle schema and import ownership
- Client, session, and lifetime
- Configuration model
- Migration workflow
- Transactions and concurrency
- Error policy
- Integration sequence
- Failure and repair
- Test matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Ownership layers

| Layer | Owns | Does not prove |
|---|---|---|
| PostgreSQL schema | tables, columns, constraints, indexes, policies | application query scoping or migration success |
| Drizzle schema metadata | typed table/column/relation declarations | installed database state |
| Drizzle query builder/dialect | SQL AST and compilation | driver connectivity or plan quality |
| Driver/session | execution, parameters, result mapping, transactions | schema migration history |
| `postgres.js` | pool, sockets, prepared behavior, shutdown | Drizzle relational semantics |
| Drizzle Kit | snapshot/diff/generate/migrate tooling | reviewed correctness or rollback |
| Composition root | config, construction, logging adapter, readiness, close/drain | business authorization |

Avoid treating `db` as a magic unit that owns everything. The underlying client/pool must remain reachable for lifecycle and driver-specific behavior.

## PostgreSQL invariant model

Put concurrency-sensitive invariants in PostgreSQL when it is the authority:

- primary keys and stable identity;
- `NOT NULL` and explicit defaults;
- unique constraints for business/idempotency keys;
- foreign keys and deletion/update actions;
- check constraints for bounded state machines and value rules;
- exact numeric precision/scale for money plus explicit currency;
- timestamp timezone and clock-owner policy;
- exclusion constraints where range overlap is the invariant;
- transactions and isolation for multi-row state transitions.

Application validation improves errors but does not replace database constraints under concurrency.

Choose schemas, precision, state checks, and tenant keys from the application's domain. No fixed schema names, money precision, or organization hierarchy apply to every database.

## Tenant and cross-schema design

For tenant-owned relationships, consider composite keys so the database can prevent cross-tenant references:

```ts
// Fragment: schema/table builders come from the selected Drizzle version.
const account = applicationSchema.table('account', {
  id: text().primaryKey(),
  organizationId: text('organization_id').notNull(),
}, (t) => [
  unique('account_org_id_uq').on(t.organizationId, t.id),
])

const entry = applicationSchema.table('entry', {
  organizationId: text('organization_id').notNull(),
  accountId: text('account_id').notNull(),
}, (t) => [
  foreignKey({
    columns: [t.organizationId, t.accountId],
    foreignColumns: [account.organizationId, account.id],
  }),
])
```

A referenced composite key needs a supported PostgreSQL uniqueness contract. Prefer an explicit table constraint when that is the intended invariant; inspect generated SQL and the selected server version. A supported non-partial unique index can also back a foreign key, so an index is not categorically invalid. See [PostgreSQL 18 CREATE TABLE](https://www.postgresql.org/docs/18/sql-createtable.html) for the referenced-key requirements. Avoid duplicate constraints/indexes on the same key.

Database-level tenant integrity does not replace authorization. A foreign key
can prove that a referenced row belongs to the stored organization while saying
nothing about whether this caller may act for that organization. Bind the
verified caller's allowed organization/resource in the actual read/write path;
do not accept an organization ID merely because a matching database row exists.

## Drizzle schema and import ownership

In monorepos, inspect actual dependency resolution and class/type identity before centralizing Drizzle imports. Duplicate incompatible copies can break assignability and runtime identity. Choose the consumer's dependency owner; an application barrel is a local dependency decision, not a required public utility export.

Separate exports:

```text
@app/db              runtime factories
@app/db/schema       schema aggregate
@app/db/schema/auth  bounded schema surface
@app/db/drizzle      controlled ORM/core symbols if needed
@app/db/types        public runtime types
```

Do not create broad re-exports that accidentally make internal tables or unstable ORM internals a public package contract. Keep schema import paths used by Drizzle Kit stable and inspect the generated snapshot after moves.

Drizzle relations are application query metadata, not PostgreSQL foreign keys. Define both when both behaviors are needed and verify generated SQL for actual constraints.

## Client, session, and lifetime

The composition root should own the client and Drizzle wrapper:

```ts
interface DatabaseResource<DB, Client> {
  db: DB
  client: Client
  close: (options?: { timeoutSeconds?: number }) => Promise<void>
}

function createDatabaseResource(config: DatabaseConfig): DatabaseResource<Database, Sql> {
  const client = postgres(config.url, {
    max: config.maxConnections,
    prepare: config.prepare,
    connect_timeout: config.connectTimeoutSeconds,
    idle_timeout: config.idleTimeoutSeconds,
  })
  const db = drizzle({ client, schema, logger: config.logger })
  return { db, client, close: () => client.end({ timeout: 5 }) }
}
```

Use the installed driver's exact option and close signatures. This example is an ownership shape, not a copy-paste API guarantee.

Decide:

- pool maximum relative to replicas/workers and database limit;
- prepared statements behind transaction/session poolers;
- connect, idle, statement, and pool wait timeouts;
- TLS and certificate verification;
- application name and server settings;
- retry owner;
- health/readiness query;
- shutdown order and in-flight drain;
- query logging/redaction owned by the application's observability layer.

If a factory constructs a native client and returns only an ORM facade, check how the host reaches its close operation. Return or retain an explicit disposer and make shutdown ownership clear. Configure logging at host startup, not during import or pool construction. Preserve the consumer's selected observability library.

## Configuration model

Validate lazily at the composition scope:

```ts
interface DatabaseConfig {
  url: string
  maxConnections: number
  prepare: boolean
  connectTimeoutSeconds: number
  idleTimeoutSeconds: number
  statementTimeoutMs: number
  ssl: 'disable' | 'require' | 'verify-full'
  logQueries: boolean
}
```

Importing schema or types should not require environment access, open a connection, or configure global logging. Tests and CLIs should be able to inject an explicit URL/client. Redact credentials from errors and diagnostic configuration.

Derive pool limits and prepared-statement policy from the actual database/proxy/replica topology. An example's connection count or prepare setting is not a portable default.

## Migration workflow

This configuration fragment illustrates ownership; resolve paths, environment, and keys from the selected repository and Drizzle Kit version:

```ts
defineConfig({
  out: './drizzle',
  schema: './schemas',
  dialect: 'postgresql',
  dbCredentials: { url: DATABASE_URL },
})
```

At the consuming version, confirm config keys and CLI behavior. The operational sequence is:

1. Change executable TypeScript schema.
2. Run pinned Drizzle Kit generation from the owning package/directory.
3. Inspect SQL, snapshot, and journal changes.
4. Review constraints, defaults, casts, backfills, locks, and destructive operations.
5. Apply to an empty disposable database.
6. Upgrade representative previous schemas/data.
7. Run application reads/writes and invariant tests.
8. Measure lock/duration implications for production-sized data.
9. Define rollback or forward-repair procedure.
10. Commit schema and generated artifacts together.

Use generated SQL migrations as reviewed history. `push` can be useful for disposable exploration but bypasses the same reviewed artifact sequence; do not use it as durable production history by accident.

If the task authorizes rebuilding a baseline, regenerate SQL, snapshots and the journal as one coherent history. Preserve the recoverable previous state and verify the result on a disposable database. Never repair migration state by guessing which generated files are disposable.

## Transactions and concurrency

Turn a claimed invariant into a competing-write expectation. For example, if a
unique logical key permits one active owner, run two transactions for that key:
one acceptance and one defined conflict, or a documented serialized result,
with no duplicate durable owner. Test the selected invariant, isolation and
retry path on a disposable database upgraded from empty and prior schemas.
Mentioning concurrency or locks alone does not specify the expected outcome.

Define transactions around authoritative state transitions, not repository method count. Test the actual driver/dialect transaction API and isolation.

Patterns requiring special attention:

- idempotent create: unique key plus insert/conflict or transaction, not read-then-insert;
- monotonic per-parent sequence: database-owned sequence/counter/locked row, not `existing.length + 1`;
- queue claim: one atomic claim such as `FOR UPDATE SKIP LOCKED` or conditional update with proven selection behavior;
- balance/ledger changes: immutable entries and transactionally maintained projections where applicable;
- outbox: business state and change record in the same transaction;
- serialization/deadlock: bounded retry of the entire safe transaction with jitter and observability;
- savepoints/nested transactions: verify installed behavior rather than assuming.

Drizzle transaction types do not establish that a custom adapter or serverless driver supports every PostgreSQL behavior.

## Error policy

Classify at the database handoff:

| Category | Example response policy |
|---|---|
| unique/check/foreign-key | stable conflict/unprocessable domain error after identifying owned constraint |
| serialization/deadlock | retry whole transaction if safe and within budget |
| statement/lock timeout | stable unavailable/timeout; preserve retry metadata internally |
| connection/pool unavailable | readiness/availability failure, not invalid client input |
| migration mismatch | fail startup or capability readiness explicitly |
| unexpected driver error | generic client problem; redacted structured cause internally |

Do not send raw SQL, connection URLs, table layout, or driver messages to clients. Avoid parsing human messages when stable error codes/constraint names are available.

## Integration sequence

```text
composition root parses config
  -> constructs owned postgres.js client
  -> wraps it in Drizzle with one schema/version
  -> verifies readiness/migration compatibility
  -> injects DB capability into services/workers
  -> runs parameterized transactions/queries
  -> maps stable database errors
  -> stops intake, drains work, closes client
```

Schema release:

```text
schema edit -> generate -> review SQL/snapshot -> empty install -> upgrade fixture
  -> application integration -> production rollout/observe -> forward repair if needed
```

## Failure and repair

| Signature | Defect | Repair evidence |
|---|---|---|
| Migration generates but clean install fails | generation treated as application proof | empty DB apply and schema introspection |
| Composite FK fails despite unique index | index/constraint semantics confused | named table unique constraint and applied FK |
| Second migration recreates same uniqueness | duplicate declaration | inspect schema and generated diff |
| Two packages produce incompatible Drizzle types | duplicate version/runtime identity | lockfile resolution and central version owner |
| Process hangs after tests | client close inaccessible | explicit resource close and zero open-handle test |
| Importing schema requires env | config at module scope | import-safe schema and lazy config |
| Idempotency race creates duplicates/errors | read-before-insert | database constraint and atomic insert policy |
| Queue work executes twice | claim split or lease semantics incomplete | concurrent workers and atomic claim oracle |
| Raw constraint message reaches caller | provider detail leakage | stable mapping plus redacted cause |

## Test matrix

Test:

- schema import without environment/network permissions;
- config validation and credential redaction;
- connection/readiness and explicit close/drain;
- empty migration install and representative upgrades;
- generated schema matches introspected constraints/indexes;
- cross-schema and composite foreign keys;
- unique constraint versus unique-index intended ownership;
- check constraints with invalid direct SQL writes;
- transaction commit, rollback, nested/savepoint behavior if used;
- uniqueness/idempotency races with multiple connections;
- deadlock and serialization retry exhaustion;
- queue claim/lease concurrency if PostgreSQL owns work;
- tenant-isolated relationships and queries;
- pool exhaustion, database restart, statement/lock timeout;
- graceful shutdown with in-flight transactions;
- ORM query/result mapping, decimals, timestamps, arrays, JSON, and nulls;
- generated package/monorepo import identity if re-exporting Drizzle.

## Executable verification

Discover and run the owning repository's pinned generation and migration tasks. Confirm their working directory, configuration, and database target. Use the consumer's task runner and actual migration owner.

In a disposable database, apply committed migrations, inspect `pg_constraint`, `pg_indexes`, schemas, and migration history, then run real service queries. Upgrade a copied prior schema. Run two or more concurrent clients against uniqueness and claim paths. Stop the process during in-flight work and assert the pool closes or the documented timeout expires.

## Deliberate exclusions

- Do not force Drizzle when the consumer has another selected data layer.
- Do not force LogTape, Zod, or Effect; integrate with selected owners.
- Do not import environment or connect while importing schema/types.
- Do not equate Drizzle relations with foreign keys.
- Do not equate a unique index with every semantic of a table unique constraint.
- Do not treat generated SQL as reviewed/applied/upgrade-safe.
- Do not claim custom Drizzle-like adapters support PostgreSQL transactions or Kit.
- Do not use `push` as reviewed production migration history without explicit policy.
- Do not hide the driver/pool close handle.

## Sources and freshness

Primary references: [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [Drizzle migrations](https://orm.drizzle.team/docs/migrations) and [Drizzle transactions](https://orm.drizzle.team/docs/transactions). Verify the installed ORM, Kit, driver and server, then inspect generated SQL and real database behavior. The public utility source does not prescribe an application schema, generic database factory, migration folder or task runner.
