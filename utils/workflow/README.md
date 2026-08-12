`@utils/workflow`
=================

Purpose
-------

`@utils/workflow` is the generic iterator programming model for deterministic
workflow programs.

A workflow implementation is a generator.  The generator yields instructions
and receives their terminal completions.  The program does not call storage,
queues, timers, provider clients, or external work directly.


Instruction model
-----------------

Commands are leaf instructions with one interpreter-owned lifecycle:

 -  activity
 -  sleep
 -  wait for signal
 -  child workflow
 -  emit event
 -  ensure cleanup
 -  continue as new

Controls coordinate nested operations:

 -  parallel
 -  race
 -  map
 -  retry

`@utils/activity` owns external-work definitions.  The workflow package refers
to an activity command without importing the activity implementation.


How it fits
-----------

The generic package owns deterministic paths, control semantics, cancellation,
cleanup order, declared failures, faults, and continue-as-new behavior.

A durable package owns persistence, claims, timers, signal storage, replay, and
recovery.  It can use the `instruction` lifecycle hook in `workflow.live()` to
record each planned instruction before execution and record or replay its
completion afterward.

This keeps the workflow language independent from SQLite, Redpanda, browser
processes, or another orchestration provider.


Cleanup rule
------------

Use `workflow.ensure()` when cleanup can require an instruction.  Generator
`finally` blocks may perform deterministic in-memory cleanup, but they must not
yield instructions.  The live interpreter runs registered cleanup operations in
last-in, first-out order.


Example
-------

~~~~ typescript
const ObserveSiteLive = workflow.implement(ObserveSite, function* (ctx) {
  const pages = yield* activity.run(CapturePages, { domain: ctx.input.domain });

  yield* workflow.ensure(activity.run(ReleaseCapture, { id: pages.captureId }));

  return yield* activity.run(AnalyzePages, { pages: pages.urls });
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

Two iterator protocols
----------------------

~~~~ text
durable workflow Program
       | yields serializable Instruction
       v
workflow.live()
       | lifecycle hook can persist/replay completion
       v
command/control handler

Host-local operation
       | yields Step
       v
Branch -> Scope -> child Branches
       |
       `--> Reducer serializes transitions
~~~~

The durable protocol never stores live promises, streams, resource handles, or
AbortSignals.  The host-local protocol owns those values until cancellation and
cleanup are complete.

