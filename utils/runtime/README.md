`@utils/runtime`
================

Purpose
-------

`@utils/runtime` defines logical execution locations used by activity and
workflow placement policy.

A runtime definition is a label and description such as `browser`, `analysis`,
or `coordinator`.  It does not start a process, create a thread, consume a
queue, or construct a provider client.


How it fits
-----------

`@utils/activity` records which logical runtimes may execute an activity.
`@utils/workflow` can group activity placement through workflow policy.
Concrete packages and executable composition decide how a logical runtime maps
to real processes, threads, containers, queue consumers, or services.

This package exists so definitions can refer to placement without importing the
implementation that provides the placement.


Current maturity
----------------

The contract is intentionally small.  At present, activity placement is its
main consumer.  Treat the package as provisional until additional real
consumers prove that the logical-runtime vocabulary remains useful across
browser, analysis, coordinator, and deployment composition.

Do not add process-management behavior merely to make this package larger.  If
future consumers only need a placement definition, the small surface is the
correct shape.

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

