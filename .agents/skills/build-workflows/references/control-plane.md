# Workflow control plane and reachability

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [Responsibilities](#responsibilities)
- [Definition and registration](#definition-and-registration)
- [Start and admission](#start-and-admission)
- [State and timeline](#state-and-timeline)
- [Public commands](#public-commands)
- [Reachability](#reachability)
- [Capability status](#capability-status)
- [Tests and failure signatures](#tests-and-failure-signatures)

## Responsibilities

A custom control plane can own:

- definition and runtime registration;
- direct, event, webhook, delayed, schedule, and workflow-invoke triggers;
- input validation and deterministic logical identity;
- idempotency and admission policy;
- durable execution projection and immutable timeline;
- ready queue, leases, retries, waits, signals, cancellation, replay;
- runtime adapter calls and reconciliation;
- operator APIs and safe product status.

Do not make it a generic dumping ground for domain code. Business workflow
definitions remain with the owning service; the control plane provides durable
coordination primitives.

## Definition and registration

A definition needs:

- unique name and owning service;
- semantic version and input/result schemas;
- runtime workflow value/type;
- supported triggers;
- idempotency and flow-control policy;
- retry/cancellation/observability policy;
- task queue/driver requirements;
- product status/cancel/event route ownership.

At process startup compare definition, registration, and runtime catalogs. Reject
duplicate names, unsupported schema/driver versions, missing runtime values, and
workflow definitions whose required worker is unavailable when API readiness
depends on it.

Dynamic TypeScript callbacks for keys/filters are inspectable and type-safe but
are code-version dependent. Persist the resolved key and relevant policy version
for each admitted run. Do not attempt to re-evaluate an old key under changed
code during recovery.

## Start and admission

One `startWorkflow` transaction should conceptually:

1. validate workflow name and input schema;
2. compute organization/scope and resolved policy keys;
3. compute idempotency key/fingerprint and logical execution ID;
4. atomically return existing or reject conflicting key;
5. evaluate singleton/rate/throttle/debounce/batch/concurrency policy;
6. persist execution, initial timeline, and ready/delayed intent;
7. return accepted product URLs/status.

Flow controls are different:

| Policy | What it limits/changes | Collision behavior |
|---|---|---|
| Idempotency | Duplicate same logical request | Reuse or conflict |
| Concurrency | Active slots | Queue until slot |
| Throttle | Starts per period | Delay excess |
| Rate limit | Accepted operations per period | Reject/skip excess |
| Debounce | Burst where latest should win | Replace/postpone candidate |
| Batch | Events collected into one input | Close on size/window |
| Singleton | At most one active per key | Skip, return existing, or cancel existing |
| Priority | Ordering among runnable items | Does not bypass authorization/capacity |

Specify scope (tenant/workflow/resource/global), time model, atomic store
primitive, and whether waiting runs count. Do not implement admission as an
unlocked count followed by insert.

If engine start occurs after a PostgreSQL acceptance transaction, an accepted
record can exist without engine start. Queue an idempotent start command and run
a reconciler. If engine start occurs first, a started engine run can lack the
projection. Define the reverse repair. Avoid direct dual write from the HTTP
request without durable intent.

## State and timeline

Use explicit execution states and allowed transitions. Track cancellation request
separately from terminal cancellation. Record attempt, current step, worker/lease,
next retry, wait, result/error references, and timestamps.

Timeline entries are append-only and ordered per execution. Include:

- unique event/timeline ID and atomic sequence;
- kind, step/activity, attempt, actor/cause;
- workflow/runtime/build version;
- safe structured detail and artifact references;
- occurred and recorded timestamps;
- correlation/trigger/repair identity.

Do not allocate sequence with collection length. Do not mutate history to hide a
repair; append a compensating/recovery event and update the projection.

## Public commands

Product services own routes and authorization. Shared handlers can translate to
the control-plane API, but must not expose arbitrary workflow names or tenant IDs.

Typical commands:

- start one authorized product operation;
- get status and safe result;
- list timeline/progress;
- request cancellation;
- send a validated signal/update;
- resume only where product/operator policy permits;
- list service-supported workflows for operators;
- replay/retry/repair under elevated authorization.

Return 202 only after durable acceptance. Include stable status/cancel/events
links. Do not expose internal error payloads when a workflow's observability
policy disables them.

## Reachability

Trace:

```text
product HTTP/CLI definition
  -> auth and organization policy
  -> control-plane start/signal/cancel
  -> durable execution/timeline/queue intent
  -> active queue/scheduler/wait/recovery loop
  -> reachable runtime adapter/engine
  -> compatible worker registration
  -> activity/effect
  -> projection/result/public stream
```

Exercise the active deployed path. A worker loop that returns zero, an adapter
that reports unsupported, or a route still wired to a legacy dispatcher breaks
reachability even if the new types/tests exist.

## Capability status

Represent runtime capability honestly:

```ts
export const WorkflowRuntimeCapability = z.object({
  driver: z.string(),
  durable: z.boolean(),
  can_start: z.boolean(),
  can_poll: z.boolean(),
  can_signal: z.boolean(),
  can_resume: z.boolean(),
  registered_workflows: z.array(z.string()),
  worker_reachable: z.boolean(),
})
```

Do not derive `durable: true` from a driver name. Production readiness should
depend on configured driver, migrations, adapter operations, registration, and
worker/engine reachability.

## Tests and failure signatures

Test:

- duplicate definitions/registrations and unknown workflows;
- every trigger and input version;
- concurrent idempotency/admission keys;
- all flow-control policies under concurrency and time advancement;
- atomic initial state/timeline/ready intent;
- engine-start/projection failure in both directions;
- public auth/org interfaces and safe result/error policy;
- worker absent/incompatible readiness;
- legacy route detection and actual runtime effect;
- operator recovery and audit timeline.

| Signature | Defect | Next proof |
|---|---|---|
| Definition lists workflow but start says unknown | Catalogs drift | Startup catalog equality |
| API returns 202 but queue empty | Acceptance not atomic | Transaction and restart test |
| Two singleton runs start | Check-then-insert policy | Constraint/lock/engine primitive |
| Status stays pending after completion | Projection reconciliation missing | Engine-authority reconciler |
| Driver says SQL but every method unsupported | Name mistaken for capability | Capability gate |
| New control plane has no traffic | Legacy endpoint wiring | Deployed request trace |

## Sources and freshness

- Temporal TypeScript documentation: https://docs.temporal.io/develop/typescript
  and Effect workflow source: https://github.com/Effect-TS/effect/tree/main/packages/workflow
  (primary sources; adapter semantics remain engine/version-specific).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/workflow/mod.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
