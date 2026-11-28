---
name: benchmark-code
description: Design, implement or assess reproducible code benchmarks with independent correctness checks, representative workloads, fair baselines, clear comments/docs, naming, imports, readable fixtures and honest performance interpretation. Use for measurement or performance claims, not routine code changes without a performance question.
---

# Benchmark behavior that is already correct

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



A benchmark includes correctness, understandable source/fixtures, comments,
documentation, names, imports, formatting and meaningful evidence. These remain
obligations even when only this skill is selected. Timings are never an oracle
for correct outputs, authorization, ordering, cancellation or cleanup.

## Required reading

Read required resources in bounded outputs, one file or section at a time;
do not concatenate the entire reference/guide tree. If a tool truncates a
required read, recover the omitted portion before relying on it. For the
decision-triggered resources below, find the relevant headings and read
those sections. A listed filename or truncated output is not a completed
read; report any consequential unavailable guidance.

- [Quality obligations](../../guides/software-quality.md): shared scope, source precedence and companion selection.
- [Benchmarking](../../references/benchmarks.md): the full measurement contract, including memory, scaling, baselines, uncertainty and reporting.
- [Testing](../../references/testing.md): independent expected results, meaningful assertions, edge/failure cases and actual host behavior.
- [Comments and TSDoc](../../references/comments.md): explain important internal workloads, corpus/seed/cache choices, units, ownership and performance-sensitive invariants.
- [Documentation](../../references/docs.md) and [readability](../../guides/readability-and-ownership.md): a maintainer must understand and reproduce the claim without the chat; distinguish measurements from proposals.

Before writing or judging names, files or imports, read the applicable sections
of [naming and folder structure](../../guides/naming-and-folder-structure-guide.md).
Before formatting, read the applicable [formatting sections](../../guides/code-formatting-guide.md).
Use [standards](../../references/standards.md), [TypeScript](../../references/typescript.md),
[general design](../../references/general.md) and [base rationale](../../references/base.md)
for type/schema, runtime, lifetime and API decisions. For substantial report
prose, use the relevant [plain-English sections](../../guides/writing-technical-docs-in-plain-english-handbook.md).
A separate documentation or testing skill is not needed to make these
obligations apply. Select companions when their specialized decisions change.

## Measurement workflow

Start from the customer question and the decision that measurement can change.
Use the [experiment method](../../guides/product/experiments.md) and
[metric scope](../../guides/product/metrics.md). Try the existing operation
directly before adding a harness. Check correct output first, keep all attempts
and failed results, and separate a quick exploratory observation from a
comparative performance or reliability claim. Measure the larger customer path
when needed to establish whether the component explains the wait. Share useful
results as [anchors](../../guides/product/anchors.md).

1. Define the user/system cost and claim, input/output contract, metric and
   authorized mode. Assessment is read-only; implementation permission does not
   authorize unrelated optimization, installs, external writes or publication.
2. Inspect the real public API, caller, selected harness and installed version.
   Identify runtime/domain owners and resource requirements. Use the repository
   runner; Mitata is the default where selected, not a second benchmark stack.
3. Establish an independent correctness oracle before timing. Compare full
   outputs and meaningful edge cases, including duplicates, order, mutation,
   errors, cancellation and cleanup where part of the contract. A sum or length
   can hide changed semantics. Do not compute expected results with the candidate.
   Reject a failed candidate; do not publish its speed ranking as an optimization.
4. Define realistic workload families, sizes, seeds/corpora, concurrency, limits,
   cache and cold/warm state. Name files/functions for what they measure and
   document non-obvious construction. Keep examples and commands reproducible.
5. Compare equivalent guarantees with an honest baseline. State setup,
   allocation, connection, validation and teardown costs inside/outside timing
   for each implementation. Consume outputs; guard against constant folding and
   hoisting. Label narrower comparisons; do not imply a cached/precomputed
   lookup measures fresh computation.
6. Run correctness separately from measurement. Inspect the repository's
   benchmark tasks and their fixture oracles before choosing commands. For real
   databases/browser behavior use the owner’s explicit fixtures, never ambient
   production credentials. Check imports and cleanup in the measured host.
7. Measure with the installed harness API. Treat GC controls, hardware counters
   and memory probes as host-dependent. Keep ad-hoc sampling out of the hot
   callback unless sampling is the workload. Distinguish peak memory, retained
   memory, whole-process snapshots and per-operation costs.
8. Preserve raw runtime/host/harness versions, inputs, flags, concurrency,
   cold/warm state, baseline/candidate and attempts. Report distributions, noise,
   plausible physical causes, semantic/memory tradeoffs and uncertainty. Do not
   manufacture timings or tighten CI thresholds beyond a stable owner's budget.
9. Review source, comments, docs, names, imports, layout and assertions as one
   artifact. State correctness results separately from timings and unrun checks.
   If the workload is stale or results are unsupported, withdraw the claim.

The [benchmark guide](../../references/benchmarks.md) retains the full source rules;
this workflow does not replace them. Use review-code for a broader diff review,
build-devtools for harness/CI mechanics, and domain/runtime companions when their
contracts are involved. Keep one investigation and report, not repeated plans.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Engineering and CI](../../handbook/engineering/README.md), [Task prompts](../../handbook/tasks/README.md).

For any project using the pack, see [Product development](../../handbook/product/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
