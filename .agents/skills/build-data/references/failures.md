# Data-system failure diagnosis and recovery

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


Use this reference when a data system is wrong, stale, incomplete, slow, leaking scope, or unrecoverable. Diagnose the violated owner/commit contract before adding retries or another abstraction. A green typecheck or completed process is not evidence that data committed correctly.

## Contents

- Triage protocol
- Authority and consistency failures
- Artifact and pipeline failures
- PostgreSQL and Drizzle failures
- Search, graph, and ClickHouse failures
- Query failures
- Resource and operational failures
- Recovery decision model
- Failure-injection matrix
- Verification and incident evidence
- Deliberate exclusions
- Sources and freshness

## Triage protocol

Preserve evidence before retrying or repairing:

1. Stop destructive cleanup, compaction, retention, or automated retry if it can erase the failure.
2. Record incident time, affected tenant/range/run/change IDs, deployed versions, resolved config digest, and topology.
3. Identify the authoritative source for each disputed fact.
4. Capture manifests, checkpoints, migration history, queue/outbox state, projection receipts, relevant system tables, and redacted diagnostics.
5. Determine the last proven committed checkpoint for every required sink.
6. Classify impact: missing, duplicate, stale, extra, corrupted, unauthorized, unavailable, or slow.
7. Reproduce on a copy/fixture where possible.
8. Choose forward repair, replay, rebuild, rollback, or restore based on authority and identity evidence.
9. Reconcile after repair; do not infer success from command exit alone.

Ask three questions first:

```text
What is authoritative?
What is the last committed identity/version?
Can reapplication be proven safe?
```

If any answer is unknown, a blind retry can create more damage.

## Authority and consistency failures

| Signature | Likely cause | Inspect | Safe next step |
|---|---|---|---|
| Two stores disagree after “successful” request | direct dual write or premature success | authority transaction, outbox/change ID, sink receipts | replay durable change or targeted repair; add handoff |
| Both stores contain independent edits | dual authority | writers, timestamps/versions, conflict policy | stop one writer; resolve facts under explicit policy |
| Search grants access after membership revoke | projection used for authorization | current membership, server base filter, indexed tenant data | block through authority; delete/repair projection |
| Rebuild resurrects deleted data | source snapshot lacks tombstones/deletion record | snapshot identity, delete log, artifact retention | rebuild from a complete source snapshot including deletes |
| Projection checkpoint is ahead of data | checkpoint committed before sink | receipt/change IDs | rewind to last proven change and replay idempotently |
| Projection data is ahead of checkpoint | crash after sink write | target version/change IDs | replay and detect already-applied change |

Do not “pick the newest timestamp” unless clock ownership, ordering, and conflict semantics make that authoritative.

## Artifact and pipeline failures

| Signature | Likely cause | Recovery |
|---|---|---|
| JSONL parser fails on final line | process died mid-write | discard/truncate uncommitted segment; resume committed checkpoint |
| JSONL middle line corrupt | non-atomic append or external mutation | quarantine segment; rebuild from raw authority |
| Parquet cannot open/no footer | partial file published | remove pointer/reference; rebuild temporary artifact |
| Parquet schema varies by batch | inference from observed records | declare schema and rewrite compatible artifact |
| Memory rises with input size | materialized `list(records)` or global profiling set | bounded writer/profile sketches; large-input oracle |
| Run reports complete with errors | broad catches/best-effort stages | inspect required stage/sink states; mark incomplete |
| Daily staging file contains repeated retries | date-only append target | split by run identity; dedupe using record/source version |
| Resume skips records | checkpoint represents attempted input | rewind to committed output identity |
| Resume duplicates side effects | sink lacks idempotency/version | repair duplicates and add deterministic change identity |

A completion message is false if a required capture, transformation, staging or publication stage failed and its exception was ignored. Also inspect profiling and output writers for collections that retain every input record. An iterative outer loop does not make those stages bounded.

## PostgreSQL and Drizzle failures

| Signature | Likely cause | Evidence and repair |
|---|---|---|
| Migration generated but fails empty install | SQL never applied; artifact drift | apply full committed history to disposable DB; repair migration |
| Upgrade fails while empty install passes | data/backfill/lock assumption | restore representative prior snapshot; forward repair |
| Composite foreign key creation fails | referenced key is not an appropriate unique constraint | inspect `pg_constraint`; define named `UNIQUE` key |
| Follow-up migration recreates index/constraint | duplicate schema declarations or snapshot drift | compare Drizzle schema, snapshot, journal, introspection |
| Duplicate idempotent rows under concurrency | read-then-insert | unique constraint plus atomic insert/conflict policy |
| Timeline/sequence collisions | `existing.length + 1` | database-owned atomic allocation/lock/constraint |
| Queue item claimed twice | select-then-update claim window | atomic claim/conditional update test or `SKIP LOCKED` design |
| Process/test hangs | pool handle hidden/not closed | expose client close; drain and open-handle test |
| Raw SQL error reaches API | driver error leaked | stable constraint/code mapping and redacted diagnostics |
| Imports fail without env | module-scope config/client construction | lazy factory and import-safe schema |

Before retrying deadlocks or serialization failures, ensure the whole transaction is safe to replay and bound attempts. Never retry uniqueness/check violations as transient errors.

## Search, graph, and ClickHouse failures

| Signature | Likely cause | Evidence and repair |
|---|---|---|
| Search count is low after successful bulk call | per-document failures ignored | parse batch response, list rejected IDs, replay targeted records |
| Old field behavior after schema change | in-place collection incompatible or stale alias | inspect active collection/alias and schema version; rebuild/cut over |
| Deleted document remains | upsert-only projection | tombstone/delete feed or authoritative identity reconciliation |
| RDF query returns old and new values | append added correction but did not remove old triple | rebuild/replace graph or supported delete/update |
| Graph queries hit unexpected engine | docs/deployment drift | process/container/config/endpoint evidence |
| QLever index start fails | incomplete inputs/index artifacts or config mismatch | validate input manifest; rebuild named index, never route partial |
| ClickHouse duplicates appear | MergeTree semantics or retry dedupe misunderstood | inspect table engine/order/version, parts/merges; reconcile versions |
| ClickHouse mutation appears stuck | asynchronous mutation/part rewrite | inspect `system.mutations`, part errors, resource pressure |
| Analytics misses late records | window/backfill/checkpoint policy incomplete | replay affected range and define late-arrival reconciliation |

Do not apply PostgreSQL update/uniqueness expectations to ClickHouse. Do not infer graph update capability from SPARQL query support.

## Query failures

| Signature | Likely cause | Inspect/correct |
|---|---|---|
| Cross-tenant results | missing server base predicate or graph scope escape | generated SQL/SPARQL and adversarial two-tenant fixture |
| Cursor repeats/skips | unstable order, wrong direction, mutable tiebreaker | compound cursor predicate and concurrent traversal |
| Cursor valid on unrelated filter | token lacks resource/filter/version binding | signed context digest and rejection |
| Exact total differs from rows | count/page predicates or snapshot differ | compile same authority/user filters and name consistency |
| Slow query after typed refactor | cast/expression prevents index pruning | real plan with representative values/data |
| SPARQL syntax/injection defect | raw expression/value concatenation | inspected term serializer, malicious literal tests |
| `IN []` returns surprising result | empty-list semantics undefined | reject or compile explicit true/false policy |
| New database field becomes public | wildcard not registry-bound | explicit public selection registry |

Capture generated query and bound parameters safely. Never paste secrets or personal literal values into incident reports.

## Resource and operational failures

| Signature | Likely cause | Correction |
|---|---|---|
| Pool exhaustion | per-request construction, leaked transactions, wrong replica budget | acquisition metrics, stack/call-site audit, composition-root resource |
| Shutdown hangs | intake continues or driver close unreachable | stop intake, cancel/drain bounded work, close handle |
| Retry storm | unbounded retry without jitter/budget | central retry policy, circuit/load shedding, durable retry state |
| Disk full leaves “complete” artifact | publication not atomic/manifests premature | keep incomplete manifest, reclaim safe temp files, rebuild |
| Backfill overloads production | no rate/resource isolation | bounded batches, throttling, replica/maintenance plan |
| Health passes while migrations missing | health only checks process/socket | readiness includes schema/capability compatibility |

## Recovery decision model

Choose the smallest repair with complete evidence:

| Condition | Prefer |
|---|---|
| Immutable authoritative input and deterministic projector | replay affected identities/range |
| Projection broadly corrupt or schema incompatible | versioned full rebuild and cutover |
| Authority data corrupted but valid backup/change log exists | restore/PITR plus downstream catch-up |
| Migration partially applied | forward repair using introspected state; rollback only if explicitly safe |
| Sink ahead of checkpoint | idempotent replay and checkpoint reconciliation |
| Checkpoint ahead of sink | rewind to proven receipt and replay |
| Authority unclear or independent writes conflict | stop mutation and require ownership decision |

Repair records should include incident, operator, input validation point, tool/version, commands, before/after counts/hashes, rejects, and remaining uncertainty.

## Failure-injection matrix

Inject process loss:

- before and after authority commit;
- after outbox/change insert;
- after sink write but before checkpoint;
- midway through artifact segment and before final manifest;
- during migration DDL/backfill;
- after queue lease and before acknowledgement;
- after wait/signal state change and before resume enqueue;
- during projection alias cutover;
- during shutdown with in-flight transaction/batch.

Inject dependency failures:

- timeout, connection reset, authentication failure, pool exhaustion;
- partial bulk rejection;
- malformed/corrupt input;
- disk full/permission denied;
- duplicate/out-of-order/late delivery;
- schema/config/version mismatch;
- stale authorization and privacy deletion.

Every test needs a post-restart oracle: authoritative identities, sink receipts, checkpoints, manifests, projection state, and operator-visible error.

## Verification and incident evidence

Verification must include the system handoff that failed:

- migration history plus PostgreSQL introspection and representative queries;
- artifact parser/full scan, schema, checksum, and manifest;
- search per-item receipts and identity reconciliation;
- graph input manifest, index version, representative SPARQL queries;
- ClickHouse system tables, convergence checks, and affected-range queries;
- complete cursor traversal under concurrent changes;
- restart/replay outcome and no skipped committed identities;
- privacy/tenant negative tests;
- process exit/open-handle check.

Keep failed/blocked/passed distinct. If a registry, engine, credential, or realistic data volume is unavailable, record the blocked proof and do not convert structural inspection into a passing operational result.

## Deliberate exclusions

- Do not immediately retry before preserving last committed evidence.
- Do not repair projections by editing them manually without recording authoritative reconciliation.
- Do not force a specific database, logger, validator, or Effect runtime.
- Do not label swallowed optional errors harmless without an explicit required/optional contract.
- Do not use counts alone when identity/content/version can differ.
- Do not claim recovery from a unit test that never restarts the process or real dependency.
- Do not treat a type-level ORM test as migration, concurrency, or lifecycle evidence.
- Do not expose raw queries, credentials, or personal data in incident output.

## Sources and freshness

Use the selected engine's official documentation and executable consumer paths to verify a diagnosis. Public utility contracts include [`query/postgres`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/query/postgres.ts), [`storage`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/storage/mod.ts) and [`workflow`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts). Compilation, persistence and workflow execution have separate owners. The failure signatures are review criteria, not claims that these sources contain a defect.
