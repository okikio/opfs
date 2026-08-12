`@utils/worker`
===============

Purpose
-------

`@utils/worker` provides a validated request/response protocol for Deno Worker
threads.

The package correlates requests by ID, validates both directions through
Standard Schema, propagates cancellation, preserves expected failure data,
surfaces protocol faults, supports transfer lists, and owns Worker shutdown.

Use this low-level package only when the runtime resource is actually a Worker
thread.  A domain package that owns analysis threads should expose names such as
`AnalysisThread` and `AnalysisThreadPool` to its consumers.


How it fits
-----------

`@utils/context` creates a fresh local cancellation controller when a serialized
context snapshot enters the Worker.  `@utils/failure` encodes expected failures
without serializing JavaScript error causes or provider objects.

A concrete analysis or parsing package can use this utility to implement its
thread protocol.  The utility does not decide what work the thread performs.


Protocol rules
--------------

The parent sends one validated request envelope with a unique request ID and
context snapshot.  The Worker returns exactly one result, expected failure, or
fault for that ID.

Unknown IDs, duplicate active IDs, invalid response data, and malformed
protocol messages invalidate the Worker because correlation can no longer be
trusted.

Cancellation before dispatch prevents the request from being sent.
Cancellation after dispatch sends a cancel envelope and rejects the local
request.  A late response for that cancelled ID is ignored for a bounded period
instead of invalidating an otherwise healthy Worker.

`worker.open()` owns the Worker.  `worker.stop()` first requests cooperative
shutdown and then terminates the Worker when required.

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

Request ownership
-----------------

~~~~ text
caller Context
    | snapshot
    v
WorkerHandle.request() -- request id --> Worker server
    |                                      |
    |<--------- result / failure / fault --+
    |
    +-- caller cancellation -> cancel envelope
    `-- handle stop -> cooperative shutdown -> terminate if needed
~~~~

