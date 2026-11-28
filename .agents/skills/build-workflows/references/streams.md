# Workflow event streams, cursors, and SSE projections

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution. Query parsing,
local Task control, recorded workflow instructions, and durable external
execution have distinct owners and guarantees. Inspect the selected package and
adapter; apply transaction, authorization, and recovery criteria to the actual
claim. Verify public exports in the resolved artifact and keep the consumer's existing
architecture when it already meets the task.


## Contents

- [Separate workflow history from public events](#separate-workflow-history-from-public-events)
- [Event and cursor contracts](#event-and-cursor-contracts)
- [Atomic publication](#atomic-publication)
- [Replay-to-live handoff](#replay-to-live-handoff)
- [Backpressure](#backpressure)
- [Cancellation and authority](#cancellation-and-authority)
- [Retention and compaction](#retention-and-compaction)
- [Tests and failure signatures](#tests-and-failure-signatures)

## Separate workflow history from public events

Engine history, operator timeline, domain events, and customer progress streams
serve different consumers:

| Stream | Authority/purpose | Audience |
|---|---|---|
| Engine history | Deterministic replay and platform operations | Engine/operators |
| Workflow timeline | Stable run inspection and repair | Product operators/support |
| Domain events | Business facts/integration | Services and external consumers |
| Progress stream | Safe product projection | Authorized user/browser |

Do not expose raw Temporal/Effect/custom-engine history through SSE. It can contain
internal names, payloads, errors, and implementation details and is not a stable
public contract. Project versioned safe events.

## Event and cursor contracts

```ts
export const RunEvent = z.object({
  event_id: z.string(),
  run_id: z.string(),
  organization_id: z.string(),
  sequence: z.int().nonnegative(),
  type: z.enum([
    "run.accepted.v1",
    "run.stage.v1",
    "run.warning.v1",
    "run.completed.v1",
    "run.failed.v1",
    "run.cancelled.v1",
  ]),
  occurred_at: z.iso.datetime(),
  data: z.record(z.string(), z.unknown()),
})
```

In a real implementation use a discriminated union so each event type owns a
precise payload. Public payloads exclude raw exceptions, SQL/provider bodies,
secrets, and unauthorized artifacts.

A cursor identifies a position within an authorized stream scope. Externally it
should be opaque and integrity-protected or server-validated. Internally it may
contain run ID, sequence, event ID, and schema version.

Cursor rules:

- resume strictly after cursor;
- stable event IDs make duplicates safely deduplicable;
- wrong-organization/run cursor rejects without existence disclosure;
- expired cursor produces explicit resync/reset behavior;
- cursor never advances for an event not durably committed and delivered/visible
  according to the selected client contract.

## Atomic publication

When the workflow/control plane and timeline share PostgreSQL, append the public
event in the same transaction as the state transition. Publish live delivery
from an outbox/change feed after commit.

```text
BEGIN
  update execution projection
  append operator timeline
  append public run event
  insert delivery outbox
COMMIT
```

If Temporal history is authoritative, derive product events through an Activity,
interceptor/visibility integration, or separate projection process with explicit
idempotency and repair. Do not perform an unrecorded external publish directly
from deterministic Workflow code.

## Replay-to-live handoff

Avoid loss between durable replay and live subscription:

1. authorize stream scope;
2. validate cursor;
3. subscribe or capture durable high-water mark;
4. read committed events after cursor through high-water;
5. begin live delivery strictly after high-water;
6. deduplicate by stable event ID if source overlap is possible.

An ephemeral pub/sub channel can wake a server, but it cannot be the only source
when replay is promised. On host restart, read from durable events.

## Backpressure

The workflow engine/control plane must not block on a browser connection. SSE is
a projection consumer with bounded queues.

Define:

- maximum serialized event size;
- per-connection buffer;
- connection/write timeout;
- organization/user connection limit;
- replaceable progress event coalescing;
- disconnect-and-resume policy;
- broker consumer lag limits;
- protection for terminal/audit events;
- maximum replay batch and rate.

Never hold an unbounded array of timeline history to serve a connection. Page or
stream durable reads. If a client is slow, disconnect with the last durable
cursor or coalesce explicitly replaceable progress; never drop terminal events
without replay.

## Cancellation and authority

There are two cancellations:

- delivery cancellation: browser disconnected; stop subscription/encoding;
- workflow cancellation: authorized durable command; engine/control plane must
  record and process it.

Do not couple them. A customer closing a tab should not cancel an import. A
workflow cancellation should emit requested/observed/terminal events as distinct
states where useful.

Every stream query applies server-owned organization/resource filters. A client
cannot subscribe to an arbitrary run ID merely because it knows it. Stream
tickets, if used, are short-lived and bound to subject, organization, run,
audience, and expiry.

## Retention and compaction

Set separate retention for engine history, operator timeline, public events, and
large diagnostic artifacts. Terminal run snapshots can allow public event
compaction while audit history remains longer.

If an old cursor falls outside retention:

- return an explicit resync problem; or
- send a versioned current snapshot/reset event and continue after its high-water.

Do not silently start from “now”; that makes the client believe it observed a
complete run.

## Tests and failure signatures

Test:

- committed transition and public event atomicity;
- API/publisher restart and durable replay;
- event inserted at replay/live handoff;
- duplicated outbox/broker delivery;
- cursor wrong scope, ahead, malformed, and expired;
- slow consumer and bounded memory;
- cancellation of delivery during replay/write;
- workflow cancellation while stream connected;
- terminal event and reconnect after completion;
- redaction and per-event authorization.

| Signature | Defect | Correction |
|---|---|---|
| UI status changes without event | Projection/event dual write | Atomic event/outbox |
| Stream loses event on reconnect | Pub/sub used as authority or handoff race | Durable events + high-water |
| Worker slows when client stalls | Workflow writes directly to socket | Async projection and bounded delivery |
| Closing tab cancels work | Delivery/domain cancellation conflated | Separate commands/scopes |
| Another tenant's cursor works | Cursor not scope-bound | Server validation and base filter |
| Replay leaks stack/provider data | Raw operator history exposed | Safe versioned projection |

## Sources and freshness

- HTML Living Standard SSE protocol:
  https://html.spec.whatwg.org/multipage/server-sent-events.html (primary source,
  checked 2026-07-17).
- Temporal visibility/history and TypeScript workflow documentation:
  https://docs.temporal.io/develop/typescript and https://docs.temporal.io/visibility
  (primary sources; raw history is not treated as a public contract).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/streams/events.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
