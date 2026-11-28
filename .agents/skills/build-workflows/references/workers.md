# Workers, queues, schedules, waits, and flow control

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [Worker process contract](#worker-process-contract)
- [Atomic queue claims and leases](#atomic-queue-claims-and-leases)
- [Retry and poison work](#retry-and-poison-work)
- [Timers and schedules](#timers-and-schedules)
- [Waits, signals, and updates](#waits-signals-and-updates)
- [Backpressure and fairness](#backpressure-and-fairness)
- [Cancellation and shutdown](#cancellation-and-shutdown)
- [Observability](#observability)
- [Tests and failure signatures](#tests-and-failure-signatures)

## Worker process contract

The worker entrypoint owns:

- validated environment-specific config;
- database/queue/engine connections;
- exact workflow/activity catalog;
- queue/task-queue names and build/version identity;
- loop supervision and failure policy;
- concurrency, rate, lease, heartbeat, polling, and batch settings;
- health/readiness and graceful shutdown;
- logs, traces, metrics, and secret redaction.

Worker readiness requires a compatible catalog and active pollers/loops against
the intended queue/engine. A boot function returning `{ loops: [] }` or a process
blocked before registration is not ready.

Separate worker deployments by permissions and scaling profile when appropriate:
CPU-heavy parsing, network crawling, payment effects, and lightweight timers
should not necessarily share one queue or credentials.

## Atomic queue claims and leases

Use one atomic claim primitive. PostgreSQL example:

```sql
with candidates as (
  select queue_item_id
  from workflow_ready_queue
  where status = 'ready' and available_at <= now()
  order by priority asc, available_at asc, queue_item_id asc
  for update skip locked
  limit $1
)
update workflow_ready_queue q
set status = 'leased',
    lease_owner = $2,
    lease_expires_at = now() + $3::interval,
    attempt = attempt + 1,
    fencing_token = fencing_token + 1
from candidates c
where q.queue_item_id = c.queue_item_id
returning q.*;
```

Parameterize safely; SQL is illustrative. Stable ordering needs a tie-breaker.

Lease semantics:

- owner uniquely identifies worker process/build;
- expiry is durable and based on database/engine time where possible;
- heartbeat extends only a still-owned generation;
- completion/ack requires matching owner/fencing token;
- expired work becomes recoverable;
- a late worker cannot commit after takeover;
- effect idempotency still protects external consequences.

## Retry and poison work

Classify before retry:

| Failure | Examples | Action |
|---|---|---|
| Invalid/permanent | Schema, unsupported version, auth/policy | Quarantine/fail, no retry |
| Transient | 503, connection loss, lock timeout | Backoff/jitter within budget |
| Rate limited | 429/provider quota | Honor reset/retry-after and global budget |
| Ambiguous | Timeout after possible commit | Reconcile by operation key |
| Defect | Invariant/code bug | Fail/alert; retry only after rollout/decision |
| Cancellation | User/operator/shutdown | Cooperative terminal/requeue policy |

Persist attempt count, next available time, safe structured last error, and
history. Move exhausted/permanent work to a visible dead-letter/quarantine state
with inspect, correct, and redrive commands. Do not retry malformed poison work
forever.

Coordinate retry budgets across engine, queue, Activity, HTTP client, and
provider SDK. Nested retries can multiply load and exceed business deadlines.

## Timers and schedules

Differentiate:

- durable one-shot delay;
- workflow timer/wait timeout;
- fixed interval;
- calendar/cron schedule;
- backfill/replay campaign.

Schedule contract includes timezone, daylight-saving behavior, overlap, missed
runs, catch-up window, jitter, pause/resume, backfill, start identity, and
cancellation.

Do not compute cron behavior with an interval helper. Require an explicit
calendar/timezone implementation or reject the unsupported schedule. Use a tested
parser or platform and test daylight-saving transitions.

Publishing a due schedule and advancing `next_run_at` must be atomic or
reconciled. Stable schedule-occurrence IDs deduplicate repeat scans.

## Waits, signals, and updates

Wait record:

- wait ID, execution ID, name/type, schema version;
- authorization scope and correlation key;
- created/timeout timestamps;
- resume token/engine identity;
- active/resolved/timed-out/cancelled state;
- winning message/event ID and payload reference;
- buffered signal policy.

Signal procedure:

1. authenticate/authorize sender and execution scope;
2. validate message version/payload;
3. deduplicate signal ID;
4. find eligible wait or buffer according to contract;
5. atomically choose winner against timeout/cancel;
6. enqueue/complete engine resume and append timeline;
7. acknowledge acceptance versus processed result accurately.

Do not lose early signals that arrive before a wait unless the contract explicitly
rejects them. Bound buffered signals and retention.

Queries are read-only. Signals are accepted asynchronous state changes. Updates
can return an accepted/processed result in engines such as Temporal. A custom
control plane must define its own semantics rather than using the names loosely.

## Backpressure and fairness

Control:

- global and per-worker concurrency;
- per-tenant/workflow/resource slots;
- provider concurrency/rate;
- queue depth and admission shedding;
- claim batch and prefetch;
- memory/open files/connections;
- priority aging/starvation prevention;
- parked runs versus active slots;
- replay/backfill budgets separated from live traffic.

Concurrency limits active execution; a durable wait normally should not consume
an active worker slot. Store enough state to reacquire admission fairly on resume.

Avoid prefetch larger than workers can heartbeat/process within lease duration.
Measure queue wait, runnable age, schedule-to-start, active slots, retry rate,
tenant fairness, provider saturation, and oldest poison item.

## Cancellation and shutdown

Cancellation states can include requested, observed, compensating/cleanup, and
terminal cancelled. Workers check cancellation before new effects and at safe
points in long work. Heartbeats can deliver cancellation in engines that support
it.

Shutdown:

1. mark worker unready;
2. stop claims/polls;
3. request interruption of in-flight work where safe;
4. drain within deadline while heartbeating owned leases;
5. acknowledge completed effects and persist checkpoints;
6. leave/release remaining work according to engine contract;
7. flush telemetry and close resources.

Never release a lease while its old effect can still commit without fencing.

## Observability

Per work item record queue wait, lease owner/generation, workflow/run, activity,
attempt, retry delay, deadline, cancellation, worker build, safe cause, and
result/checkpoint identity. Correlate with originating request/event and tenant
without leaking payloads.

Alert on no pollers, expired leases, oldest runnable age, retry storms, dead
letters, stuck cancellation, due timers, unprocessed signals, worker loop exit,
and downstream saturation.

## Tests and failure signatures

- Run two workers claiming the same queue under load.
- Kill after claim, effect commit, checkpoint, and ack.
- Let a late old owner commit after lease takeover; fencing must reject it.
- Test retry classes, `Retry-After`, budgets, and poison redrive.
- Exercise interval/cron timezone, DST, missed/overlap/catch-up behavior.
- Race signal, timeout, cancellation, duplicate, and early signal.
- Saturate one tenant/provider and verify fairness/backpressure.
- Shutdown with idle, queued, running, waiting, and heartbeating work.

| Signature | Defect | Correction |
|---|---|---|
| Same item leased twice | Read/update race or expiry error | Atomic claim + generation |
| Old worker overwrites new result | No fencing/CAS | Generation-bound commit |
| Cron drifts or doubles at DST | Interval/naive local-time math | Calendar/timezone engine |
| Signal accepted but run never wakes | Non-atomic wait/resume | Transaction/reconciler |
| Queue grows while CPU idle | Admission/worker settings contradict | End-to-end capacity audit |
| One tenant starves others | Global FIFO only | Scoped limits/fair scheduling |
| Worker “ready” with dead loop | Readiness ignores supervision | Loop health policy |

## Sources and freshness

- PostgreSQL `SELECT ... FOR UPDATE`/`SKIP LOCKED` documentation:
  https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE
  (primary source, checked 2026-07-17).
- Temporal TypeScript Worker documentation: https://docs.temporal.io/develop/typescript/workers
  (primary source; exact tuning/versioning options are SDK-version-sensitive).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/worker/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
