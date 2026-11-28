# Compose observed, local and durable work

Choose the recovery requirement before the library. A display subscription,
one running operation and a saved workflow have different owners and failure
modes. The public [okikio/utils source](https://github.com/okikio/utils/tree/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7)
provides focused contracts; [adoption](../../use-utils/references/adoption.md)
explains why source versions alone do not establish installable releases.

## Select by what must survive

| Requirement | Candidate | Required evidence |
| --- | --- | --- |
| Observe local changes | `@okikio/observables` | Buffer/error policy, unsubscribe and producer ownership |
| Current progress value | `@okikio/context/state` | One writer, read-only observations and disposed subscriptions |
| Cancellation/deadline/cleanup | `@okikio/context` | Cooperative stop and joined owned cleanup |
| Pause/resume one local operation | `@okikio/task` | Checkpoints and settlement after cleanup |
| Named checked work on a selected engine | `@okikio/activity` | Resource ownership, placement and engine acceptance |
| Replay recorded steps | `@okikio/workflow` | Stable identity, compatible history, selected dispatch and executor |
| Recover after process loss | Explicit durable storage/queue/outbox adapter | Fresh process, claim fencing, replay and external-effect policy |

Use [utility lifetime and workflow contracts](../../use-utils/references/workflows.md)
for exact APIs. Do not reuse a historical private workflow control plane merely
because its name resembles the current package. The third-party `effect` and
`@effect/workflow` libraries have their own versions and contracts; utility
`capability/effect` is a required-announcement protocol, not that runtime.

## Keep control and observation separate

An Observable subscription owns its observation, not the database, process or
socket that emits values. Unsubscribing does not automatically revoke accepted
work. State cells own writes; projections own subscriptions. Progress is a
latest-value report unless an actual log contract guarantees replay.

Task pause/resume is cooperative. Cancellation signals a lifetime; it is not
proof that arbitrary provider work stopped. Await `done` and the relevant
resource receipts before claiming cleanup. If callers need a shared close
receipt, use a joined owner such as `dispose.once()` rather than repeated
`AsyncDisposableStack.disposeAsync()` calls.

## Trace durable acceptance

Write down the owner and receipt for each transition:

1. Business state and required announcement are accepted.
2. A worker claims an attempt under an expiry/fencing rule.
3. The provider performs an effect under a stable logical identity.
4. Completion is recorded so later replay can reuse it.
5. Cancellation, retry or repair reconciles uncertain outcomes.

A queue does not make an arbitrary provider effect exactly-once. A transaction
covers only its actual participants. Use an outbox when the business mutation
and announcement must commit together, then give delivery explicit retry,
deduplication and retention rules. Preserve logical effect identity across
attempts; a new retry number is not a new business action.

Define version/input compatibility before replay. Changing a definition's code
or schema without changing its stable ID does not prove old history is valid.
Persisted state, workflow history and optional telemetry remain separate facts.

## Test the specific recovery claim

For local work, use explicit signals and logical clocks to test checkpoints,
concurrent cancellation and cleanup failure. For durable work, kill the process
at the relevant handoff and start a fresh owner against the real adapter.
Exercise duplicate and stale claims, provider ambiguity, retries, changed
inputs/versions, compensation and operator repair.

A type check or in-memory test cannot prove PostgreSQL atomicity, multi-worker
fencing or provider idempotency. Follow
[build-workflows](../../build-workflows/SKILL.md) for design and the final verdict.

## Sources and freshness

Checked 2026-11-26 at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`:
[Context](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/context/mod.ts), [Task](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/task/mod.ts),
[Activity](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/activity/mod.ts), [Workflow](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts),
[dispatch](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/dispatch.ts),
[history](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/history.ts), and
[storage export map](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/storage/package.json).
See [Observables](observables.md) for that standalone library's versioned
subscription and operator contract.
