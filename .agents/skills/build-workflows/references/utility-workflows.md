# Selecting local Tasks and recorded workflow instructions

## Start from the guarantee

An ordinary async function is enough for bounded work whose caller needs only
the result. A local Task adds cooperative pause/resume/cancellation and terminal
settlement after cleanup. A workflow adds named instructions and reusable
recorded completions. Durable restart requires a persistent history and dispatch
owner plus replay-safe effects. Each level solves a different problem.

Make a concrete recommendation for the caller, not just a list of layers:

| Caller needs | Choose | What it does not add |
| --- | --- | --- |
| One bounded result | Ordinary value or Promise | Independent control or recorded recovery |
| Pause/cancel and joined local cleanup | Task | Restart persistence |
| Named instructions with reusable completions | Activity execution plus workflow/history/dispatch | Atomic external effects without a supporting store/sink contract |

`await task.done` returns the work's value only after owned cleanup completes;
work or cleanup failure rejects it. A status/event is observation, not that
terminal result. A cooperative checkpoint cannot preempt an indivisible call.

Do not infer durability from the word workflow, a retry loop, or two successful
executions in one process. Do not require a workflow engine for every async job.

## Current utility source model

The Okikio Utils packages separate Context, Task, Activity and Workflow.
Capability subpaths own resource, requirement and effect contracts.
`@okikio/capability/effect` announces consequences; it is distinct from the
third-party Effect TypeScript runtime.

```text
import-safe workflow/activity descriptions + exact implementations
  -> generator yields instruction
  -> scheduler checks history
       -> compatible completion: reuse
       -> new work: dispatch -> admitted executor/provider -> completion
  -> resume program -> validate result -> awaited owned cleanup
```

History records instruction outcomes, not live stack frames or provider sockets.
Dispatch owns admission/claim attempts. The provider owns actual side effects.
Placement selects eligible engines/hosts. Stable instruction and effect identity
must survive retries according to the selected version and input contract.

A memory dispatch/history composition demonstrates replay while those owners
live. Reconstructing a fresh process from durable stores is a separate proof, as is preventing duplication after a crash between an external
write and recording the instruction result.

## Distinct lifetimes and authority

Context supplies cancellation/deadline/clock/identity and scoped cleanup. A Task
checkpoint cooperates with pause; it does not stop an indivisible in-flight call.
Task `done` includes cleanup, while an observation event is not the answer.
Resource collections own their created clients; Tasks and activities borrow
them according to declared access, without independently closing shared values.

Effect announcements require acceptance by the chosen emitter. An effect owner
is not an optional telemetry sink, and an effect declaration is not proof of
durable delivery. Business mutation and acceptance need one authoritative
transaction/outbox if they must commit together. Reuse logical keys across
retries; do not substitute attempt identity for consequence identity.

## Select and verify the implementation

The source manifest for `@okikio/workflow` declares `/dispatch`, `/history`
and `/replay`; `@okikio/task` and `@okikio/scheduler` are separate packages.
Inspect the actual resolver, exports and tests before choosing a path. Use
`use-utils` for source identity and registry availability; a source version is
not evidence that a release can be installed.

Test only the layers affected by the claim: local checkpoint/control semantics;
recorded instruction compatibility; bounded parallelism; stale claim rejection;
cancellation and cleanup; fresh-owner reconstruction; crash-window atomicity;
and replay-safe sink behavior. Preserve source-level findings separately from
executed runtime or deployment evidence.

## Sources and limits

Checked 2026-11-26 at `32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`:
[Context](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/context/mod.ts), [Task](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/task/mod.ts),
[Activity](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/activity/mod.ts),
[Workflow](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts), and
[package exports](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/package.json).
These source contracts support the selection criteria. They do not certify a
registry release, durable database integration or deployed host.
