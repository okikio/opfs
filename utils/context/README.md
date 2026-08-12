`@utils/context`
================

Purpose
-------

`@utils/context` carries the local execution state that many runtime operations
need: identity, cancellation, deadlines, trace identity, idempotency identity,
and a clock.

The package is intentionally small.  It does not schedule work, own a queue,
resolve resources, or provide parallel execution.


How it fits
-----------

A service request, queue operation, activity job, workflow run, process action,
or Worker request can all receive a context.

The generic identity is `ctx.id`.  The caller decides what the ID represents.
For example, an HTTP service copies its request ID into the request context.  An
activity creates a child context whose ID is the activity job ID.

A serializable snapshot can cross a queue, process, or Worker message.  The
receiving runtime restores a new local `AbortController`.  Cancellation itself
is never serialized.


Ownership
---------

`context.create()` and `context.child()` return owned contexts.  The caller must
dispose the returned value.

Disposal:

 -  clears the deadline timer
 -  removes the parent abort listener
 -  aborts unfinished local work
 -  resolves `closed`

A child can shorten a deadline.  It cannot extend its parent deadline.


Example
-------

The following code gives one activity job its own local identity while it keeps
the parent deadline and cancellation signal.

~~~~ typescript
await using job = context.child(parent, { id: jobId });
context.check(job);
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

Ownership diagram
-----------------

~~~~ text
parent Context
    |
    +-- context.child() / timeout()
    |       |
    |       +--> child AbortController
    |       +--> shorter-or-equal deadline timer
    |       `--> parent abort listener
    |
    `-- dispose parent only after owned children stop

Snapshot
    | ids + timestamps only
    v
serialized seam
    |
    `--> restore() -> new local AbortController
~~~~

