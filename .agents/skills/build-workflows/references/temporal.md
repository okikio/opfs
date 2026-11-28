# Temporal TypeScript architecture and operations

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [When to choose Temporal](#when-to-choose-temporal)
- [Process and package APIs](#process-and-package-apis)
- [Workflow and activity example](#workflow-and-activity-example)
- [Determinism](#determinism)
- [Clients and identity](#clients-and-identity)
- [Signals, queries, and updates](#signals-queries-and-updates)
- [Retries, timeouts, heartbeats, and cancellation](#retries-timeouts-heartbeats-and-cancellation)
- [Schedules, timers, child workflows, and Continue-As-New](#schedules-timers-child-workflows-and-continue-as-new)
- [Workers and task queues](#workers-and-task-queues)
- [Versioning and deployment](#versioning-and-deployment)
- [Projection and domain-state integration](#projection-and-domain-state-integration)
- [Testing and verification](#testing-and-verification)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)

## When to choose Temporal

Temporal is a strong candidate when business coordination must survive host loss
and needs long histories, durable timers, message passing, retries, cancellation,
child workflows, operator inspection, or replay across deployments.

Do not choose it only to run a short queue consumer. Account for Temporal
Service/Cloud operations, namespaces, task queues, Worker deployment, data
conversion/encryption, history growth, deterministic code constraints, and safe
version rollout.

## Process and package APIs

| Handoff | Package | Owns | Must not do |
|---|---|---|---|
| Client/API | `@temporalio/client` | Connect, start, get handles, signal/query/update/cancel/terminate, schedules | Execute workflow code in request process |
| Workflow | `@temporalio/workflow` | Replay-safe orchestration and state | Direct DB/network/filesystem/Node/DOM I/O |
| Activity | ordinary TS plus `@temporalio/activity` context | Side effects, heartbeats, external systems | Assume exactly-once execution |
| Worker | `@temporalio/worker` | Bundle/poll workflows and execute activities | Serve as public API by accident |
| Testing | `@temporalio/testing` | Time-skipping/integration environment | Replace production replay/upgrade tests entirely |
| Service/Cloud | Temporal platform | Histories, task queues, timers, visibility | Own product domain state automatically |

Keep code in separate modules:

```text
workflows/
  publish-import.ts
  messages.ts
activities/
  imports.ts
client/
  temporal.ts
worker/
  imports.ts
```

Workflow modules may import activity types but not activity implementations. The
Worker receives the implementation object and a `workflowsPath`/bundle.

## Workflow and activity example

Activity contract and implementation:

```ts
// activities/imports.ts
export interface ImportActivities {
  readonly parseUpload: (input: ParseUploadInput) => Promise<ParsedArtifact>
  readonly publishBatch: (input: PublishBatchInput) => Promise<PublishResult>
  readonly finalizeImport: (input: FinalizeInput) => Promise<ImportSummary>
}

export function makeImportActivities(deps: ImportActivityDeps): ImportActivities {
  return {
    parseUpload: async (input) => await deps.parser.parse(input),
    publishBatch: async (input) => await deps.store.publishIdempotently(input),
    finalizeImport: async (input) => await deps.store.finalize(input),
  }
}
```

Workflow definition:

```ts
// workflows/publish-import.ts
import { proxyActivities } from "@temporalio/workflow"
import type { ImportActivities } from "../activities/imports.ts"

const { parseUpload, publishBatch, finalizeImport } =
  proxyActivities<ImportActivities>({
    startToCloseTimeout: "10 minutes",
    retry: {
      maximumAttempts: 5,
      initialInterval: "1 second",
      backoffCoefficient: 2,
      maximumInterval: "1 minute",
    },
  })

export async function publishImport(input: PublishImportInput): Promise<ImportSummary> {
  const artifact = await parseUpload(input)

  for (const batch of artifact.batches) {
    await publishBatch({
      organizationId: input.organizationId,
      importId: input.importId,
      batch,
      operationKey: `${input.importId}:${batch.index}`,
    })
  }

  return await finalizeImport({
    organizationId: input.organizationId,
    importId: input.importId,
    artifactId: artifact.id,
  })
}
```

This is illustrative. A real parser should usually store a large manifest/blob
outside history and return references, not thousands of batches in a workflow
result. Validate exact SDK option names against the installed version.

Worker:

```ts
import { NativeConnection, Worker } from "@temporalio/worker"
import * as activities from "../activities/imports.ts"

const connection = await NativeConnection.connect({ address: config.address })
const worker = await Worker.create({
  connection,
  namespace: config.namespace,
  taskQueue: "imports-v1",
  workflowsPath: new URL("../workflows/mod.ts", import.meta.url).pathname,
  activities: activities.makeImportActivities(resources),
  maxConcurrentActivityTaskExecutions: config.activityConcurrency,
})

await worker.run()
```

Host/runtime details differ across Node and Deno. Verify the Temporal TypeScript
SDK runtime and bundler support for the selected deployment; do not assume a
Deno service can run the Node Worker unchanged.

## Determinism

Temporal Workflow code is replayed against Event History in a deterministic
sandbox. The current TypeScript docs state:

- external state and side effects belong in Activities;
- workflow parameters/results must be serializable, with one object argument
  recommended for evolvability;
- Node.js and DOM APIs cannot be used in workflow code;
- Temporal provides deterministic replacements for time/random APIs within the
  sandbox, but unavailable APIs such as `crypto.randomUUID()` must not be used;
- workflow logging should use the SDK logger so replay does not duplicate logs.

Avoid:

- direct fetch, SQL, filesystem, environment, or process access;
- branching on mutable config loaded at replay time;
- nondeterministic iteration/order that changes command sequence;
- libraries with hidden native/runtime side effects;
- using replay-status checks to change business logic;
- activity implementation imports in workflow bundles.

Run replay tests on representative production histories before deploying changed
workflow code.

## Clients and identity

The API/composition root owns a long-lived Temporal client connection. Start with
a business-meaningful Workflow ID and one object argument:

```ts
const handle = await temporal.workflow.start(publishImport, {
  workflowId: `import:${organizationId}:${importId}`,
  taskQueue: "imports-v1",
  args: [{ organizationId, importId, uploadId }],
  memo: { organizationId, importId },
  // Application-owned mapper; define it against registered Search Attribute types.
  searchAttributes: toSearchAttributes({ organizationId, importId }),
})
```

Define Workflow ID reuse/conflict policy explicitly. A stable Workflow ID is an
admission identity, not automatic idempotency for every Activity.

Use `start` when the API should return after durable start; `execute` waits for
result and is inappropriate for long background work in an HTTP request. Store
or derive safe status links from product-owned IDs. Do not expose raw Temporal
namespace/task-queue internals as the only product API.

Differentiate cancellation (cooperative), termination (immediate platform stop),
and workflow failure. Termination is an operator last resort and may skip
workflow cleanup/compensation.

## Signals, queries, and updates

The current TypeScript SDK distinguishes:

| Message | Mutates state | Returns value | History/processing behavior | Use |
|---|---:|---:|---|---|
| Query | No | Yes | Read-only; requires Worker to answer | Inspect live state |
| Signal | Yes | No result from handler | Server acceptance returns before workflow processes it | Approval, notify, wake |
| Update | Yes | Yes | Worker validates/accepts and records accepted update | Command needing accepted result |

Definitions and handlers:

```ts
import {
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  setHandler,
} from "@temporalio/workflow"

export const approve = defineSignal<[ApproveInput]>("approve")
export const progress = defineQuery<Progress>("progress")
export const correctMapping = defineUpdate<MappingVersion, [CorrectMappingInput]>(
  "correctMapping",
)

export async function reviewedImport(input: ReviewedImportInput) {
  let approved: ApproveInput | undefined
  let mapping = input.mapping

  setHandler(progress, () => ({ approved: approved != null, mapping }))
  setHandler(approve, (message) => { approved = message })
  setHandler(correctMapping, (message) => {
    const previous = mapping
    mapping = message.mapping
    return previous
  }, {
    validator: (message) => MappingSchema.parse(message.mapping),
  })

  await condition(() => approved != null)
  return await publishApproved({ ...input, mapping, approved: approved! })
}
```

Query handlers must not mutate state or perform async I/O. Signal handlers do not
return a workflow-processed result. Update validators are synchronous and can
reject before the Update is accepted into history. Define initialization and
concurrency rules for async Signal/Update handlers. Complete handlers before
Continue-As-New; exact SDK constraints must be checked.

Every public message endpoint still requires product authorization and payload
validation. A Temporal handle is not an authorization decision.

## Retries, timeouts, heartbeats, and cancellation

### Activity retry

Activities are normally the retry owner for transient I/O. Configure:

- initial/backoff/maximum interval;
- maximum attempts or expiration budget;
- non-retryable application failure types;
- per-operation idempotency/reconciliation;
- rate limits and provider budgets.

### Timeouts

Distinguish:

| Timeout | Meaning |
|---|---|
| Schedule-To-Start | How long an Activity can wait for a Worker |
| Start-To-Close | One Activity attempt runtime |
| Schedule-To-Close | Total Activity execution including retries/queueing |
| Heartbeat | Maximum silence for a heartbeating long Activity |
| Workflow execution/run/task | Workflow-level platform bounds with different semantics |

Set at least one appropriate Activity execution timeout as required by the SDK.
Do not use a giant timeout instead of heartbeats for long progress-aware work.

### Heartbeats

Long Activities heartbeat progress small enough to resume/retry safely. Heartbeat
details can carry a checkpoint such as last committed batch, not the entire
dataset. A heartbeat does not replace domain idempotency or an output manifest.

Respond to Activity cancellation through heartbeat/abort-aware calls. If a
provider call ignores cancellation, record ambiguous completion and reconcile.

### Cancellation

Workflow cancellation is cooperative. Define cancellation scopes for cleanup
that must run, but avoid pretending cleanup can undo all external effects.
Activities need cancellation behavior; disconnected HTTP clients do not
automatically cancel a durably accepted workflow.

Test cancellation while queued, running an Activity, waiting on a timer,
handling a signal/update, and during compensation.

## Schedules, timers, child workflows, and Continue-As-New

Use Temporal Schedules for platform-owned recurring starts. Define overlap,
catch-up, pause/backfill, timezone, and action policy. Do not put an infinite
cron loop inside a Workflow.

Workflow timers are durable and replay-safe. Use them instead of wall-clock
sleep APIs.

Use a Child Workflow when a sub-operation needs its own history, identity,
retry/cancel policy, visibility, or independent lifetime. Use an Activity for a
side effect or bounded computation. Do not create a Child Workflow for every
function call.

Use Continue-As-New to bound Event History for long-lived workflows. Carry the
minimal versioned state into the new run. Coordinate outstanding handlers and
message deduplication; do not Continue-As-New from an Update handler under the
current documented constraints.

## Workers and task queues

Task queues route work; they are not product authorization scopes. Define:

- which worker build/deployment polls each queue;
- workflow and activity types registered;
- namespace and environment isolation;
- concurrency/tuning and downstream capacity;
- worker identity, health/readiness, graceful shutdown;
- sticky queue/cache implications;
- activity rate limits and fairness;
- build compatibility/version routing.

Readiness means the worker is connected and polling with the intended catalog,
not merely that the process started. Alert on schedule-to-start latency, task
failures, workflow task failures, activity retry exhaustion, poller absence,
history growth, and stuck/cancel-requested runs.

## Versioning and deployment

Temporal supports deployment/worker versioning and replay-safe workflow change
strategies, but APIs and recommendations evolve. Inspect the installed SDK and
current official safe-deployment guide before choosing:

- Worker Deployment Versioning/routing;
- workflow patch/version markers;
- task-queue migration;
- new workflow type/version;
- Continue-As-New onto a compatible version.

Release gate:

1. replay new workflow code against representative existing histories;
2. verify payload/data-converter compatibility;
3. deploy compatible activity implementations;
4. route new starts deliberately;
5. retain workers capable of open histories;
6. observe nondeterminism/workflow task failures;
7. define rollback before rollout;
8. retire old code only when no histories require it.

Changing Activity implementation without changing workflow command history can
still change business behavior on retry. Treat activity version compatibility as
part of the rollout.

## Projection and domain-state integration

Temporal history owns coordination facts; PostgreSQL usually owns product domain
state. Common patterns:

- Activities commit domain transactions and return stable revisions/IDs.
- An outbox projects domain changes to ClickHouse/search/notifications.
- Workflow memo/search attributes support operations, not full domain state.
- Product API reads a database projection and may query Temporal for live
  workflow-only state.

Never dual-write a domain row and “workflow projection updated” across systems
without idempotency/reconciliation. If start follows a domain transaction, use a
transactional outbox/dispatcher or a reconciler for missing starts. If workflow
start precedes the domain record, make the first Activity idempotently create or
find it.

## Testing and verification

- Unit-test pure workflow branches with mocked Activities where useful.
- Use the Temporal test environment/time skipping for timers and messages.
- Integration-test a real Worker, Client, and representative Activities.
- Replay stored histories under candidate workflow bundles.
- Verify activity idempotency after timeout-after-commit and worker kill.
- Test Signal/Query/Update authorization at the API entrypoint and semantics in the
  workflow.
- Exercise every timeout, retry exhaustion, heartbeat timeout, cancellation, and
  termination path.
- Kill Worker during Activity and workflow task; restart another Worker.
- Test schedules, overlap/catch-up, child cancellation, Continue-As-New, and
  history growth.
- Deploy two compatible Worker versions and execute rollout/rollback drills.
- Reconcile missing/stale PostgreSQL projections.

## Failure signatures

| Signature | Likely defect | Correction |
|---|---|---|
| Nondeterminism error after deploy | Workflow command path changed incompatibly | Replay gate and version strategy |
| Activity repeats external charge | Effect not idempotent | Provider/local operation key and reconcile |
| Signal call returns but UI sees no change | Signal acceptance mistaken for processing | Query/projection/event confirmation |
| Query hangs with healthy Temporal Service | No compatible Worker polling | Worker readiness/task queue check |
| Run remains open forever | Missing timeout/cancel/operator policy | Explicit lifecycle bounds |
| History grows without bound | No Continue-As-New/partitioning | History budget and rollover |
| Old run cannot deserialize input | Breaking payload/data converter | Versioned decoder/compatibility worker |
| API user controls arbitrary Workflow ID | Missing product auth/scope mapping | Server-owned identity and policy |
| Activity timeout retries permanent failure | Retry classification absent | Non-retryable failure type |
| Worker works in Node fixture but not Deno host | Runtime/bundling assumption | Dedicated compatible worker deployment |

## Deliberate exclusions

- Do not use a Temporal Workflow as the primary store for query-heavy domain
  entities.
- Do not call the Temporal Client inside Workflow code.
- Do not put large CSVs, WARC records, or generated artifacts into history.
- Do not use termination as ordinary cancellation.
- Do not assume Workflow ID uniqueness makes external effects exactly once.
- Do not run a Worker in a constrained edge request runtime without explicit SDK
  compatibility and lifecycle evidence.

## Sources and freshness

- Temporal TypeScript developer guide: https://docs.temporal.io/develop/typescript
  (primary source, checked 2026-07-17).
- Workflow basics and deterministic constraints:
  https://docs.temporal.io/develop/typescript/workflows/basics
- Message passing: https://docs.temporal.io/develop/typescript/workflows/message-passing
- Activity timeouts: https://docs.temporal.io/develop/typescript/activities#activity-timeouts
- Safe deployment/versioning: https://docs.temporal.io/develop/typescript/workflows/versioning
  and https://docs.temporal.io/develop/safe-deployments
- TypeScript SDK API: https://typescript.temporal.io/ (package/API signatures are
  version-sensitive; typecheck examples against the installed SDK).
