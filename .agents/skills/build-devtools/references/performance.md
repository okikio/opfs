# Performance experiments

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Question, hypothesis, and acceptance rule](#question-hypothesis-and-acceptance-rule)
- [Workload and protected-workflow design](#workload-and-protected-workflow-design)
- [Candidate isolation and provenance](#candidate-isolation-and-provenance)
- [Timing protocol](#timing-protocol)
- [Memory and resource protocol](#memory-and-resource-protocol)
- [Statistics and decisions](#statistics-and-decisions)
- [Stress and scale lanes](#stress-and-scale-lanes)
- [Correctness and operational gates](#correctness-and-operational-gates)
- [Artifacts and reporting](#artifacts-and-reporting)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Executable verification](#executable-verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference for optimization proposals, benchmark additions, throughput,
latency, memory, allocation, startup, binary size, build speed, bundle size, or
claims that one implementation is faster. Also load it when a microbenchmark
improves while users report regressions, or when benchmark results are being
used to accept/reject architecture.

## Outcome

Produce an experiment that another maintainer can rerun, audit, and reject. It
must preserve raw samples and candidate source, precommit its decision rule,
measure representative target and protected workflows, run correctness gates,
model uncertainty, and distinguish observed results from extrapolation.

Performance is multi-dimensional. A candidate is not "faster" without naming:

- operation and input distribution;
- cold/warm/cache/process state;
- latency statistic or throughput unit;
- memory definition (peak, retained, allocation, RSS, heap, external);
- runtime/tool/hardware/OS/power conditions;
- error/cancellation/backpressure behavior;
- protected workflows and permitted regressions;
- scope: this machine/run/version versus broader claim.

## Question, hypothesis, and acceptance rule

Write these before collecting candidate data:

```text
Question: Does flattening parser event fields improve parse workloads?
Mechanism: fewer nested allocations and property reads.
Target workflows: tokenizer events(), parse(), parseWithDiagnostics(), session.
Protected workflows: malformed recovery, Unicode offsets, streaming, memory.
Primary metric: median relative change across named timing cases.
Gate: >=5% target median improvement; no critical timing regression >3%
      with adjusted significance; no overall retained-memory regression.
Rollback: retain baseline implementation; reject candidate snapshot.
```

Choose thresholds from product value, measurement resolution, and risk—not
after seeing results. Define a smallest effect worth acting on. A statistically
detectable 0.5% change may be operationally irrelevant; a 2% tail-latency
regression may be critical in a service even when average throughput improves.

Specify primary, secondary, diagnostic, and guardrail metrics. Multiple primary
metrics without a rule invite cherry-picking. State how missing, failed, timed
out, or out-of-memory samples affect the decision; never drop them silently.

## Workload and protected-workflow design

Build a workload ledger that represents real use and pathological edges.

| Lane | Examples | Purpose |
|---|---|---|
| Micro | one tokenizer primitive, one serialization step | explain mechanism |
| Component | full tokenizer/parser/filter | measure subsystem |
| End-to-end | public parse/session/CLI/API workflow | decide user impact |
| Error | malformed input, retry, cancellation | protect failure behavior |
| Scale | large input/cardinality/concurrency | expose asymptotics and limits |
| Cold | startup/import/first request/empty cache | deployment and CLI behavior |
| Warm | steady-state repeated workload | long-running behavior |

Use production distributions or documented fixtures where possible. Include
small, typical, large, Unicode, adversarial, highly compressible/incompressible,
sparse/dense, and hit/miss cases as relevant. Record fixture generation seeds
and digests. Do not let candidate code select easier fixtures.

Protected workflows prevent local optimization from moving cost elsewhere. A
tokenizer win must not slow complete parse, tree building, diagnostics, session,
or real consumer behavior. A database query win must not increase write cost,
merge backlog, recovery time, or result errors. A build-speed win must not lose
types, source maps, or package checks.

Verify the benchmark reaches the intended path. Count operations/output, assert
result digests, instrument branch/hit rates if necessary, and detect dead-code
elimination or cached precomputation. A benchmark that returns the wrong result
quickly is a correctness failure.

## Candidate isolation and provenance

Keep baseline and candidate source/harness snapshots together. The attached
Wikitext experiment stores approach-local `code/`, artifacts, and README notes;
this prevents later source edits from silently changing what an old report
means.

Record:

- source revision and candidate patch/digest;
- benchmark and fixture revision/digests;
- exact command, options, seed, rounds, and ordering;
- runtime/compiler/GC/tool versions and flags;
- OS/kernel, CPU model/count/governor, memory, architecture;
- container/VM, power/thermal, background load, affinity, and CI runner class;
- environment variables, locale/timezone, caches, and dependency lock digest;
- raw stdout/stderr and exit status for failed samples.

Baseline and candidate must use the same harness and meaningful environment.
If a candidate requires a harness change, first run old code under old and new
harnesses to measure the harness effect. Freeze or version the harness; do not
copy current source into an old approach directory after results exist.

## Timing protocol

1. Establish environment preflight and correctness.
2. Choose process isolation. Use fresh processes when JIT/GC/global caches or
   module state can leak between variants.
3. Define warmup separately from measured samples; record it.
4. Interleave baseline and candidate in a deterministic randomized or balanced
   round-robin order to reduce thermal/time drift.
5. Use enough independent process-level samples for the chosen uncertainty
   method; many inner-loop iterations are not independent samples.
6. Preserve raw per-case samples and failures.
7. Monitor clock resolution, CPU throttling, outliers, and environment drift.
8. Re-run a surprising result in a fresh session/machine where material.

Example schedule artifact:

```json
{
  "seed": 4217,
  "rounds": [
    ["baseline", "candidate"],
    ["candidate", "baseline"],
    ["baseline", "candidate"]
  ],
  "runsPerVariant": 10,
  "warmup": 3
}
```

Use monotonic high-resolution timing. Avoid timing setup unrelated to the
question unless startup is the target. Conversely, do not exclude parsing,
allocation, I/O, or cleanup that real users pay for. State ownership scopes exactly.

For asynchronous/concurrent work, control input arrival, concurrency, queue
depth, backpressure, and completion. Throughput at unbounded queue growth is not
sustainable performance. Report latency distributions and errors under a fixed
load or throughput under a latency/error service objective.

## Memory and resource protocol

Name the memory measure. Common measures answer different questions:

- allocated bytes: churn/GC pressure;
- live heap after controlled GC: retained object graph;
- peak RSS: process/container capacity including non-heap/native/code;
- external/array-buffer memory: data not captured by heap alone;
- per-operation retained state: session/cache/leak risk.

Run memory harnesses in fresh processes and hold the intended result alive. If
forcing GC, record runtime flags and collect after a consistent sequence; forced
GC changes execution and does not represent peak memory. Use both peak and
retained measures when resource limits matter.

Detect leaks with repeated lifecycle cycles and plateau expectations, not one
before/after subtraction. Exercise cancellation, errors, subscription cleanup,
worker termination, cache eviction, and disposal. Also track CPU utilization,
I/O bytes/operations, network, file descriptors, event-loop delay, binary size,
and build artifact size when a candidate can shift cost.

## Statistics and decisions

Prefer relative paired comparisons from interleaved runs. Report median and a
tail statistic for latency, plus uncertainty. Preserve the full distribution;
do not report only the fastest sample or operations/second summary.

Bootstrap confidence intervals are useful when distributions are non-normal.
When testing many cases, control family-wise error or false discovery according
to the predeclared plan. The Wikitext study uses bootstrap confidence intervals,
bootstrap p-values, and Holm adjustment at alpha 0.05, with a target-median and
critical-case gate. This is a project-specific policy, not a universal formula.

Decision table:

| Observation | Decision |
|---|---|
| Effect clears practical threshold and uncertainty/guardrails | eligible to keep |
| Direction positive but below meaningful threshold | reject or defer; do not call a win |
| One microcase wins, protected E2E regresses | reject or redesign |
| Confidence inconclusive | collect preplanned additional samples or report inconclusive |
| Memory improves but timing gate fails | reject under timing-primary policy; retain result |
| Candidate fails correctness or crashes | reject regardless of speed |

Do not use "not statistically significant" to prove equality. If equivalence
matters, specify equivalence margins and use an appropriate test/design. Do not
average ratios across incomparable workloads without a declared weighting.

## Stress and scale lanes

Stress tests answer survivability/asymptotic questions and should not distort
the standard comparison set. The Wikitext archive separates standard reports
from 16 MiB and 1 GiB stress artifacts, defines ten scenario families, and uses
a streaming-only default at 1 GiB so that lane measures event-path survivability.
Full materialization gets a separately named artifact.

For stress lanes define:

- exact size/cardinality/concurrency and generation algorithm;
- whether data is streamed or fully materialized;
- time/memory/resource limit and failure recording;
- repetition policy (often fewer expensive runs, with weaker claims);
- scenario-specific output/correctness checks;
- artifact naming that cannot overwrite another profile;
- preflight inventory proving the lane actually exists.

A successful 1 GiB stream does not prove a full-tree parser handles 1 GiB. A
failed case must be recorded in the JSON artifact rather than causing the entire
report to disappear. Extrapolation beyond executed scenarios must be labelled.

## Correctness and operational gates

Run before and after benchmarks:

- unit/property/fuzz/fixture tests for unchanged semantics;
- stable output/order/offset/precision contracts;
- errors, retries, cancellation, timeout, and cleanup;
- supported runtime/platform/compiler modes;
- end-to-end consumer workflows;
- security/permission scopes;
- package/build checks if optimization affects output.

Optimization may intentionally change output (compression, approximate query,
cache policy). Define permitted error and validate it on an independent data set.
Benchmark fixtures used to tune the candidate cannot be the only accuracy set.

## Artifacts and reporting

Retain machine-readable artifacts:

```text
experiment/
  protocol.md             # frozen question and decision rule
  schedule.json           # exact order/seeds
  baseline/code + metadata
  candidate/code + metadata
  reports/*.json          # raw samples and environment
  comparisons/*.json      # derived statistics
  commands.txt
  results.md              # human interpretation and limits
```

Human notes must separate hypothesis, methodology, observations, limitations,
and conclusion. Link every conclusion to artifacts. Record rejected candidates;
negative results stop repeated bad ideas. The attached Wikitext results retain
several rejected event-shape approaches, including a small memory improvement
that missed the timing gate and lazy-property designs with severe timing loss.

Do not claim a matrix is complete because tooling exists. The Wikitext ledger
explicitly distinguishes implemented runners from collected artifacts and notes
that its broader stress matrix, session stress, and multi-machine evidence are
incomplete. Use the same honesty for blocked hardware, missing credentials, or
unavailable runtimes.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Huge win disappears in end-to-end test | microbenchmark excludes shifted cost | protected workflow ledger |
| Candidate always runs second and loses | thermal/time/order bias | interleaved schedule |
| Many inner iterations, tiny uncertainty | pseudoreplication | independent process/sample unit |
| Memory result changes after timing run | shared process/cache/GC state | fresh-process harness |
| Fastest sample reported | cherry-picked statistic | raw samples and predeclared metric |
| Significant 0.4% win accepted | practical threshold absent | smallest useful effect |
| No errors in report but process crashed | failed samples dropped | collector exit/error recording |
| 1 GiB claim from 16 MiB artifact | tooling/plan confused with evidence | artifact inventory and exact size |
| Old report changes after refactor | candidate source not snapshotted | provenance/digests |
| Speedup changes output | correctness digest/invariant missing | output and independent accuracy tests |

## Deliberate exclusions

- Do not run benchmarks before defining the acceptance rule when the result will
  decide implementation.
- Do not use one machine to make universal absolute-speed claims.
- Do not treat a benchmark framework's summary as the experiment record.
- Do not optimize only mean/median while ignoring tail, error, memory, or
  protected workflows relevant to users.
- Do not remove failed samples as outliers without a predeclared mechanical rule.
- Do not keep a candidate because substantial implementation work was invested.
- Do not infer a completed stress matrix from available scripts.

## Executable verification

1. Validate the experiment inventory, source/fixture/report digests, and exact
   commands before collection.
2. Run correctness gates for baseline and candidate.
3. Execute balanced/interleaved fresh-process timing and memory schedules.
4. Confirm collectors preserve raw samples, failures, environment, and counts.
5. Recompute comparison statistics from raw reports independently.
6. Verify multiple-comparison adjustment and practical thresholds against known
   synthetic inputs/tests.
7. Run protected end-to-end and error workflows.
8. Run named stress lanes within resource authorization and record incomplete
   lanes as incomplete.
9. Re-run a representative result in a clean environment or second host before
   broad claims.
10. Confirm the conclusion follows the predeclared gate; retain rejection notes.

## Sources and freshness

- Attached `wikitext.zip`, observed `experiments/event-shape-study/protocol.md`,
  `methods.md`, tools, approach-local snapshots, schedules, raw reports,
  comparisons, stress artifacts, and `results.md`; verified 2026-07-17.
- Attached `undent.zip`, normative benchmarking/testing instructions plus
  executable timing and memory suites; verified 2026-07-17.

The thresholds and Deno commands in Wikitext belong to that experiment. Reuse
the experimental controls and evidence discipline; choose product-specific
metrics, effects, runtimes, and gates before collecting new data.
