# Split tests without losing coverage

Use this page when one test job is too slow after unnecessary work is removed.
Measure compilation, archive transfer, scheduling, test time, and the slowest shard.
Sharding improves elapsed time only when its overhead and extra machines are justified.

Nextest can archive compiled tests and reuse that archive in compatible jobs.
It can also partition selected tests. These are separate operations.
A typical command shape is:

```sh
cargo nextest archive --workspace --locked --archive-file tests.tar.zst
cargo nextest run --archive-file tests.tar.zst --partition hash:1/4
```

Use the same archive, filters, config, target, and feature set across all four jobs.
Run indices 1 through 4. Pin nextest, and record its version with the archive.
Replace the example count with a measured choice. Do not rebuild the same tests
in every shard if archive reuse solves that cost.

## Choose a partition deliberately

Hashed partitioning uses binary identity and test name to keep assignments stable
within a nextest version series. It gives roughly balanced counts for large suites,
but equal counts do not imply equal execution time.
Sliced partitioning distributes the filtered test list round-robin; adding tests
or changing filters can move existing tests between slices.
Filters are applied before partitioning. Different filters per shard can lose tests.

Capture the unsharded selected inventory and each shard's selected inventory.
Their union must equal the intended set; unintended duplicate execution must be
identified. A zero-test shard must have an explained reason, not conceal a bad filter.
Retain passed, failed, ignored, retried, timed-out, and skipped counts.
Distinguish tests skipped because another shard owns them from intentionally ignored
tests. A retry that passes does not erase the original failure.

## Reuse only compatible artifacts

An archive contains compiled output, not a universal cross-platform executable.
Match OS ABI, architecture, target features, dynamic libraries, runner, toolchain,
profile, and needed data files. Remap workspace paths through the documented API.
Keep external fixtures and native libraries available at their intended locations.
Hash the archive and tie it to the producing revision and job.
Never consume an arbitrary PR artifact in a privileged release workflow.

A configured target runner may execute cross-compiled tests.
It does not make unsupported Wasm thread, clock, filesystem, or browser behavior
work. Verify the real runner and collect the actual test results.
Nextest does not currently run doctests; keep `cargo test --doc` as a separate lane.
Special harnesses must support the runner's discovery/execution protocol.

## Keep benchmark comparison separate

Do not scatter noisy timing samples across unrelated CI hardware and combine them
as if they were one experiment. Keep baseline and candidate paired on controlled
hardware with the same warmup, data, flags, and resource limits.
Shard independent workloads when needed, then retain runtime/hardware identities
per result. Deterministic counters still need an identical compiler/workload context.
Do not use a benchmark suite's successful test mode as evidence of speed.

Primary sources, reviewed 2026-11-26:
[partitioning](https://nexte.st/docs/ci-features/partitioning/),
[archives](https://nexte.st/docs/ci-features/archiving/),
[target runners](https://nexte.st/docs/features/target-runners/),
[test lists](https://nexte.st/docs/machine-readable/list/),
[working upstream example](https://github.com/nextest-rs/reuse-build-partition-example).
