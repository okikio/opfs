# Recovery, checkpoints, leases, replay, and repair

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [Recovery model](#recovery-model)
- [Leases and heartbeats](#leases-and-heartbeats)
- [Checkpoints and resume](#checkpoints-and-resume)
- [Retry, replay, resume, and repair](#retry-replay-resume-and-repair)
- [Recovery controller](#recovery-controller)
- [Operator control plane](#operator-control-plane)
- [Recovery drills](#recovery-drills)
- [Failure signatures](#failure-signatures)

## Recovery model

For each state answer:

- What failure can leave work here?
- Is forward progress automatic, timed, or operator-triggered?
- Which durable fact authorizes recovery?
- How is concurrent recovery prevented?
- Can the previous attempt still finish late?
- Which effects are safe to repeat?
- What evidence proves successful recovery?
- When does the run become `requires_attention`?

Recovery is not “retry on exception.” It includes abandoned leases, process
loss, delayed/missing messages, ambiguous external effects, incompatible
checkpoints, stale projections, partial sinks, poisoned input, and broken
deployments.

## Leases and heartbeats

A lease record should contain:

- item/execution identity;
- owner and worker build/version;
- acquired and expiry timestamps;
- attempt and fencing token/generation;
- heartbeat/progress timestamp;
- last safe error/phase;
- cancellation state.

Claim atomically. Use a fencing token when a late old owner could still write
after expiry: downstream commits reject stale generations.

Choose lease duration from maximum heartbeat interval plus operational jitter,
not average runtime. Heartbeat frequently enough to recover promptly but not so
frequently that the store becomes the bottleneck.

On shutdown stop claims, request cancellation, heartbeat/drain within a deadline,
and release leases only when the activity is definitely stopped. Releasing while
the old work continues creates concurrent effects.

## Checkpoints and resume

A checkpoint describes committed progress:

```ts
export const Checkpoint = z.object({
  run_id: z.string(),
  stage: z.string(),
  stage_version: z.string(),
  input_identity: z.string(),
  input_hash: z.string(),
  partition: z.string().nullable(),
  committed_cursor: z.string(),
  output_manifest_id: z.string(),
  output_hash: z.string(),
  schema_version: z.string(),
  committed_at: z.iso.datetime(),
})
```

Resume procedure:

1. load the latest committed checkpoint for the logical stage/partition;
2. validate input identity/hash and schema/stage compatibility;
3. verify referenced output manifest/artifacts exist and hashes match;
4. reconstruct state from committed output, never process memory;
5. resume strictly after the committed cursor;
6. preserve deduplication for a partially repeated batch;
7. create a new attempt with provenance pointing to the checkpoint;
8. write the next checkpoint only after output commit.

Never advance a checkpoint before sink commit. Never resume by line count alone
when input can change. For multiple sinks, checkpoint each sink or advance the
stage only after every required sink is committed.

## Retry, replay, resume, and repair

| Operation | Meaning | Identity behavior |
|---|---|---|
| Retry | Reattempt a failed effect/stage under same logical operation | New attempt, same idempotency key |
| Resume | Continue after committed checkpoint/wait | Same logical run, new attempt/lease |
| Replay | Reprocess retained input/history under declared code/policy | New replay ID; preserve source run |
| Redrive | Move dead-letter/terminal work back to ready after decision | New attempt, audited operator action |
| Repair | Reconcile authoritative systems and apply targeted correction | Repair ID and before/after evidence |
| Backfill | Process historical range not previously required | New bounded campaign identity |

Do not use these words interchangeably in APIs or dashboards. A replay may
intentionally use new code; a workflow-history replay often must reproduce old
commands. Name which one.

## Recovery controller

Automated recovery scans should be bounded, indexed, leased, observable, and
idempotent. Typical detectors:

- ready item unclaimed beyond SLA;
- expired lease;
- running execution without live engine/lease evidence;
- cancellation requested beyond grace period;
- due timer/wait without resume item;
- retry scheduled but no ready item;
- completed engine run with nonterminal projection;
- required sink/checkpoint missing;
- outbox unpublished beyond threshold;
- orphaned artifact/temp file.

Use compare-and-set/state preconditions so a recovery action does not overwrite a
late legitimate transition. Append recovery events to the timeline.

## Operator control plane

Provide authorized operations with dry-run/preview where risk warrants:

- inspect input, history/timeline, attempts, waits, leases, outputs, and errors;
- request cancel and observe completion;
- pause/resume schedule or run;
- retry eligible failed stage/activity;
- redrive poison work after correction;
- replay a bounded set with rate/concurrency controls;
- reconcile one execution or indexed cohort;
- override/skip/compensate with reason and approval;
- quarantine input/artifact;
- terminate only as last resort.

Every mutation records actor, reason, request/correlation ID, before/after state,
affected version, and resulting operation ID. Scope authorization by tenant and
operator role. Do not expose raw secret-bearing inputs/errors.

## Recovery drills

- SIGKILL worker immediately before and after heartbeat.
- Pause network between worker and store/engine.
- Let a lease expire while the old worker later returns.
- Corrupt/delete a checkpoint artifact.
- Change input under the same filename/path.
- Kill after sink commit before checkpoint.
- Make one of several sinks unavailable.
- Deliver a signal at the same time as timeout and cancellation.
- Deploy incompatible worker then rollback.
- Exhaust retry budget and redrive after repair.
- Run reconciler concurrently twice.
- Restore from backup and reconcile platform/domain state.

Assert one logical outcome, bounded duplicate work, no duplicate external
consequence, visible audit evidence, and a finite terminal/manual state.

## Failure signatures

| Signature | Defect | Correction |
|---|---|---|
| Lease expired but two workers commit | No fencing/idempotency | Generation check and effect key |
| Resume duplicates prior output | Checkpoint marks attempted input | Commit output before checkpoint |
| Resume accepts changed input | No input identity/hash | Compatibility preflight |
| Reconciler oscillates state | No authority/CAS | Directional authority and preconditions |
| Replay floods provider | No campaign admission limit | Bounded replay planner |
| Operator “retry” creates new business operation | Logical identity lost | Explicit retry semantics |
| Terminal run has no diagnosis | Poison state stores only string | Safe structured cause and artifacts |
| Cleanup assumes finalizer ran | Hard-kill path ignored | Lease expiry/orphan scan |

## Sources and freshness

- Temporal TypeScript testing and replay guidance:
  https://docs.temporal.io/develop/typescript/testing-suite and
  https://docs.temporal.io/develop/typescript/debugging (primary sources;
  verify current SDK tooling).
- PostgreSQL locking documentation: https://www.postgresql.org/docs/current/explicit-locking.html
  (primary source; fencing and checkpoint schemas are application design).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
