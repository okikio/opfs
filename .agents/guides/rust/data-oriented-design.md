# Make data design answer a product question

Use this guide when changing the shape, ownership or processing order of data.
The [Rust procedure](../../skills/rust-software/references/data-oriented-design.md)
owns implementation detail. [The handbook procedure](../../handbook/rust/data-design.md)
turns it into project steps. Use both within the existing product task record.

## Establish the operation before selecting a container

Name the customer cost: slow extraction, high worker memory, repeated copying,
expensive startup or another observed problem. Trace the complete operation and
identify consequential unknowns. List fields read and written in each pass,
input sizes and skew, repetitions, mutation, retained results and concurrency.

Data-oriented design includes reducing unnecessary passes, avoiding repeated
derivation and matching ownership to lifetime. Selecting structure of arrays
is one possible decision. It does not define the whole method.

Identify the provenance of every fixture. A production capture, an existing
unit-test input, a projection into a proposed representation and generated
stress data answer different questions. Keep the current implementation and
an independent expected result available as controls.

## Answer cheap questions before implementing the new design

Start with a direct function or tiny Cargo package. Test one consequential
unknown before introducing service infrastructure. Select a comparison that
could disprove the preferred design. If a change combines layout, allocation
and string ownership, separate those mechanisms or test their interactions.

Choose the operations the product performs. A useful layout comparison can
include a narrow scan, full-record access, indexed lookup, mutation and the
complete construction/query/release cycle. Select only relevant cases, then
vary small, ordinary and bounded stress inputs. Record the expected decision
before timing and keep negative or inconclusive outcomes.

Oxc is a useful source of specific patterns: phase arenas, source spans, typed
IDs, separate columns and sparse metadata. Trace the exact upstream source,
features and invariants. Source comments can drift from operative fields.
An upstream pattern becomes a candidate for an experiment, not an approval.

## Require equivalent behavior and complete cost accounting

Compare complete semantic output before performance. Include the operation's
errors, limits, ordering, identity, UTF-8 rules, mutation and cleanup. Keep
source and output lifetimes explicit across native, Wasm and FFI consumers.

Measure the complete lifetime as well as an isolated hot operation. If setup
cost increases, find whether the real number of repeated passes repays it.
Record post-request retention after a large request followed by small ones.
Keep allocation requests, capacity, peak live bytes, process RSS and Wasm
linear-memory size separate. A low allocation count does not prove low memory.

Use balanced repeated measurements, exact raw samples and comparable conditions.
Do not run builds or other benchmarks beside a controlled timing run. Shared
hosts still limit small-effect claims. Test the actual operation on every required host. Keep
Wasm and native timing baselines separate when both hosts are supported. Follow the shared benchmark owner.

## Close with a decision the team can use

Report the question, dated observation, evidence scope, customer meaning and
next decision. Say which operations improved or regressed and which remain
unmeasured. Explain any new lifetime, safety, build or maintenance cost.

A source-derived microbenchmark can select the next product prototype. It
cannot establish that the connected customer operation is fixed. Preserve the
next integration check and stop adding machinery once the current question
has an adequate answer. Keep a simpler design when the evidence favors it.
