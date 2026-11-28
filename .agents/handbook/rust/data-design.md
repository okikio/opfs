# Measure data design against the operation and its lifetime

Use this for Rust data structures, ASTs, batches, shared strings, pools and arenas.
Read the [shared guide](../../guides/rust/data-oriented-design.md) and
[Rust procedure](../../skills/rust-software/references/data-oriented-design.md).
Keep the work in the [active task record](../agents/task-record.md) and follow the research/experiment loop.

## 1. Define the customer cost and exact work

State the observed problem, proposed decision and evidence that would change it.
Pin the source revision and trace the operation's callers and consumers. List
input families, sizes, skew, configured limits and simultaneous requests.

Map each phase to fields read/written, traversal order, repetitions, mutation,
allocation, retained output and release. Check whether removing work or changing
the algorithm would help before choosing a different container.
Use the [layout record](../../skills/rust-software/assets/layout-record.md)
when the current task record lacks these fields.

## 2. Make the smallest discriminating comparison

Name the current safe representation and one alternative. Mark the fixture as
captured, source-derived or generated. A projection from a table test into flat
records is a candidate model, not the current DOM implementation.

Keep semantics and ownership equal while isolating the change. Compare arrays
of records with columns for field access; compare boxed with contiguous records
for indirection; compare owned text with source spans for copying and retention.
Do not attribute a combined redesign to one mechanism without a suitable control.

When borrowing from Oxc, verify the exact package revision and features, then
run the relevant parser, traversal or allocator API directly. A source review
of semantic tables and a parser execution are different evidence scopes.
Do not copy a custom unsafe container before safe columns show a useful need.

## 3. Prove output and lifetime rules before timing

Use complete independently expected output. Include empty/singleton inputs,
tails, duplicate/invalid IDs, Unicode boundaries, configured limits and mutation
where applicable. Check retained output after the original owner is released.
Validate narrowing, source ranges and column lengths before unsafe assumptions.

Run the required operation on every declared supported host. Include actual
Wasm execution when the project requires it. Compilation alone does not close
the support row. Record feature differences, host imports,
errors and untested paths. Preserve failed and corrected experiment attempts.

## 4. Measure narrow operations and the complete lifecycle

Measure the hot pass, then construction, required queries/mutations and release.
For reusable data, vary the realistic pass count and record the break-even
question. Include conversion and handoff costs when consumers require them.

Use a bounded size matrix, warmup, balanced repeated order and raw samples.
Prevent concurrent builds or benchmarks during the controlled timing window.
Keep allocation observations separate from timed loops and confirm important
results with a fresh run after exploratory changes.

For arenas or buffers, run small, large, then small workloads and observe reset
and teardown. Name each measurement precisely: used bytes, retained capacity,
requested allocations, RSS or Wasm linear memory. Test the cost of a retention
threshold before making it a default. Multiply budgets by expected concurrency.

Inspect generated code or hardware counters when the decision requires a SIMD,
cache or branch explanation. Time alone establishes elapsed cost in that run.
Do not mix native and Wasm baselines or turn host-specific results into a universal rule.

## 5. Publish an anchor and select the next action

Report which alternatives preserve behavior and how their costs differ for
the measured workloads. Include regressions, uncertainty and maintenance costs.
Choose adoption, rejection or a concrete next experiment. Keep the simpler
layout when the alternative does not improve the required customer operation.

Before claiming product improvement, test the connected implementation with
representative input, limits, failures and concurrency. Preserve the full plan,
exact source, raw samples, commands, unresolved questions and next safe action.
