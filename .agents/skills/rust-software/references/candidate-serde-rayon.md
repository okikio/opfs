# Candidate backlog: serialization and parallelism

Use [dependency acceptance](dependencies.md) before adopting these packages.
The pinned source links identify concrete candidates to inspect. Verify the
resolved versions, features and hosts. The checks below are proposed probes;
this guide does not supply execution receipts for a consumer environment.

## Serde 1.0.229 and serde_json 1.0.154

Purpose: typed serialization and JSON parsing with explicit ownership.
Licenses: MIT OR Apache-2.0. Declared minimum Rust: Serde 1.56; JSON 1.71.
Inspect Serde's `std` and `derive` features and JSON's defaults.
Derive introduces a host procedural macro and its compilation dependencies.
Use manual implementations only when their ongoing correctness cost is justified.

A borrowed result must not outlive the input that stores its bytes.
Use `Deserialize<'de>` for borrowing and `DeserializeOwned` when the input
will not remain alive. Reader-based APIs cannot lend temporary input indefinitely.
Escaped JSON text may need new storage even when the output type permits borrowing.
The `rc` feature serializes values; it does not preserve shared-reference identity.
JSON `preserve_order`, `arbitrary_precision`, `raw_value`, and number options
change semantics or costs. Enable each for an explicit product requirement.
Unbounded nesting needs its own stack/memory/denial-of-service strategy.

Probe borrowing with `Cow<'a, str>` and `#[serde(borrow)]` using plain and
escaped JSON strings. Check whether each result borrows or owns storage; do not
infer zero-copy behavior for every field from one successful case.
Next evidence: nesting/size limits, malformed input, numeric round trips, field
policies, stream framing, retained source size, and actual serialization throughput.
[Serde manifest](https://github.com/serde-rs/serde/blob/5be4690236e16d8a16d80f76703e59091ac3be2e/serde/Cargo.toml),
[JSON manifest](https://github.com/serde-rs/json/blob/f51fa15a7015c7d02817a46d2db44c899a0016e8/Cargo.toml),
[deserializer lifetimes](https://serde.rs/lifetimes.html)

## Rayon 1.12.0 with rayon-core 1.13.0

Purpose: CPU parallel iterators and structured fork/join work.
License: MIT OR Apache-2.0. Declared minimum Rust for Rayon: 1.85.
Default features do not establish browser worker support.
The graph includes work-stealing machinery and dependencies such as Crossbeam.
Parallelism is useful only when useful work exceeds scheduling and synchronization.
Define CPU, memory, cancellation, and output-order budgets before adding workers.

Wasm compilation alone is especially weak evidence here.
The documented fallback on hosts that report unsupported thread creation can
execute structured operations sequentially. A queued `spawn` may not make progress
until another operation yields to it. An explicitly built thread pool can fail.
Browser threading needs a separate runtime, shared-memory, and worker contract;
a feature name or successfully linked module does not create that environment.

On a host without thread creation, probe `rayon::join`, explicit pool
construction and a spawned task before and after yielding. Record results and
progress separately. Compilation and one completed structured operation do not
prove background task progress or useful parallel execution.

Next evidence: serial reference equivalence, empty/tiny/skewed workloads,
cancellation and panic behavior, pool ownership, oversubscription, and the actual
threaded Wasm host if required. Benchmark worker count and task grain separately.
Floating-point parallel reductions need an explicit reproducibility contract.
[Rayon manifest](https://github.com/rayon-rs/rayon/blob/599425d4a4c64714632817f48496dbc53f656a90/Cargo.toml),
[fallback documentation](https://github.com/rayon-rs/rayon/blob/599425d4a4c64714632817f48496dbc53f656a90/rayon-core/src/lib.rs).

Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
