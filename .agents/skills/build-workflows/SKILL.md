---
name: build-workflows
description: Design, implement, migrate, review, diagnose, or verify durable workflows, workers, queues, scheduled jobs, timers, signals, retries, resumable pipelines, and multi-stage ingestion. Use for Temporal, Effect Workflow, control planes, leases, checkpoints, idempotency, concurrency, throttling, batching, singleton work, cancellation, replay, operator recovery, and cross-system reconciliation. Do not call an in-memory promise chain durable merely because it retries.
---

# Build durable workflows and pipelines

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

If the reviewed workflow is run or tested by Deno, load `deno-software` even
for a read-only review of local control or replay. The execution environment is
independent of whether a change to runtime configuration was requested.

Durability is a recovery property, not a naming convention. Start from the state
that must survive process loss, then design execution, queues, effects, leases,
checkpoints, timers, signals, and operator recovery around that authority.

`build-data` owns storage engines and artifact formats. `build-apis` owns public
HTTP exposure. `build-libraries` owns reusable restart/checkpoint contracts that
do not themselves provide durable orchestration. the shared quality contract owns the
final completion verdict.

## Outcome

A durable workflow should have a traceable execution model:

```text
trigger / command
      |
      v
durable run identity
      |
      v
persisted state/history
      |
      +--> queue / timer / signal / wait
      |
      v
claimed attempt with lease/fence
      |
      v
activity / external effect
      |
      v
atomic result/checkpoint publication
      |
      +--> retry / compensation / reconciliation
      |
      v
terminal state + operator evidence
```

A table, workflow definition, or queue consumer stub is not proof that the path
is reachable or survives interruption.

## Durability evidence ladder

Classify each claimed capability independently:

1. workflow/definition authored;
2. registered/discoverable by the runtime;
3. runtime adapter implemented rather than stubbed;
4. actual execution process/work unit boots and is reachable;
5. durable run/history/projection persists;
6. queue, timer, wait, signal, cancellation, and retry paths exist as required;
7. restart/replay/resume behavior is tested;
8. operator inspection, repair, retry, cancel, and reconciliation exist;
9. API/CLI/application reaches the durable path;
10. deployment/upgrade behavior is proven for the claimed topology.

Do not collapse these into one “workflow exists” boolean.

## Identity and authority preflight

For every workflow, define:

- logical workflow/run ID;
- attempt ID and retry semantics;
- task/job/message/event identity;
- external-effect idempotency key;
- authoritative durable state/history;
- sequence/version/fencing value used to reject stale work;
- completion criteria and terminal-state owner;
- checkpoint identity and the outputs it proves durable;
- trigger dedupe/concurrency/singleton policy;
- retention and replay window;
- operator-visible audit information.

Name the actual execution resource. Do not use `worker` as a generic word for a
process, thread, browser context, async task, queue claim, or lease holder.

## Procedure

1. **Separate transient control from durable authority.** `AbortSignal`, local
   promises, in-memory observables, and process-local queues coordinate active
   work but do not survive process loss.
2. **Choose the runtime from requirements.** Timers, long sleeps, signals,
   replay, throughput, latency, versioning, operational cost, deployment, and
   language/runtime constraints decide whether Temporal, Effect Workflow, a
   database control plane, or another owner fits. Do not select by familiarity.
3. **Keep replay deterministic.** Orchestration code that may replay cannot read
   ambient time/random/network/filesystem/process state directly. Isolate
   nondeterministic I/O in activities/effects or recorded commands according to
   the engine contract.
4. **Make retryable effects safe.** External writes are at-least-once unless a
   stronger guarantee is actually proven. Use provider idempotency, transactional
   dedupe/inbox/outbox, compare-and-set, unique constraints, or reconciliation.
5. **Make claims stale-safe.** Leases need expiry plus a fencing/version token so
   an old execution cannot commit after a new claimant has taken ownership.
6. **Commit checkpoints after durable outputs.** A checkpoint means the outputs
   it references are committed and replay-safe. Do not advance progress before
   a required sink/artifact is durable.
7. **Treat cross-system writes as sagas unless one transaction covers them.**
   Define compensation, reconciliation, retry, and operator state for the gap.
8. **Bound work.** Queue depth, concurrency, batch size, open resources, retry
   attempts, backoff, timers, buffered events, and cleanup all need limits or
   admission rules.
9. **Define cancellation semantics.** Distinguish cancel request, cooperative
   stop, cleanup/disposal, compensation, terminal canceled state, and late result
   rejection.
10. **Design operator recovery.** Inspection, retry, resume, replay, quarantine,
    dead-letter/poison handling, manual override, and audit must use the same
    durable authority as automatic execution.
11. **Document internal workflow invariants.** Sequence numbers, lease/fence
    rules, checkpoint ordering, cancellation transitions, timer semantics,
    replay restrictions, and repair algorithms deserve comments/TSDoc even when
    not exported.

## Pipeline rules

For multi-stage ingestion or ETL:

- preserve source provenance and immutable/raw evidence where required;
- distinguish stage attempt from logical batch/run;
- publish artifacts atomically through manifests or equivalent commit records;
- keep required sinks incomplete until their receipts/reconciliation succeed;
- bound batching/memory/concurrency;
- make resume choose committed work, not “last line printed”;
- classify partial results by sink/stage rather than one global success flag;
- preserve enough identity to rerun one failed projection without replaying
  unrelated committed work.

## Failure and recovery drills

Deliberately test:

- process loss before/after each durable write;
- duplicate trigger or queue delivery;
- two concurrent claims of the same work;
- lease expiry while the old claimant later returns;
- external effect succeeds but local commit fails;
- local state commits but downstream provider fails;
- poison input and retry exhaustion;
- queue backlog/rate-limit pressure;
- cancellation during an activity and during checkpoint publication;
- replay after code/version change;
- worker/runtime restart;
- partial sink failure and targeted reconciliation;
- operator retry/resume/repair path.

A happy-path retry unit test does not prove durability.

## Reference routing

- [utility-workflows.md](references/utility-workflows.md): current Context/Task/
  activity/history/dispatch model and the proof separating local replay from
  durable restart; use for current Core or standalone utility work.

- [durability.md](references/durability.md): authority, engine selection,
  identities, determinism, completion, and durability classification.
- [effect-workflow.md](references/effect-workflow.md): Effect services/Layers and
  evidence-bounded `@effect/workflow` behavior, including placeholder warnings.
- [temporal.md](references/temporal.md): Temporal clients, workflow code,
  activities, execution processes, messages, schedules, retries, cancellation,
  and deployment/versioning.
- [control-plane.md](references/control-plane.md): definitions, registration,
  admission, projections, runtime reachability, and API/CLI integration.
- [atomicity.md](references/atomicity.md): transactions, outbox/inbox,
  idempotency, sequences, cross-system gaps, and reconciliation.
- [workers.md](references/workers.md): queues, claims, leases/fencing, timers,
  waits, signals, schedules, backpressure, and poison work.
- [pipelines.md](references/pipelines.md): staged ingestion, provenance,
  bounded batches, checkpoints, manifests, sinks, and projections.
- [recovery.md](references/recovery.md): restart/resume, lease expiry,
  reconciliation, replay, repair, and failpoint testing.
- [streams.md](references/streams.md): event streams/SSE, cursor authority,
  replay, retention, slow consumers, and cancellation.
- [failures.md](references/failures.md): source-grounded failure signatures and
  recovery decisions.

## Verification ladder

1. deterministic state-transition/unit tests;
2. store/queue/timer/lease integration tests;
3. duplicate/concurrency/idempotency tests;
4. failpoints around every important commit pair;
5. actual execution process restart/recovery;
6. replay/versioning tests when the runtime replays code;
7. public API/CLI reachability;
8. operator recovery drill;
9. deployment/runtime health and shutdown when claimed.

## Completion gate

Do not claim durability until an interruption and restart have executed against
the real persistence and execution path, stale/duplicate work cannot corrupt the
result, required cross-system gaps have reconciliation, cancellation and cleanup
are coherent, and an operator can inspect and repair the run. Clearly separate
unimplemented adapters, blocked runtime tests, and aspirational design from
verified behavior.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
