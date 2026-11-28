# Resumable, bounded, multi-sink data pipelines

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


Use this reference when work discovers, fetches, parses, normalizes, enriches, loads, aggregates, indexes, or projects data over time. A durable pipeline is not a `for` loop with retries. It has stage contracts, stable identities, committed checkpoints, bounded resources, explicit required/optional sinks, and recovery from every crash window.

## Contents

- Pipeline authority and execution owner
- Stage contract
- Identity, provenance, and versions
- Bounded processing and backpressure
- Checkpoints and resume
- Multi-sink commit model
- Error and quarantine policy
- Configuration and capability model
- Worker/runtime integration
- Operational state and controls
- Integration example
- Failure and recovery
- Test matrix
- Executable verification
- Deliberate exclusions
- Sources and freshness

## Pipeline authority and execution owner

Name:

- trigger owner: endpoint, event, webhook, schedule, CLI, or operator;
- execution authority: workflow store, job database, artifact manifest, or another durable owner;
- input authority and snapshot/change capture point;
- stage output authority versus rebuildable intermediates;
- worker/lease owner and deployment;
- sink authority and required/optional status;
- operator controls for pause, cancel, retry, replay, repair, and backfill.

Do not add Effect, Temporal, or another workflow engine automatically. A short bounded import can use an ordinary job runner with a durable manifest. A long-running pipeline with waits, schedules, external effects, or operator control may benefit from a durable workflow runtime. Preserve the consumer's selected owner and prove its adapter/deployment.

## Stage contract

Each stage needs a contract:

```ts
interface StageContract<Input, Output> {
  name: string
  version: string
  required: boolean
  inputSchema: string
  outputSchema: string
  identityOf: (input: Input) => string
  run: (batch: readonly Input[], context: StageContext) => Promise<StageBatch<Output>>
  retry: RetryPolicy
  resourceLimits: { batchSize: number; concurrency: number; timeoutMs: number }
}

interface StageBatch<T> {
  accepted: Array<{ identity: string; value: T }>
  rejected: Array<{ identity: string; code: string; retryable: boolean }>
  receipt: { batchId: string; checksum: string }
}
```

Common stages are hypotheses, not mandatory folders:

```text
discover -> fetch -> capture raw -> decode -> observe/profile -> normalize
  -> detect/change -> derive/enrich -> validate -> load authority
  -> aggregate -> search/graph/analytics projections -> reconcile -> publish
```

For every transition define input/output schema, stable identity, provenance, version compatibility, error policy, resource bounds, and checkpoint commit point. A mapper mutating an in-memory graph may be useful implementation detail but is not itself a stage commit.

## Identity, provenance, and versions

Use identities that survive retries:

- run ID: one invocation/backfill/retry lineage;
- source identity: provider/system plus object/page/file/event ID;
- source version: revision, ETag, sequence, snapshot, or content digest;
- record identity: deterministic domain/source mapping;
- batch/segment ID;
- stage name/version/config digest;
- artifact/sink target version;
- durable change/checkpoint identity.

Keep event time, source retrieval time, and processing time distinct. Store the original raw identity on normalized/derived records. A downstream failure should be traceable back to raw evidence without searching log text.

Schema/code/config changes can make a checkpoint incompatible. Reject resume or run a named migration/replay. Never silently continue a new mapper against old partially normalized output.

## Bounded processing and backpressure

Bound every resource:

- source page/batch size;
- decoded records held at once;
- network concurrency and per-host rate;
- open files/sockets;
- mapper/graph size;
- sink batch size;
- queue depth;
- rejected-record buffer;
- profiling cardinality/sample/sketch memory;
- output line/row size;
- total runtime and per-item timeout.

Use a bounded producer/consumer pipeline:

```text
source iterator
  -> bounded channel(batch capacity N)
  -> worker pool(concurrency C)
  -> ordered/unordered result policy
  -> sink batcher(size B, timeout T)
  -> committed receipt
  -> source checkpoint
```

Backpressure means the source pauses when downstream capacity is full. A streaming loop that appends every record to a profiling array is still unbounded. Inspect profiling and output stages as well as the source. Use bounded sketches, samples and writer batches when the full input need not remain in memory.

For RDF, flushing a graph at a configured batch limit bounds that graph. The sink still needs durable receipts and a recovery contract when committed output must survive interruption. Batching and durable publication solve different problems.

## Checkpoints and resume

A checkpoint means outputs through a stage are committed:

```ts
interface PipelineCheckpoint {
  runId: string
  stage: string
  stageVersion: string
  configDigest: string
  input: { sourceId: string; sourceVersion: string; position: string }
  outputReceipts: Array<{ sink: string; target: string; receipt: string; checksum?: string }>
  committedAt: string
}
```

Commit order:

```text
read batch
  -> transform
  -> write required output(s)
  -> inspect receipts and reconcile batch identities
  -> atomically commit checkpoint
  -> release source/batch
```

If the process dies after sink write but before checkpoint, replay occurs. Sinks need deterministic/version-aware idempotency. If checkpoint commits first, output can be permanently skipped; that ordering is invalid unless a stronger transaction spans both.

Resume preflight:

1. Load checkpoint and referenced receipts/artifacts.
2. Verify source identity/version and target still exist.
3. Verify stage/schema/config compatibility.
4. Validate last artifact/receipt/checksum.
5. Determine whether replay of the stage is safe.
6. Continue from the last committed position.
7. Reconcile before final completion.

## Multi-sink commit model

PostgreSQL, ClickHouse, Typesense, RDF/N-Triples/QLever, JSONL, and Parquet are separate commits unless proven otherwise. Track each sink:

```ts
type SinkState = {
  name: string
  required: boolean
  state: 'pending' | 'writing' | 'complete' | 'failed'
  targetVersion: string
  receipt?: string
  accepted: number
  rejected: number
  retryable?: boolean
}
```

Choose a policy:

- required all: run is incomplete until every required sink reconciles;
- optional degraded: run can complete but capability/failed sink stays visible with retry/operator action;
- staged authority then projections: authoritative load commits, run enters `projecting` until required projections complete;
- immutable build/cutover: build all versioned outputs, validate, then publish a final manifest/pointer.

Never print “complete” after a required sink error. Never use one global error count instead of per-stage/per-sink identity.

## Error and quarantine policy

Classify errors:

| Disposition | Use when | Durable evidence |
|---|---|---|
| retry item/batch | transient and replay-safe | identity, attempt, next time, safe cause code |
| quarantine | record invalid/unsupported but rest may proceed | raw identity, stage/version, safe issues, replay status |
| skip by policy | explicitly irrelevant | policy code and count |
| fail stage/run | contract/infrastructure/required sink compromised | last checkpoint, affected range, operator action |
| best-effort optional | non-required output | visible failed sink, retry/waive decision |

Broad `except Exception: pass` destroys the distinction. Cleaning failure followed by mapping can produce malformed downstream state; raw capture failure removes replay evidence; profile/Parquet/PostgreSQL failure can make the run incomplete. Decide each independently.

Do not include secrets or entire sensitive records in quarantine reasons. Store a safe raw-artifact reference and access-control classification.

## Configuration and capability model

Validate resolved pipeline configuration:

```yaml
pipeline:
  name: mediawiki-toys
  version: 3
  source:
    base_url: https://example.invalid/api.php
    page_size: 100
    rate_per_second: 1
    snapshot: revision-checkpoint
  execution:
    batch_size: 500
    concurrency: 4
    queue_capacity: 8
    item_timeout_ms: 30000
  artifacts:
    raw_required: true
    normalized_schema: toy.v3
  sinks:
    postgres: { required: true }
    typesense: { required: true, target: toys_v3 }
    parquet: { required: false }
```

Keep secret references out of manifests. Record a redacted resolved config digest. Distinguish unsupported capabilities from disabled ones and unavailable dependencies.

## Worker/runtime integration

Workers need:

- atomic lease/claim with owner and expiry;
- heartbeat for long batches;
- bounded attempt and backoff policy;
- idempotent stage/batch execution;
- acknowledgement only after commit receipt;
- dead-letter/quarantine and operator redrive;
- graceful shutdown: stop claiming, cancel/drain bounded work, release/expire leases;
- version compatibility between queued work and deployed worker;
- readiness that checks required store/schema/runtime.

If integrated with a workflow runtime, store stage/checkpoint facts in the chosen durable owner and use activities for side effects. Do not assume the runtime automatically makes an external bulk API, file append, or database write idempotent.

Choose the current activity/workflow package and selected history/dispatch owners for the recovery claim. In-memory replay can demonstrate instruction reuse; production persistence, atomic transitions, and cross-process recovery require their own implementations and executable evidence.

## Operational state and controls

Expose:

- run and stage state;
- last committed source/checkpoint;
- required/optional sink state;
- throughput, lag, retry/quarantine counts;
- current worker/lease and heartbeat;
- pause/cancel/retry/replay/repair actions;
- input/schema/config/runtime versions;
- links to safe artifacts and error summaries.

Cancellation is cooperative. Define whether current batch commits, rolls back, or is abandoned and replayed. Pause should stop new claims without losing committed progress. Replay should create a new run lineage or clearly record the relationship.

## Integration example

```text
schedule/operator/API trigger
  -> create durable run and freeze source ownership handoff
  -> worker leases discover stage
  -> fetch page and commit raw artifact
  -> decode/normalize bounded batch
  -> write authority transaction plus change identities
  -> write versioned projection batches
  -> inspect per-item receipts
  -> commit checkpoint
  -> continue until source ownership handoff exhausted
  -> reconcile all required sinks
  -> publish complete manifest and run status
```

## Failure and recovery

| Crash/failure window | Expected recovery |
|---|---|
| before run record | request may retry with idempotency key; no accepted claim |
| after run record before queue | reconciler enqueues visible orphan or marks failed |
| after raw capture before normalized output | replay parser from raw artifact |
| after sink write before checkpoint | replay same batch; sink returns already-applied/version wins |
| after checkpoint before acknowledgement | redelivery reads committed checkpoint and no-ops/continues |
| after one of several sinks | resume only incomplete sink from batch manifest |
| wait/cancel during batch | apply declared batch commit/abort policy and persist terminal state |
| new code sees old checkpoint | reject or run explicit migration/replay |
| required sink unavailable | remain incomplete with retry/backoff/operator visibility |
| optional sink waived | record operator/policy waiver; do not erase failure |

## Test matrix

Test:

- empty, one-item, batch edge, and input much larger than RAM;
- duplicate, out-of-order, late, malformed, and oversized source records;
- source pagination/revision changes and rate limiting;
- each stage schema/version/config mismatch;
- process loss before/after every receipt/checkpoint commit point;
- required and optional sink partial/batch failures;
- per-item bulk rejection;
- duplicate replay and old-version delivery;
- disk full, network timeout/reset, pool exhaustion, dependency restart;
- lease expiry, two workers, heartbeat loss, and redrive;
- cancellation/pause during fetch, transform, and sink write;
- graceful worker shutdown;
- quarantine access/redaction/replay;
- backfill racing live changes;
- final identity/count/hash/domain reconciliation;
- memory, file-descriptor, queue-depth, and latency limits.

## Executable verification

Use a disposable source fixture and real sink containers/services where feasible. Record a baseline run, kill the process at deterministic failpoints, restart, and compare authoritative/projection identities with the baseline. Require:

- no skipped committed input;
- no semantically duplicated effects;
- no final manifest before required sinks complete;
- bounded memory/concurrency;
- visible quarantines and failed optional sinks;
- safe cancellation/shutdown;
- successful targeted repair and full rebuild.

Run native queries against PostgreSQL/ClickHouse/Typesense/QLever and validate JSONL/Parquet manifests. Unit tests of a stage function are necessary but not sufficient.

## Deliberate exclusions

- Do not force Effect, Temporal, a queue, or a workflow engine for every pipeline.
- Do not call iterative code bounded if profiling/artifact writers retain all records.
- Do not advance checkpoints before required output receipts.
- Do not swallow required failures or collapse all sinks into one success bit.
- Do not promise exactly-once; prove idempotent/version-aware replay and reconciliation.
- Do not force Zod, LogTape, Drizzle, or particular sinks when the consumer selected alternatives.
- Do not treat a placeholder adapter/sink as implemented.
- Do not resume across incompatible code/schema/config silently.

## Sources and freshness

Public utility source: [`workflow`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts), [`streams`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/streams/mod.ts) and [`storage`](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/storage/mod.ts). These provide focused contracts, not a universal pipeline commit protocol. Treat the stage, receipt and recovery examples as application design requirements. Test bounded memory and crash windows in the selected engine and runtime.
