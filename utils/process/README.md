`@utils/process`
================

Purpose
-------

`@utils/process` starts and owns one direct child process through Deno's process
APIs.

The package gives callers explicit control over standard input, standard
output, standard error, cancellation, graceful shutdown, forced shutdown, and
bounded output capture.

Use it when a library or concrete package must own a subprocess.  Do not use it
as a general workflow or queue abstraction.


How it fits
-----------

`@utils/context` supplies cancellation and deadlines.  Concrete packages decide
which executable to run and what the process means.  For example, a Lighthouse
package can use this utility while still exposing a `LighthouseProcess` in its
public API.

The process utility owns only the direct child that it starts.  It does not
pretend to own an arbitrary operating-system process tree unless the selected
adapter can prove that behavior.


Resource rules
--------------

`process.start()` returns an owned handle.  The caller must dispose it.

`process.exec()` is the finite convenience operation.  It starts the child,
waits for completion, captures bounded output, and returns the terminal result.

Output capture fails with `OutputLimitError` before unbounded child output can
consume process memory.  Shutdown first attempts the configured graceful stop.
It can then force termination and reports a timeout if the child still does not
settle.


Example
-------

~~~~ typescript
const result = await process.exec({
  ctx,
  command: ['tool', '--version'],
  stdout: { kind: 'capture', maximumBytes: 64_000 },
});
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
Context cancellation
       |
       v
Process.stop()
       |
       +--> graceful signal
       +--> wait grace period
       +--> forced termination when required
       +--> drain/cancel owned output
       `--> terminal Exit
~~~~

