# SSE and streaming API contracts

## Select the utility owner

Use `use-utils` when the consumer selects the public `okikio/utils` contracts. Verify source or release resolution and read the
service reference for definitions, compilation, and Fetch runtime ownership.
The rules below apply to the selected implementation, not a required app layout.
Hono validation examples apply only to a Hono-owned validation path; compiled
services supply validated `input` and their own rejection contract. Verify each example against the resolved artifact before implementation.


## Contents

- [When SSE fits](#when-sse-fits)
- [Authority and event identity](#authority-and-event-identity)
- [Wire contract](#wire-contract)
- [Connection procedure](#connection-procedure)
- [Replay and cursors](#replay-and-cursors)
- [Backpressure and slow consumers](#backpressure-and-slow-consumers)
- [Cancellation and cleanup](#cancellation-and-cleanup)
- [Authentication and authorization](#authentication-and-authorization)
- [Proxies, heartbeats, and deployment](#proxies-heartbeats-and-deployment)
- [Failure signatures](#failure-signatures)
- [Tests and verification](#tests-and-verification)

## When SSE fits

Use Server-Sent Events for an ordered server-to-client event feed over HTTP when
the browser does not need bidirectional frames on the same connection. Common
cases include workflow timelines, import progress, report completion, and
monitoring updates.

Choose another mechanism when:

- the client must stream substantial data to the server;
- bidirectional low-latency messages are fundamental;
- binary frames are required;
- a durable broker subscription, not an HTTP projection, is the public contract;
- polling is simpler and meets latency/load requirements.

SSE is a delivery transport, not durability. A durable event/timeline store must
exist if reconnect and replay are promised.

## Authority and event identity

Before writing an endpoint, specify:

- authoritative event source: append-only timeline, outbox, engine history, or
  ephemeral pub/sub;
- stream scope: workflow run, organization, user, or filter;
- monotonically ordered cursor within that scope;
- retention and replay window;
- event schema/version;
- visibility policy for every event;
- behavior when cursor is unknown, expired, from another scope, or ahead.

Prefer an opaque cursor externally even if the implementation currently uses a
timeline sequence. Bind or validate the cursor against the authorized scope so a
cursor cannot move a client into another organization's stream.

## Wire contract

An SSE response uses `text/event-stream`. Each event is separated by a blank
line; multiline data uses one `data:` line per line. Keep JSON payloads on one
serialized line when possible:

```text
id: eyJydW5faWQiOiJydW5fMTIzIiwic2VxIjo0Mn0
event: workflow.progress.v1
data: {"run_id":"run_123","stage":"detect","completed":120,"total":500}

```

Define a stable envelope:

```ts
export const WorkflowStreamEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("workflow.progress.v1"),
    sequence: z.int().nonnegative(),
    occurred_at: z.iso.datetime(),
    data: z.object({ stage: z.string(), completed: z.int(), total: z.int().nullable() }),
  }),
  z.object({
    type: z.literal("workflow.completed.v1"),
    sequence: z.int().nonnegative(),
    occurred_at: z.iso.datetime(),
    data: z.object({ result_url: z.string().url().optional() }),
  }),
])
```

Do not send internal engine records, raw errors, secrets, or unrestricted result
payloads merely because the stream is authenticated.

## Connection procedure

Use this ordering to avoid a subscribe/replay race:

1. authenticate and authorize the requested stream scope;
2. validate cursor and filter;
3. establish the live subscription or capture a high-water mark;
4. replay `(cursor, high-water]` from the durable source;
5. forward live events after the high-water mark;
6. emit periodic heartbeat comments if infrastructure needs them;
7. close after terminal state when the contract is run-scoped, or remain open for
   an explicitly continuous feed.

The exact subscribe-before-replay algorithm depends on the event source. The
invariant is no event lost between the replay query and live subscription.

Pseudo-implementation:

```ts
return streamSSE(c, async (stream) => {
  const scope = await authorizeRun(c, c.req.param("run_id"))
  const cursor = await cursors.parse(c.req.header("Last-Event-ID"), scope)

  await using subscription = await events.subscribe(scope)
  const highWater = await events.highWater(scope)

  for await (const event of events.replay(scope, cursor, highWater)) {
    await stream.writeSSE(encode(event))
  }

  for await (const event of subscription.after(highWater)) {
    await stream.writeSSE(encode(event))
    if (event.terminal) break
  }
})
```

Treat `await using` and helper names as illustrative. Implement cleanup using the
runtime/framework's real APIs.

## Replay and cursors

Browsers can send the last received ID as `Last-Event-ID` when reconnecting. A
custom client may use an explicit query/header cursor. Pick one public contract
and document precedence rather than accepting conflicting cursors silently.

Cursor decisions:

| Condition | Recommended behavior |
|---|---|
| No cursor | Start at current snapshot/high-water or retained beginning, as documented |
| Valid cursor | Replay strictly after it |
| Cursor belongs to another scope | Reject without revealing that scope |
| Expired cursor | Return explicit 409/410 resync problem or emit a reset event |
| Cursor ahead of high-water | Reject as invalid |
| Duplicate delivery after reconnect | Client deduplicates by event ID; server maintains stable IDs |

If state snapshots are cheaper than full history, send a versioned snapshot and
then events after its high-water mark. Do not call an ephemeral “current status”
query replay.

## Backpressure and slow consumers

Bound every queue between the durable source and socket. A slow browser must not
cause unbounded process memory.

Define:

- per-connection queue capacity;
- per-organization connection and throughput limits;
- maximum event size;
- write timeout;
- slow-consumer behavior: disconnect with resumable cursor, coalesce replaceable
  progress events, or drop explicitly non-authoritative heartbeats;
- fairness between consumers;
- retention pressure and compaction behavior.

Never drop terminal, audit, or state-transition events without a durable replay
path. Progress samples may be coalesced only when the public contract says they
are replaceable and the eventual authoritative state remains available.

## Cancellation and cleanup

Client disconnect cancels delivery, not necessarily the underlying workflow.
Expose workflow cancellation as an authorized explicit command.

On stream cancellation:

- detach broker/listener subscriptions;
- interrupt pending replay reads and heartbeat fibers;
- release database cursors and timers;
- stop writes immediately;
- record metrics without logging routine disconnects as server failures;
- preserve the last durable cursor, not an optimistic unsent cursor.

Connect `Request.signal` or the framework disconnect hook to the scoped stream
program. Test cancellation while replay is blocked and while a write is blocked.

## Authentication and authorization

Authenticate before opening the stream. Re-authorize the requested run/resource
against server-owned organization membership. Decide whether long-lived streams
must revalidate session/membership during the connection or only on reconnect.

Avoid bearer tokens in query strings because URLs leak into history, logs, and
referrers. Browser `EventSource` has header constraints; prefer same-origin secure
cookies, a short-lived scoped stream ticket, or a fetch-based SSE client where
custom authorization headers are required.

Bind stream tickets to user, organization, resource, expiry, and one intended
audience. A ticket is not a general API token.

## Proxies, heartbeats, and deployment

Verify the real host and every proxy/CDN hop supports streaming without buffering.
Configure:

- response buffering disabled;
- idle timeout longer than heartbeat interval;
- compression behavior tested (some stacks buffer compressed chunks);
- cache disabled;
- connection limits and HTTP protocol behavior;
- deploy/drain behavior for active streams;
- sticky routing only if the live source truly requires it.

Use comment heartbeats such as `: keep-alive\n\n` when needed. Heartbeats prove
connection liveness, not workflow progress, and should not advance the durable
cursor.

## Failure signatures

| Signature | Likely defect | Correction |
|---|---|---|
| Reconnect misses one event | Replay/live subscription race | High-water handoff |
| Memory grows per client | Unbounded delivery queue | Capacity and slow-consumer policy |
| Duplicate progress after reconnect | IDs unstable or replay inclusive | Stable ID and strictly-after cursor |
| Another org's events appear | Cursor/scope not bound to authorization | Scope-aware cursor and base filter |
| Stream works locally, batches in production | Proxy buffering/compression | End-to-end host test |
| Workflow cancels when browser closes | Transport and domain cancellation conflated | Explicit workflow cancel command |
| DB connections never return | Subscription/cursor not scoped | Disconnect finalizer test |
| `Last-Event-ID` accepted from wrong run | Opaque cursor decoded without scope check | Reject safely |

## Tests and verification

- Parse every emitted event against its versioned schema.
- Connect without auth, with expired auth, and across organizations.
- Replay from every retained cursor checkpoint and from expired/ahead/wrong-scope
  cursors.
- Inject an event at the replay/live handoff and prove it arrives once or is
  safely deduplicable.
- Stall reads and verify memory remains bounded and policy activates.
- Disconnect during replay, live wait, heartbeat, and blocked write; assert all
  resources close.
- Test terminal events and whether the stream closes as documented.
- Run through the production proxy/CDN with buffering and timeouts observed.
- Restart the API host and prove durable replay still works.

## Sources and freshness

- HTML Living Standard, server-sent events: https://html.spec.whatwg.org/multipage/server-sent-events.html
  (primary protocol source, checked 2026-07-17).
- Hono streaming helper documentation: https://hono.dev/docs/helpers/streaming
  (primary framework source; verify selected runtime adapter behavior).
- Public utility source: [contract at the pinned revision](https://github.com/okikio/utils/blob/32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7/packages/streams/events.ts). Source availability is separate from release availability; inspect the selected consumer adapter and test its claimed behavior.
