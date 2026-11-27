# Benchmark the customer cost and the real artifact

Use this page after the shared benchmark skill establishes correctness and a
decision that measurements can change. Keep experiments small before adding a suite.
Record input family/size, output oracle, allocation/setup/teardown scope, target,
runtime, compiler, features, profile, CPU, concurrency, and cold/warm state.

## Choose one primary harness

| Need | Candidate | What still needs separate evidence |
| --- | --- | --- |
| Parameterized Rust kernels and allocation observations | Divan | Peak process memory, external threads, end-to-end product latency |
| Statistical baseline comparisons and reports | Criterion | Correctness, representative data, stable host and artifact identity |
| Stable instruction/cache-model counters in supported native environments | Iai-Callgrind | Real elapsed time, actual CPU behavior, unsupported instruction sets |
| Existing JavaScript/Wasm consumer path | Repository-selected Mitata | Rust-internal attribution and native execution |

Mitata's own repository has JavaScript and C++ implementations. It is not solely
a C++ project, and no official Rust variant was established by this research.
Do not add parallel harnesses merely to collect more kinds of output.
An optional CodSpeed integration can preserve Criterion/Divan tests; verify its
runner, compatibility package, platform limits, data flow, and cost before adoption.

## Make a fair comparison

Check full outputs independently before timing. Include empty, short, long,
malformed, boundary-split, and adversarial input where relevant.
Compare equal decoding, validation, errors, ownership, and cleanup guarantees.
Keep setup inside timing when the customer pays it; state any excluded setup.
Use parameterized inputs and consume outputs. `std::hint::black_box` is best-effort,
not a correctness, security, or universal optimization barrier.
Inspect generated code when a surprising result could be dead-code removal,
constant folding, vectorization, or an unintended instruction baseline.

Measure repeated representative workloads, distributions, variability, and effect
size. Preserve failures and outliers rather than reporting only the fastest sample.
Avoid concurrent builds, uncontrolled CPU sharing, thermal changes, and noisy
cloud gates for small timing differences. Retain a fresh confirmatory comparison
after exploratory tuning when the decision needs a reliable speed claim.

Keep baseline directories keyed by runtime, target, compiler, features, profile,
workload revision, and hardware class. Criterion can automatically compare data
already in its output directory. A native baseline must not silently become the
baseline for a WASI or browser run with a different measurement contract.

For [data-layout comparisons](data-oriented-design.md), isolate pointer layout,
string ownership and allocator choice. Pair narrow scans with complete lifetime
costs, and report retained memory independently from timed allocation activity.

## Verify the selected harness in this project

Run a small representative operation on each required host before adopting a
harness. Record features, transitive dependencies, artifact size and observed
behavior. Keep output/baseline directories separate across runtimes; never
compare a native baseline with a WASI or browser result by accident. A feasibility
probe does not rank harnesses or establish production performance.

See [profiling](profiling.md) for allocation/CPU evidence and [CI](ci.md) for gates.
Primary sources:
[Divan API](https://docs.rs/divan/0.1.21/divan/),
[Divan allocation scope](https://docs.rs/divan/0.1.21/divan/struct.AllocProfiler.html),
[Criterion owner](https://github.com/criterion-rs/criterion.rs),
[Mitata](https://github.com/evanwashere/mitata/tree/8a956d3facd42dbb32c9820852451f34d1c40b44),
[Iai-Callgrind](https://docs.rs/iai-callgrind/0.16.1/iai_callgrind/),
[black_box](https://doc.rust-lang.org/std/hint/fn.black_box.html).

Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
