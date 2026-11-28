# Interpret layout and ownership evidence within its scope

Use this page when a data-design decision relies on a benchmark, upstream
implementation or saved experiment. Apply [the procedure](data-oriented-design.md)
to the current operation and preserve the [evidence record](evidence-index.md).
An unavailable result remains unverified until its source and observations can
be inspected or a relevant bounded probe can be repeated.

## Separate the source inspected from the artifact executed

Record the inspected repository and full commit separately from the resolved
package version, package source revision, enabled features, compiler and output
hash. A matching version label does not prove byte-identical source. Inspect the
operative fields and code when an explanatory comment describes a different shape.

For Oxc, a review of scope or symbol tables does not establish parser behavior
on the selected host. Executing a parser and visitor does not establish name
resolution, type checking or complete semantic equivalence. State which API ran,
which outputs had independent expectations, and which were only compared across
implementations or hosts. A shared bug can survive cross-host equality.

Start with the pinned public [semantic tables](https://github.com/oxc-project/oxc/blob/58b07b7fe4d2213dacb737a059a93d0be6a0d3da/crates/oxc_semantic/src/scoping.rs)
and [column container](https://github.com/oxc-project/oxc/blob/58b07b7fe4d2213dacb737a059a93d0be6a0d3da/crates/oxc_semantic/src/multi_index_vec.rs)
for source patterns. The separately pinned [allocator](https://github.com/oxc-project/oxc/blob/87e38f3270b00341695e02e8aaf681e9e985e4a3/crates/oxc_allocator/src/allocator.rs)
and [chunk accounting](https://github.com/oxc-project/oxc/blob/87e38f3270b00341695e02e8aaf681e9e985e4a3/crates/oxc_allocator/src/arena/chunks.rs)
provide a different source identity to inspect. These links are source evidence,
not records of an executed operation in the current project. Verify the exact
resolved dependency before adopting an API or implementation detail.

## Keep the comparison's work and representation explicit

| Observed comparison | What it can establish | What needs separate proof |
| --- | --- | --- |
| A scan over one field | Cost of that access pattern at the measured sizes | Construction, full-record output, lookup, mutation and release |
| Safe columns versus records | The tested containers and access loops | A custom single-allocation container or a different traversal API |
| Source spans versus owned strings | Copying and retention for those inputs | Output materialization and source lifetime after a small result escapes |
| Arena-backed versus independently owned records | The complete representations and lifetimes compared | Allocator-only causation when widths, placement or copying also differ |
| A projection from an existing fixture | Behavior of the proposed record model | The production representation, workload distribution and connected consumer |

Check complete ordered output, errors and ownership before timing. Counts or
digests can support a timed loop but cannot replace the independent full-output
oracle. A parser returning an empty body after an error is not a successful empty
input. Retain diagnostics and distinguish fatal from recoverable errors.

## Measure reuse and retention as different questions

Record small, large, then small operations and final release. Keep a single
large request followed by small requests distinct from repeated large requests;
they can leave different retained capacities. Multiply per-request and per-worker
budgets by the concurrency the product actually allows.

Fewer allocation calls do not by themselves establish less memory or lower
latency. Separate used bytes, retained capacity, requested allocation bytes,
peak live bytes, RSS and Wasm linear-memory size. Record padding, container
metadata, chunk footers and allocator overhead that each measure includes or
excludes. Deallocation need not lower RSS or shrink linear memory.

Measure a retention threshold before making it a default. Include allocation
churn and the complete construction/query/release cost. Keep allocation
instrumentation outside timing runs when it changes the cost being measured.

## Carry forward a decision that can be challenged

Preserve raw samples, process identities, order, workload, host load, failures
and invalidated attempts. Report observed ranges as ranges, not confidence
bounds. Keep baseline storage separate by runtime and target. A newly introduced
candidate has no independent confirmation merely because older candidates were
repeated in the same process.

Use a fresh comparison when the decision needs confirmation. Test the connected
consumer, input distribution, limits, cancellation and concurrency before claiming
product improvement. Report which result supports adoption, rejection or the next
experiment, and which required hosts or behaviors remain untested. A source
pattern or shared-host microbenchmark cannot establish a universal layout ranking.
