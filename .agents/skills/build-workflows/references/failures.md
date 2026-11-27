# Workflow and pipeline failure diagnosis

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


Use this reference when durable work is stuck, duplicated, lost, falsely successful, unrecoverable, or only scaffolded. Prove reachability, atomicity, restart, reconciliation, and operator control. More workflow terminology cannot repair a missing commit protocol.

## Contents

- Capability evidence ladder
- Acceptance and start failures
- Queue, lease, and worker failures
- Wait, signal, schedule, and cancellation failures
- Cross-system and pipeline failures
- Runtime adapter failures
- Recovery protocol
- Invariant and failure table
- Failure-injection matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Capability evidence ladder

```text
types/definition
  -> registry
  -> active control-plane path
  -> durable state transition
  -> deployed worker/runtime dispatch
  -> restart/reconciliation
  -> operator repair
```

Classify each feature independently: starts, event fan-out, queue claims, retries, schedules, waits, signals, cancellation, replay, runtime persistence, pipelines, and observability. A rich type model does not prove any worker calls it.

Trace a requested operation through registration, scheduler/dispatch, the selected engine, and its authoritative state changes. A README, store interface, memory adapter, or successful local replay cannot establish persistent execution. Classify incomplete paths by observed behavior; do not transfer an archived implementation's defects to a current package.

## Acceptance and start failures

| Signature | Defect | Recovery/proof |
|---|---|---|
| API returns 202 but execution missing | response precedes durable acceptance | idempotent request retry; status immediately readable after accept |
| Execution exists but no queue row | execution/timeline/enqueue split across writes | orphan reconciler or transactional create; crash test |
| Duplicate starts share business effect | idempotency check read-then-insert | unique constraint/atomic insert plus concurrent test |
| Deterministic runtime ID differs from store ID | two identity owners | one explicit mapping and restart/poll test |
| Start endpoint uses legacy control plane | new system unreachable | route-to-control-plane trace |
| Definition exists but runtime registration missing | authored, not deployable | boot-time registry conformance |
| Start fails after external effect | effect occurs before durable intent/idempotency | transactional intent/outbox and effect idempotency |

For ambiguous client timeouts, query by idempotency/execution ID before retrying.

## Queue, lease, and worker failures

| Signature | Defect | Correction evidence |
|---|---|---|
| Two workers execute same row | selection and claim not atomic or lease ignored | concurrent claim oracle; atomic conditional claim/lock |
| Lease expires during healthy long task | no heartbeat/lease extension or duration bound | renewal and ownership-fenced completion |
| Old worker acknowledges after lease stolen | no fencing token/owner condition | ack/update requires current lease owner/version |
| Worker crashes after effect before ack | at-least-once redelivery | effect idempotency and replay test |
| Queue item dead but execution running forever | state/dead-letter update split | reconciler and terminal/operator state |
| Retry count grows without bound | attempt/backoff/dead policy absent | bounded retry and dead-letter action |
| Worker process starts but no loops run | boot/supervision missing | deployed process and tick/heartbeat evidence |
| Shutdown drops leased work | abrupt exit/no drain | stop claims, cancel/drain, release/expire leases |

For the selected persistent queue, inspect selection, conditional claim, acknowledgement, and retry transitions. Prove concurrent claims and owner-fenced completion. Choosing a locking primitive alone does not establish fairness, ordering, transaction scope, or correct recovery.

## Wait, signal, schedule, and cancellation failures

| Signature | Defect | Required repair |
|---|---|---|
| Wait marked timed out but no resume row | status update and enqueue split | transaction/outbox or reconciler for terminal wait without resume |
| Signal stored but execution never resumes | signal, wait update, enqueue, processed marker split | durable transition and repair scan |
| Late signal resumes timed-out/cancelled wait | status change not conditional | compare-and-set active wait and conflict response |
| Same signal wakes multiple waits unexpectedly | matcher/identity ambiguity | explicit target/matcher and uniqueness policy |
| Interval schedule publishes twice | schedule claim/update not atomic | occurrence identity and idempotent start |
| Cron row exists but never fires | calendar/timezone expansion unimplemented | explicit unsupported status or implemented parser tests |
| Cancel says applied while runtime ignores it | request state confused with terminal cancellation | requested/cancelling/applied/terminal distinction |
| Cancel races success | terminal-state policy absent | compare-and-set and allowed-outcome tests |

When wait state, resume enqueue, signal consumption, timeline, and execution updates occur in separate writes, identify each crash window. Use the selected owner's transaction/outbox or reconciliation contract and test interruption between writes. Do not assume the current utility package implements an application control plane.

## Cross-system and pipeline failures

| Signature | Defect | Proof |
|---|---|---|
| Runtime starts but DB still pending | cross-system start/status gap | idempotent start plus poll/reconciler |
| DB says running but runtime never received start | status updated before external runtime call | recoverable intent/queue and start retry |
| Workflow succeeds while required sink failed | stage/sink state collapsed | per-sink manifest and completion predicate |
| Checkpoint advances before artifact/sink commit | attempted input treated as progress | committed receipt checkpoint |
| Duplicate retry corrupts sink | activity not idempotent/version-aware | fail-after-effect replay oracle |
| All records kept for profile | nominal stream is unbounded | memory-bound large input test |
| Backfill overwrites newer live change | no authority version compare | snapshot capture plus catch-up and version-aware projector |
| Compensation fails silently | compensation treated as magic rollback | compensation state, retry/operator escalation |

Workflow runtimes do not make external effects atomic. Each activity needs an effect identity, timeout/cancellation, retry safety, and compensation/repair where appropriate.

## Runtime adapter failures

| Signature | Meaning | Action |
|---|---|---|
| Adapter compiles but every method returns unsupported | seam only, no runtime capability | keep routes/readiness disabled or explicit unavailable |
| Memory adapter passes tests | process-local behavior proven only | run durable backend restart tests |
| Poll returns undefined indefinitely | running/suspended/missing ambiguous | runtime state/heartbeat/deadline classification |
| Registration names differ across deployments | queued state cannot resolve workflow | deployment compatibility/version gate |
| Workflow code changes with in-flight executions | replay/version compatibility unknown | pin version or migration strategy |
| Effect/Temporal API assumed from guide | alpha/version drift | inspect installed exports and executable fixture |

Do not label an adapter durable because its interface uses `Effect` or its name contains `sql`. Trace actual persistence, claim ownership, and fresh-owner reconstruction; an interface or placeholder cannot satisfy those guarantees.

## Recovery protocol

1. Stop unsafe retry/dispatch if it can duplicate irreversible effects.
2. Capture execution, timeline, queue, lease, wait, signal, schedule, cancellation, runtime, stage/sink, checkpoint, and deployed-version state.
3. Identify the last authoritative transition and any external effect identity.
4. Classify state as safe-to-retry, already-applied, partially-applied, terminal, or unresolved.
5. Apply a named repair: enqueue orphan, release expired lease, reconcile runtime, restore missing projection, resume wait, mark dead, replay from checkpoint, or operator compensation.
6. Make repair idempotent and audit it.
7. Restart workers/runtime and observe through real status/control endpoints.
8. Reconcile final domain and side-effect state, not only workflow status.

Never delete the timeline/queue/error evidence before repair verification.

## Invariant and failure table

| Invariant | Failure oracle |
|---|---|
| Accepted run is durably discoverable | kill after response; status exists after restart |
| One idempotency key has one intended execution/effect | concurrent starts and ambiguous response retry |
| Queue completion is fenced to lease owner/version | lease expiry plus old worker ack |
| Checkpoint never exceeds committed output | kill before sink receipt |
| Required sinks gate completion | fail each sink separately |
| Wait transition produces at most one resume | signal/timeout race |
| Schedule occurrence starts at most intended run | two schedulers claim same due row |
| Cancellation state reflects reality | cancel/success/failure race |
| Runtime/store converge | fail on both sides of start/poll update |
| Operator can repair orphaned partial states | seeded orphan fixtures and repair commands |

## Failure-injection matrix

Kill or fault:

- after execution insert, each timeline append, and queue insert;
- after lease claim, status-running update, external start, ack, and poll persist;
- after signal record, wait update, resume enqueue, processed marker, and timeline;
- after timeout wait update and before enqueue;
- after schedule occurrence start and before next-run update;
- before/after cancellation request, runtime interrupt, and terminal update;
- after every external activity effect and before activity acknowledgement;
- before/after artifact/sink receipt and checkpoint;
- during worker heartbeat/lease renewal;
- during deployment with old queued workflow versions;
- during shutdown and dependency restart.

Run with two or more workers/schedulers, duplicate messages, out-of-order signals, slow activities, clock skew, and a real durable store/runtime where claims require durability.

## Executable verification

Create deterministic failpoints and restart the process between them. Query durable tables/runtime and use public status/timeline/control APIs. Assert:

- no accepted run vanishes;
- duplicate delivery does not duplicate semantic effects;
- partial states are visible and repaired;
- leases are fenced and recover;
- wait/signal/schedule races produce declared outcomes;
- cancellation reaches a real terminal outcome;
- required sinks gate completion;
- in-flight version/deployment mismatch fails safely;
- shutdown leaves recoverable work;
- operator repair is idempotent and audited.

Unit tests against a memory store/adapter are useful for control logic but do not establish process-loss durability.

## Deliberate exclusions

- Do not force Effect, `@effect/workflow`, Temporal, or any one workflow implementation.
- Do not call types, tables, adapters, or definitions implemented behavior.
- Do not call a memory adapter durable.
- Do not claim external side effects are atomic because workflow state is durable.
- Do not use retries without idempotency, bounded attempts, and operator visibility.
- Do not collapse requested cancellation into completed cancellation.
- Do not advance pipeline progress from attempted work.
- Do not claim recovery without process restart and real dependency tests.

## Sources and freshness

Public utility source: [`workflow`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts), [`task`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/task/mod.ts) and [`storage`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/storage/mod.ts). The failure signatures describe risks to investigate, not defects attributed to these packages. Trace the consumer's actual adapter and transaction participants, then reproduce the relevant crash window or lifecycle failure at the installed version.
