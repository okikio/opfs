# Durability model and engine selection

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [Durability is a set of claims](#durability-is-a-set-of-claims)
- [Authority](#authority)
- [Identity model](#identity-model)
- [Engine selection](#engine-selection)
- [Delivery and effect semantics](#delivery-and-effect-semantics)
- [Determinism and evolution](#determinism-and-evolution)
- [Completion contract](#completion-contract)
- [Deliberate exclusions](#deliberate-exclusions)
- [Verification](#verification)

## Durability is a set of claims

Classify each capability separately:

| Claim | Required proof |
|---|---|
| Start survives API loss | Durable intent exists before acknowledgement |
| Work survives worker loss | Another worker can reclaim/replay it |
| Timer survives process loss | Deadline is persisted or engine-owned |
| External effect is safe to retry | Idempotency/deduplication at effect retry owner |
| Wait survives restart | Wait identity, payload contract, and wake path persisted |
| Cancellation is durable | Request/state is persisted and observed after restart |
| Progress is inspectable | Authoritative history/timeline plus projection |
| Resume is correct | Checkpoint represents committed output and validates provenance |
| Upgrade is replay-safe | Old histories/records replay under deployment policy |
| Operators can recover | Inspect, retry, replay, cancel, repair, reconcile paths exist |

An in-memory retry, promise chain, fiber, queue, or cron callback can be reliable
within one process and still not be durable.

## Authority

Choose the authoritative source for each fact:

- workflow lifecycle/history;
- domain state;
- external effect result;
- timer/wait status;
- queue readiness/lease;
- operator timeline;
- public status projection;
- output artifacts.

One system can own several facts, but do not call two independently mutable
stores authoritative for the same fact. If Temporal history owns workflow
progress while PostgreSQL serves a product projection, define how the projection
is rebuilt and how disagreement is reconciled. If PostgreSQL owns a custom
control plane while `@effect/workflow` owns execution state, define the exact
commit gaps and recovery direction.

An authority map should look like:

| Fact | Authority | Projection/cache | Rebuild/reconcile |
|---|---|---|---|
| Run lifecycle | Temporal history | PostgreSQL `workflow_runs` | Scan/search attributes or event consumer |
| Import records | PostgreSQL domain tables | ClickHouse analytics | Outbox/replay by domain revision |
| Ready claim | PostgreSQL queue row | Worker memory | Lease expiry |
| Artifact bytes | Object store | Manifest row | Hash/list/reconcile |

## Identity model

Define stable identifiers for:

- workflow type and semantic version;
- logical workflow ID;
- run/history ID;
- execution attempt;
- trigger/event;
- idempotency scope/key;
- activity/effect and activity attempt;
- queue item/lease;
- timer/wait/signal/update;
- schedule occurrence;
- checkpoint/stage/input partition;
- artifact and sink commit;
- replay/repair operation.

Reuse the logical ID across retries/continuations where it represents the same
business operation. Generate distinct attempt/run IDs for observability. Store
idempotency scope and a request fingerprint so reuse of a key for different
input is a conflict rather than accidental success.

## Engine selection

| Option | Prefer when | You must add/prove |
|---|---|---|
| Synchronous request | Short work can complete within request and retry is client-owned | Cancellation, transaction, timeout |
| Scheduled command | Periodic stateless/reconcilable task | Overlap, missed runs, lock, audit |
| PostgreSQL job table | Moderate jobs, existing Postgres operations, simple timers | Atomic claim, leases, retry, poison, UI/API |
| Broker queue | High delivery throughput and consumer decoupling | Durable state, dedupe, visibility/lease, replay |
| Custom Postgres control plane + Effect | Product-specific admission/history with typed Effect execution | Engine persistence, atomic gaps, workers, recovery, operator surface |
| `@effect/workflow` | Effect integration is valuable and exact alpha capabilities are verified | Version pin, production adapter proof, recovery/replay tests |
| Temporal | Long-lived replay, durable timers/messages, mature worker/operator model | Temporal service/Cloud, deterministic code, deployment/version policy |
| Data orchestrator | Data assets, partitions, lineage, scheduled/backfill semantics dominate | Domain workflow/message needs may not fit |

Selection questions:

1. Longest runtime/wait?
2. Durable timers, signals, queries, updates, child workflows, or compensation?
3. Active steps per second and payload size?
4. Ordering/fairness/admission needs?
5. Which persistence/operations expertise already exists?
6. Can the runtime execute on the target host?
7. How are in-flight versions deployed and replayed?
8. What operator tooling is required on day one?
9. Is self-hosting a requirement or burden?
10. Can simpler queue/table semantics meet recovery needs?

## Delivery and effect semantics

Assume retryable work and messages are at least once unless the selected engine
and effect retry owner prove stronger. “Exactly once workflow execution” does not
make an external HTTP call exactly once.

For every external effect record:

- stable operation key accepted by the provider or enforced locally;
- input fingerprint;
- pending intent before the call where needed;
- provider request/result identifier;
- ambiguous timeout handling;
- duplicate response handling;
- reconciliation query;
- compensation policy if reversible;
- redacted evidence for an operator.

Do not retry a payment/email/provisioning call after an ambiguous timeout without
an idempotency or lookup contract.

## Determinism and evolution

Replayable orchestration cannot branch on unrecorded mutable facts. Isolate:

- network/database/filesystem I/O;
- nondeterministic randomness/time not supplied by engine APIs;
- environment/config read after a run starts;
- unordered iteration whose order affects commands;
- runtime-specific APIs unavailable in the workflow sandbox;
- package functions with hidden nondeterminism.

Capture policy/config values needed by a run in versioned input or query them
through recorded activities, depending on desired semantics.

Evolution plan must cover:

- compatible input/event decoding;
- workflow code changes for open histories;
- worker/build routing or explicit patch/version APIs;
- activity compatibility and timeout/retry changes;
- renamed workflow/activity/task queue identifiers;
- Continue-As-New or history compaction;
- schema migrations for custom control planes;
- rollback with newer persisted records.

## Completion contract

Define run status independently from stage and sink status. A run is complete
only when every required outcome is committed and observable.

```text
accepted -> queued -> leased/running -> waiting/retrying ->
completed | failed | cancelled | timed_out | terminated | requires_attention
```

Do not flatten cancellation requested, cancellation observed, cleanup running,
and cancelled terminal into one boolean. Optional sink failure can yield
completed-with-warning only if the public contract names that state.

## Deliberate exclusions

- Do not add a durable engine for a pure local computation.
- Do not put large payloads/artifacts in workflow history; store immutable blobs
  and pass references with hashes.
- Do not call an adapter durable until the production persistence operations are
  implemented and restarted.
- Do not use Redis or an in-memory queue as the sole authority merely because it
  is fast.
- Do not claim exactly-once external effects without effect retry evidence.
- Do not build custom operator/control-plane features already required from a
  selected platform without first identifying the product-specific gap.

## Verification

- Kill API immediately after acceptance.
- Kill worker before claim, after claim, during effect, after effect, before ack,
  and during checkpoint.
- Duplicate every trigger, message, queue delivery, and provider response.
- Advance timers across restart and clock skew.
- Replay representative old histories/records on new code.
- Start concurrent equivalent runs and enforce admission atomically.
- Corrupt/miss projections and execute reconciliation.
- Exercise operator inspect, cancel, retry, replay, resume, and repair.
- Validate results/artifacts, not only final status.

## Sources and freshness

- Temporal TypeScript documentation: https://docs.temporal.io/develop/typescript
  (primary source, checked 2026-07-17).
- Effect official site and monorepo: https://effect.website/ and
  https://github.com/Effect-TS/effect (primary sources; verify the selected package and adapter versions).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
