`@utils/streams`
================

Purpose
-------

`@utils/streams` contains small adapters between Web Streams and async iterable
values, plus bounded collection helpers.

Use it when two reusable capabilities expose different standard streaming
protocols and the conversion itself is generic.


How it fits
-----------

Domain packages should expose the data shape that matches their workload.
Records often fit `AsyncIterable<T>`.  Bytes and transport pipelines often fit
`ReadableStream<T>` and `WritableStream<T>`.

This package converts between those shapes without turning streaming work into
an unbounded array by default.


Operations
----------

`streams.readable()` converts an async iterable into a `ReadableStream` while
preserving cancellation.

`streams.pipe()` reads a Web Stream as an async iterable and releases its reader
when iteration ends early or fails.

`streams.collect()` deliberately materializes a source with explicit item and
byte limits.  It throws `StreamLimitError` before collection can grow beyond the
caller contract.

~~~~ typescript
for await (const batch of streams.pipe(response.body!)) {
  await consume(batch);
}
~~~~

The package does not add hidden buffering, retries, persistence, or transport
policy.

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

