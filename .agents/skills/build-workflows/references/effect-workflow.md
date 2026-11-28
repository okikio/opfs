# Effect and `@effect/workflow`

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [Status and evidence limit](#status-and-evidence-limit)
- [Core Effect architecture](#core-effect-architecture)
- [Workflow definition and Layer](#workflow-definition-and-layer)
- [Runtime separation](#runtime-separation)
- [Activities and external effects](#activities-and-external-effects)
- [Durable clocks, waits, and signals](#durable-clocks-waits-and-signals)
- [Typed errors and retry](#typed-errors-and-retry)
- [Scope, interruption, and workers](#scope-interruption-and-workers)
- [Configuration and observability](#configuration-and-observability)
- [Production adapter acceptance](#production-adapter-acceptance)
- [Failure signatures](#failure-signatures)
- [Verification](#verification)

## Status and evidence limit

The example below is scoped to `@effect/workflow` 0.18.2 and compatible Effect
3.21.x APIs. The published 0.18.2 manifest declares Effect `^3.21.2` plus RPC,
Platform and Experimental peer dependencies. This is a versioned example, not a
claim about the latest release. Resolve an exact compatible set and check it
again during upgrades.

The public artifact exports `Workflow.make`, workflow `toLayer` and
`WorkflowEngine.layerMemory`. A memory-engine test can establish local execution
and registration. Durable production execution also needs a persistent adapter,
committed transitions and restart/recovery evidence. Verify the selected adapter's
start, poll, interruption and resume behavior; placeholder methods and type
interfaces do not prove implementation.

## Core Effect architecture

Use Effect services and Layers for capabilities around workflow execution:

```text
validated config
  -> database / queue / telemetry Layers
  -> stores and external service clients
  -> activity implementations
  -> workflow engine adapter
  -> workflow registration Layer
  -> API client runtime and worker runtime
```

Keep API and worker runtimes independently constructible. They may share Layer
factories but often have different permissions, resources, concurrency, and
lifetime. A public API should not boot worker loops as an import side effect.

Define external dependencies as `Context.Tag` services. Workflows/activities
request those services; a production Layer supplies real clients and a test
Layer supplies deterministic fakes. Use `Layer.scoped` and
`Effect.acquireRelease` for clients, leases, and subscriptions with cleanup.

## Workflow definition and Layer

This composition sketch uses the verified 0.18.2 workflow API. `ImportService`
and `ImportServiceLive` are application-owned services supplied by the consumer:

```ts
import { Workflow, WorkflowEngine } from "@effect/workflow"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"

const ImportPayload = {
  organizationId: Schema.String,
  uploadId: Schema.String,
}

const ImportResult = Schema.Struct({
  imported: Schema.Number,
  rejected: Schema.Number,
})

export const PublishImportWorkflow = Workflow.make({
  name: "PublishImportWorkflow",
  payload: ImportPayload,
  success: ImportResult,
  idempotencyKey: ({ organizationId, uploadId }) =>
    `${organizationId}:${uploadId}`,
})

export const PublishImportWorkflowLayer = PublishImportWorkflow.toLayer(
  Effect.fn(function* (payload) {
    const imports = yield* ImportService
    return yield* imports.publish(payload)
  }),
)

export const WorkflowLive = Layer.mergeAll(
  PublishImportWorkflowLayer,
).pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory),
  Layer.provideMerge(ImportServiceLive),
)
```

The in-memory engine is appropriate for unit tests and capability spikes. It is
not a production durability proof.

Validate payloads at both public transport and workflow runtime handoffs. The
transport schema can accept product-specific syntax; the workflow payload should
be a stable serializable object with explicit schema/version. Do not pass Hono
context, open streams, database clients, class instances, or large file contents.

## Runtime separation

Separate four contracts:

| Contract | Responsibility |
|---|---|
| Definition | Name, payload/result schemas, deterministic identity, implementation Layer |
| Registration | Owning service, semantic version, trigger metadata |
| Runtime adapter | Compute ID, register, start, poll, interrupt, resume |
| Control plane | Durable admission, policy, projections, queues, timelines, public commands |

An adapter interface prevents HTTP handlers from depending directly on an
engine. It does not create durability. For every operation state whether it is:

- implemented by the engine;
- implemented by PostgreSQL control-plane state;
- a projection of another authority;
- unsupported and rejected explicitly.

Do not return success from a placeholder adapter. Disable its configuration or
fail startup before accepting requests.

Build the Layer/runtime once per API host or worker:

```ts
const workerRuntime = ManagedRuntime.make(WorkflowWorkerLive)

try {
  await workerRuntime.runPromise(runWorker)
} finally {
  await workerRuntime.dispose()
}
```

Do not build one runtime per queue item.

## Activities and external effects

Use activities or the package's current durable-step primitive for I/O and
retryable effects. Each activity contract needs:

- stable name/version;
- serializable input/output schema;
- idempotency scope/key;
- timeout and heartbeat/lease behavior if supported;
- typed retryable and permanent errors;
- redacted observability fields;
- compensation/reconciliation path;
- bounded resources and cancellation.

```ts
export interface SendReceiptEmailInput {
  readonly organizationId: string
  readonly receiptId: string
  readonly operationKey: string
}

export class EmailService extends Context.Tag("app/EmailService")<
  EmailService,
  {
    readonly sendReceipt: (
      input: SendReceiptEmailInput,
    ) => Effect.Effect<ProviderMessageId, EmailRejected | EmailUnavailable>
  }
>() {}
```

The provider operation key must reach the provider or an atomic local
deduplication record. A workflow-level ID alone does not deduplicate a provider
call after an ambiguous timeout.

Do not put external network calls directly in replayed orchestration. Do not
retry every tagged error. Convert permanent provider rejection and invalid input
to non-retryable workflow decisions.

## Durable clocks, waits, and signals

The reviewed `@effect/workflow` source/handoff describes `DurableClock` for long
sleeps and `DurableDeferred` for suspension/token completion. Confirm exact APIs
against the pinned package before implementation.

For a durable wait, persist or engine-own:

- wait ID and execution ID;
- wait/signal name and payload schema version;
- authorization scope;
- resume/completion token;
- timeout/deadline;
- buffered-signal rule;
- unresolved/resolved/timed-out/cancelled status;
- winning completion identity;
- timeline evidence.

Timeout, signal, and cancellation are a race. The winning transition and resume
publication must be one transaction or repairable by a reconciler.

A wait router has an atomicity gap if it performs these as independent commits:

```text
mark wait timed out
  -> enqueue timeout signal
  -> append timeline
  -> mark execution pending
```

A crash after the first commit can remove the wait from due scans without
enqueuing resume work. Commit the winning transition, resume queue item, timeline
event and required projection together, or provide a reconciler that can find
and repair the partial transition.

## Typed errors and retry

Separate:

| Class | Examples | Default policy |
|---|---|---|
| Invalid/permanent | schema invalid, policy denied, unsupported version | Fail without retry |
| Domain decision | insufficient funds, approval rejected | Workflow branch/terminal state |
| Transient infrastructure | provider 503, connection reset | Bounded retry with backoff/jitter |
| Ambiguous effect | timeout after provider may have committed | Lookup/reconcile before retry |
| Defect | invariant violation, impossible state | Fail, diagnose, repair code/data |
| Cancellation/interruption | operator/user/shutdown request | Cooperative cleanup and terminal policy |

Use Effect `Schedule` at the activity/effect retry owner where retry is safe. Record
attempt, delay, and final cause. Workflow/control-plane retries and activity
retries are different budgets; do not multiply them accidentally.

## Scope, interruption, and workers

Supervise worker loops. `forkDaemon` without an owned runtime/supervisor can hide
loop failure. Define whether one loop failure stops the worker, restarts with a
budget, or degrades readiness.

Worker lifecycle:

1. resolve config and build scoped resources;
2. validate unique workflow/activity catalog;
3. register with production engine/store;
4. verify migrations and queue/task-queue reachability;
5. publish readiness;
6. start supervised claim/poll/scheduler/wait/recovery loops;
7. on shutdown stop claims, interrupt/drain work, release/expire leases, flush,
   and dispose runtime.

Use Scope/finalizers for subscriptions and leased resources, but remember a hard
kill skips finalizers. Durable lease expiry and recovery remain mandatory.

## Configuration and observability

Pin engine driver, schema version, queue names, worker identity, concurrency,
lease/heartbeat durations, poll intervals, retry budgets, and observability
policy in a validated config. Do not select memory versus durable driver through
an undocumented fallback.

Correlate:

- logical execution and attempt IDs;
- workflow/registration version;
- activity and activity attempt;
- trigger/event/idempotency IDs;
- queue item/lease owner;
- wait/signal/timer;
- trace/correlation/organization IDs;
- replay status where the engine exposes it.

Avoid duplicate logs on replay. Use the engine/Effect observability path and an
explicit LogTape bridge if LogTape is the repository transport. Redact before
every sink.

## Production adapter acceptance

A production `@effect/workflow` adapter is accepted only when it proves:

- durable engine schema and migrations;
- unique definition registration and compatibility;
- deterministic execution ID behavior;
- start acknowledgement after durable acceptance;
- execution after API/worker restart;
- poll/interrupt/resume across processes;
- durable clock/deferred behavior across restart;
- atomic or reconciled projection gaps;
- multi-worker claim safety;
- old-version replay/upgrade behavior;
- operator inspection and repair;
- resource cleanup and bounded throughput.

Until then expose the driver as experimental/unavailable, not production.

## Failure signatures

| Signature | Defect | Next proof |
|---|---|---|
| `WorkflowEngine.layerMemory` in production graph | Process-local execution | Restart-test durable driver |
| Adapter methods return not implemented | Seam only | Disable config/startup or implement fully |
| Workflow starts but projection stays pending | Engine/control-plane gap | Poll/reconcile authority |
| Wait is timed out with no resume item | Non-atomic router | Transactional completion + recovery scan |
| Worker logs ready with zero active loops | Boot object mistaken for runtime | Reachable dispatch test |
| Same effect runs twice | Missing effect idempotency | Operation key and provider lookup |
| Loop fiber dies silently | Detached supervision | Worker failure/readiness policy |
| Upgrade fails old executions | No version/replay gate | Frozen history compatibility test |

## Verification

- Run workflow definition against memory Layer for fast logic tests.
- Run full production adapter in a real database/engine fixture.
- Kill API after durable start and worker at every activity checkpoint.
- Poll, interrupt, and resume from a different process.
- Race signal, timeout, cancellation, and duplicate signal.
- Restart across durable sleep/deferred.
- Inject transient, permanent, ambiguous, defect, and cancellation failures.
- Assert resource finalizers on cooperative interruption and lease recovery on
  hard kill.
- Replay/version-test representative stored histories before rollout.
- Verify operator status/timeline and reconcile corrupted/missing projections.

## Sources and freshness

- [`@effect/workflow` 0.18.2 metadata and published artifact](https://registry.npmjs.org/@effect/workflow/0.18.2), inspected 2026-11-26. `src/Workflow.ts` and `src/WorkflowEngine.ts` establish the example's make, layer and memory-engine surfaces.
- [Effect workflow source](https://github.com/Effect-TS/effect/tree/main/packages/workflow) and [official documentation](https://effect.website/) for current development; resolve the consumer's actual version before adopting changes.

`Workflow.make`, `toLayer`, `WorkflowEngine.layerMemory`, Activity, DurableClock
and DurableDeferred are version-sensitive. This guide does not establish that an
application SQL adapter exists or that production recovery has been tested.
The application services and transition protocols are design responsibilities.
