`@utils/queue`
==============

Purpose
-------

`@utils/queue` defines a generic claimed-work queue and provides a process-local
implementation for tests, simulations, and local composition.

The queue contract covers admission, priority, delayed availability, claims,
claim renewal, completion, failure, retry, cancellation, result waiting, and
queue events.

Concrete durable adapters such as SQLite or Redpanda belong in `packages/`.


How it fits
-----------

`@utils/context` supplies the owner identity, cancellation, deadline, and clock
used by queue operations.  `@utils/failure` supplies durable expected failures
when a queue item completes unsuccessfully.

Workflow persistence can use a queue implementation, but this package does not
implement the iterator workflow interpreter or durable workflow journal.


Claim contract
--------------

An enqueued item can become claimable immediately or at a future instant.  A
claim has one owner and an expiry time.

Only the current claim owner can renew, complete, fail, retry, or cancel claimed
work.  A stale owner receives `StaleClaimError` rather than silently changing
the item.

Expired claims become available again.  Waiting consumers wake when work is
enqueued, delayed work becomes available, a claim expires, or the queue closes.

Capacity counts active queue items and rejects excess admission explicitly.
Terminal items retain their stable identity so result lookup remains
predictable.


Example
-------

~~~~ typescript
await using queue = queueUtil.memory({ capacity: 1_000 });

const ref = await queue.enqueue({ value: payload, priority: 10 }, ctx);
const claim = await queue.claim(ctx, { duration: { seconds: 30 } });
await queue.complete(claim, result, ctx);
const completed = await queue.result(ref, ctx);
~~~~

Progressive usage
-----------------

The package participates in the complete domain-enrichment example in
`docs/implementation/utils-progressive-usage.md`.  Read that guide when the
individual helpers make sense in isolation but their place in a service,
resource graph, runtime host, or workflow is not yet clear.

`API.md` is the exhaustive public-surface map for this package.  It lists every
package export target, explains each exported name, gives a compact use form,
and expands every detected repository use into a source-backed TypeScript
snippet.  An export with no current consumer stays labelled as unproven instead
of receiving an invented production example.

Claim lifecycle
---------------

~~~~ text
add
 |
 v
queued -- claim --> claimed -- complete --> completed
  ^                  |   |
  |                  |   +-- fail --> failed
  |                  |
  |                  +-- retry / lease expiry
  |                         |
  +-------------------------+

claim id + owner + expiry prevent stale completion
~~~~

