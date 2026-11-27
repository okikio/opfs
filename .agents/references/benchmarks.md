# Benchmarking rules

Use benchmarks to answer a concrete performance question. A benchmark is not useful because it produces a number. It is useful when its workload, baseline, measurement method, and interpretation are close enough to the real decision that the result can guide engineering work.

This project family normally prefers `mitata` for cross-runtime JavaScript/TypeScript benchmarks. A repository can select another harness, such as Vitest benchmarks, when that environment owns the scenario. Follow the repository-selected owner instead of creating parallel benchmark stacks.

## Start with the claim

Write the claim before the benchmark. Examples:

```text
new parser reduces allocations for 10 MiB HLS playlists without lowering throughput
partitioned OPFS record writes stay bounded in JavaScript heap as logical file size grows
new selector matcher removes content-script long-task spikes on a 15k-rule registry
```

Then define the metric needed to evaluate that claim: throughput, latency distribution, operations per second, allocations, retained heap, request count, main-thread long tasks, bytes copied, startup time, cancellation latency, or another physical cost.

Do not optimize an unnamed “fast path.” Name what work is expensive and why it matters.

## Preserve the work under measurement

Always consume benchmark results with `do_not_optimize()` or the equivalent offered by the selected harness. A benchmark that computes a result no observer needs can be optimized into a different workload than the source suggests.

Avoid constant folding and loop hoisting. Use generated or parameterized inputs when a literal can be precomputed. Reusing stable fixtures is valid when the real workload reuses data, but make setup versus measured work explicit.

## Separate setup from the hot operation

Decide whether construction, parsing, allocation, connection setup, cache warmup, or teardown belongs inside the timed region.

For example:

```text
cold parse benchmark     includes parser construction + parse
steady-state parse       parser/config prepared outside timed body
connection startup       includes connection acquisition
query throughput         uses already-established connection
```

Do not compare a cold implementation with a warm competitor and call the result fair.

## Garbage collection and allocation

For Mitata, use its GC controls deliberately. Allocation-heavy scenarios often benefit from inner GC control when per-iteration stability matters. Outer control has less overhead when the benchmark can tolerate more inter-iteration noise.

Do not put ad-hoc heap sampling inside the hot callback unless heap sampling itself is the workload. Memory regressions are often clearer in a separate lifecycle test or benchmark that measures retained heap after a known sequence of operations and cleanup.

Measure both peak and retained memory when resource lifetime matters. A conversion can have acceptable final retained heap while still creating catastrophic peaks.

## Scaling tests

Use range-driven benchmarks when the question is how cost changes with input size, route count, rule count, part count, or concurrency.

Choose scales that expose algorithmic behavior:

```text
1 KiB, 16 KiB, 256 KiB, 4 MiB
100, 1k, 10k, 100k rules
1, 4, 16, 64 concurrent requests
```

Do not use only sizes that keep every implementation in cache or below its important provider limits. Include the region where the design decision matters.

## Use representative workload families

A useful benchmark suite normally includes more than one microbenchmark:

- common-path input;
- large realistic input;
- adversarial/pathological input;
- steady-state hot path;
- cold-start or initialization when users pay it;
- end-to-end operation when pipeline coordination dominates;
- cancellation/cleanup latency for long-running work when relevant.

For parsers, include chunked streaming cases in addition to one complete string/byte array. For storage, include ranges, streaming writes, metadata/list operations, and provider-specific limits. For registries, include realistic rule mixes rather than only one regex repeated thousands of times.

## Compare against honest baselines

Every performance claim needs a baseline. Useful baselines include:

- the current implementation before the change;
- a simpler standard-library/Web API path;
- a focused competing library;
- an optimization-disabled mode of the same implementation;
- a provider's official client when comparing an adapter/driver.

Use equivalent input, runtime, warmup, output requirements, validation, and cleanup. Record meaningful configuration differences instead of hiding them.

If an optimization changes semantics, expose the semantic difference and, where practical, benchmark both enabled and disabled modes.

## Benchmark fixtures are implementation evidence

Benchmark workloads can encode important invariants just like tests. Document non-obvious fixture construction, corpus selection, generation seeds, cache state, and expected scaling behavior.

Keep large external corpora traceable with source/version/checksum metadata. Do not silently replace a real corpus with a tiny synthetic fixture and preserve the old performance claim.

## Interpret results statistically and physically

Do not report only the fastest observed sample. Use the benchmark harness's statistical output and compare effect size with run-to-run noise.

Then explain the physical reason for the difference:

```text
fewer substring allocations
one HTTP range request instead of four
reused compiled matcher table
less serialization
smaller copy volume
bounded number of active workers
```

If the result cannot be connected to a plausible physical change, investigate before claiming an optimization.

## Regression thresholds

Use hard thresholds only when the environment is stable enough to support them. CI performance can be noisy. For unstable hosts, prefer larger guardrails, trend reports, dedicated runners, or deterministic counters such as allocation/request count.

Do not create a flaky gate with a threshold tighter than the host's normal variance.

Benchmarks are optional evidence for a named performance decision, not routine
correctness gates. Require them in PR CI only when an affected operation has a
representative workload, reproducible baseline, stable threshold, and an owner
who will investigate regressions. Otherwise, keep a discoverable, separately
invoked benchmark task and preserve raw measurement context. Prefer a stable
physical counter over noisy wall-clock timing when it tests the same risk.

## Reporting

A benchmark result should state:

- runtime/version and host information;
- benchmark harness/version;
- workload and input size;
- cold/warm state;
- concurrency and important flags;
- baseline and candidate;
- measurement/statistical output;
- interpretation and uncertainty;
- any behavior or memory tradeoff.

Keep benchmark data as data. For multiple runs, normalize one row per workload, implementation, runtime, and attempt so regressions can be compared rather than pasted as terminal text.

## Anti-patterns

- result is not consumed;
- only happy-path microbenchmarks exist;
- setup cost is hidden for one competitor;
- different inputs are compared as equivalent;
- no baseline exists;
- benchmark numbers are treated as correctness evidence;
- retained memory is inferred from throughput;
- performance claim survives after workload or implementation changes but benchmark fixtures are stale;
- faster code is kept despite a semantic regression that was never measured;
- a benchmark is added without explaining the user or system cost it represents.
