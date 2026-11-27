# Atomicity, idempotency, outbox, and reconciliation

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [Write the invariant first](#write-the-invariant-first)
- [Local transaction patterns](#local-transaction-patterns)
- [Idempotent starts and effects](#idempotent-starts-and-effects)
- [Transactional outbox](#transactional-outbox)
- [Inbox and deduplication](#inbox-and-deduplication)
- [Sagas and compensation](#sagas-and-compensation)
- [Reconciliation](#reconciliation)
- [Crash matrix](#crash-matrix)
- [Failure signatures](#failure-signatures)
- [Verification](#verification)

## Write the invariant first

For every state transition, state what must commit together. Examples:

- execution record + first timeline event + ready queue item;
- winning wait transition + resume queue item + timeline event + execution status;
- lease claim + owner + expiry + attempt increment;
- domain mutation + outbox event;
- sink batch + checkpoint + manifest update;
- idempotency key + request fingerprint + accepted result identity.

If one database owns all rows, use one transaction and constraints. If systems
differ, state the gap and build idempotency plus reconciliation.

## Local transaction patterns

Prefer store operations shaped around invariants, not individual tables:

```ts
export interface WorkflowStore {
  readonly acceptStart: (input: AcceptStartInput) => Promise<AcceptedStart>
  readonly claimReady: (input: ClaimReadyInput) => Promise<readonly Lease[]>
  readonly completeWaitAndEnqueueResume: (
    input: CompleteWaitInput,
  ) => Promise<WaitCompletionResult>
  readonly commitStage: (input: CommitStageInput) => Promise<StageCommit>
}
```

An API exposing `updateWait`, `enqueue`, `appendTimeline`, and `updateExecution`
encourages partial commits. Keep low-level primitives internal or require an
explicit transaction handle.

Use database-safe uniqueness and sequence allocation:

```sql
create unique index workflow_idempotency_scope_key
  on workflow_executions (tenant_id, workflow_name, idempotency_key);

create unique index workflow_timeline_execution_sequence
  on workflow_timeline (execution_id, sequence);
```

Allocate sequence with a locked counter, sequence, atomic update-returning, or
constraint/retry. Never use `existing.length + 1` or an unlocked `max + 1`.

For queue claims use `FOR UPDATE SKIP LOCKED`, an atomic update-returning query,
or the engine's claim primitive. A read then conditional update races.

## Idempotent starts and effects

An idempotency record needs:

- tenant/scope and operation name;
- client key;
- canonical input fingerprint;
- accepted logical execution/effect ID;
- status/result reference;
- created/expiry timestamps;
- policy for retry after permanent failure.

```text
same key + same fingerprint -> return existing operation
same key + different fingerprint -> explicit conflict
expired key -> documented new-operation or conflict policy
```

Workflow-start idempotency and Activity idempotency are different. Give each
external effect its own operation key, preferably accepted by the provider. If a
provider times out ambiguously, query by that key before retrying.

## Transactional outbox

Use an outbox when a committed domain mutation must cause work/event publication:

```text
BEGIN
  update domain row
  insert outbox event with unique event_id and aggregate revision
COMMIT

publisher claims outbox row
  -> publishes idempotently
  -> records broker/engine acknowledgement
  -> marks published
```

Outbox requirements:

- stable event ID/type/schema version;
- aggregate/tenant identity and ordering key;
- serialized payload or reference;
- created/available timestamps;
- attempts, lease, last safe error;
- publication result/ack identity;
- retention and replay policy;
- atomic claim and multi-publisher safety.

Do not delete immediately if audit/replay needs the record. Do not mark published
before the receiving system durably accepts it. If acknowledgement is lost after
acceptance, retry with stable event ID and receiver dedupe.

Use Change Data Capture instead only when its operational/ordering/schema
contract is understood; “the database log has it” is not a consumer contract.

## Inbox and deduplication

Consumers can persist an inbox/deduplication record in the same transaction as
their local effect:

```text
BEGIN
  insert inbox(event_id) on conflict do nothing
  if inserted:
    apply local mutation
    append local outbox if needed
COMMIT
ack delivery
```

Scope uniqueness to the consumer/handler when the same event legitimately feeds
multiple consumers. Retain dedupe records at least as long as redelivery/replay
can occur, or use aggregate revision semantics that remain durable.

## Sagas and compensation

Cross-system work is a saga unless one transaction truly spans it. For each step:

| Step | Forward effect | Idempotency | Compensation | Irreversible consequence |
|---|---|---|---|---|
| Reserve credit | Provider reservation | reservation key | Release reservation | Expiry window |
| Create domain import | PostgreSQL insert | import ID | Mark abandoned/delete if safe | Audit record retained |
| Publish analytics | ClickHouse insert | event/batch key | Tombstone/rebuild projection | Eventual visibility |
| Notify customer | Email send | message key | Follow-up correction | Email cannot be unsent |

Compensation is a business operation, not a database rollback across time. It
can fail and needs its own retry, idempotency, and operator state. Sometimes the
correct recovery is forward repair rather than compensation.

## Reconciliation

For every cross-system edge define a query that finds disagreement:

- domain rows with missing workflow start;
- engine runs missing public projection;
- completed runs with required sink incomplete;
- timed-out waits with no resume item;
- expired leases still marked running;
- outbox pending beyond threshold;
- external operation pending locally but committed at provider;
- artifact manifest missing blob or hash mismatch.

A reconciler should:

1. scan a bounded range using an indexed predicate;
2. classify expected lag versus anomaly;
3. obtain a repair lease;
4. inspect both authorities;
5. apply idempotent repair;
6. append an audit/timeline event;
7. expose counts/age and terminal manual-review cases.

Do not mutate state invisibly. Reconciliation is part of the production path and
needs tests, rate limits, and operator controls.

## Crash matrix

Inject crashes:

- after idempotency lookup before insert;
- after execution insert before enqueue;
- after engine start before external ID/projection record;
- after external effect succeeds before local acknowledgement;
- after domain commit before outbox publisher runs;
- after broker publish before outbox mark;
- after wait wins before resume enqueue;
- after resume enqueue before projection update;
- after sink write before checkpoint/manifest;
- during cancellation and compensation.

For each, specify the retry/reconciler and prove convergence to one logical
outcome.

## Failure signatures

| Signature | Defect | Correction |
|---|---|---|
| Duplicate starts under concurrency | Read-before-insert idempotency | Unique constraint + transaction |
| Timeline sequence collision | Unlocked count/max | Atomic sequence allocation |
| Wait terminal but run never resumes | State update separated from enqueue | One transaction/reconciler |
| Provider charged, local state pending | Ambiguous timeout | Provider idempotency lookup |
| Domain row exists but no workflow | DB/start dual write | Outbox + dispatcher/reconciler |
| Event applied twice | No inbox/effect dedupe | Consumer-scoped unique event record |
| Compensation loops forever | No own lifecycle/budget | Durable compensation state/operator path |
| Repair changed data without audit | Reconciler treated as script | Timeline and repair identity |

## Verification

- Run high-concurrency identical starts and claims.
- Fault-inject every crash-matrix transition.
- Retry ambiguous provider outcomes with fake and real sandbox APIs.
- Redeliver events before/after acknowledgment and after dedupe retention edges.
- Run outbox publishers concurrently and kill after publish.
- Race signal/timeout/cancellation for one wait.
- Corrupt projections and run the real reconciler twice.
- Assert audit timeline, metrics, and no duplicate external consequence.

## Sources and freshness

- PostgreSQL transaction documentation: https://www.postgresql.org/docs/current/tutorial-transactions.html
  and locking clauses: https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
  (primary sources, checked 2026-07-17).
- Temporal Activity guidance: https://docs.temporal.io/develop/typescript/activities
  (primary source; external-effect idempotency remains application-owned).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/storage/outbox/postgres.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
