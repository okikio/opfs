# Accept dependencies through evidence

Use this page before adding, replacing, or enabling a dependency.
Begin with the product behavior, expected input, target hosts, and measured gap.
First inspect the standard library and dependencies already present.
A small vetted crate can reduce both implementation risk and total maintenance.
A low direct dependency count can still hide a large transitive build graph.

## Write an acceptance card

Record all of these before calling a candidate approved:

- Package, exact tested version, repository, release/source identity, and license.
- The required API and why existing code or a simpler alternative is insufficient.
- Minimum Rust version, edition, selected features, and target-specific dependencies.
- Native, browser Wasm, and WASI compile and execution results actually obtained.
- CPU dispatch, SIMD/fallback behavior, thread assumptions, and host imports.
- Ownership, allocations, retained capacity, copies, and input/output limits.
- Unsafe code, native linkage, build scripts, procedural macros, and generated code.
- Relevant advisories, maintenance history, release process, and known open defects.
- Build cost, code size, representative runtime measurements, and the chosen alternative.
- Validation date, reproducible fixture, unresolved questions, and revalidation triggers.

Repository reputation helps find candidates. It establishes no target support,
security guarantee, or performance result for a particular version and feature set.
Use the registry package and lockfile for the code actually tested.
A repository's current manifest can differ from a published package with the same
version string; this occurred in the Criterion research for this package.
Treat API docs, source, upstream tests, and local execution as different evidence.

## Inspect the graph that will ship

Use `cargo metadata --format-version 1 --locked` and `cargo tree -e features`.
Inspect each target and material feature combination, including host build dependencies.
Follow build scripts and native libraries through the transitive graph.
Feature unification can enable defaults through another dependency edge.
A `no_std` claim does not prove allocation-free behavior or a working browser API.
A successful Wasm build does not establish thread progress, imports, or host capability.

Check RustSec advisories and use policy tools such as cargo-deny for source,
license, advisory, and duplicate-dependency rules where useful.
These tools inspect declared/known facts; passing them does not prove memory safety
or discover every vulnerable algorithm. Keep the actual finding and policy decision.
Review dependencies again when versions, features, targets, or trust sources change.

## Make the smallest consumer prove the decision

Compile the exact API in isolation with the selected features.
Execute a correct-result check in every claimed host before integrating the package.
Add malformed input, size limits, cancellation, drop/cleanup, and ownership tests
where those contracts matter. Benchmark the operation that the product will call.
Measure both throughput and small-input overhead. Compare identical semantics.
A codec that replaces malformed text and one that rejects it solve different tasks.
Keep benchmark dependencies in development/tooling scopes unless production needs them.

The candidate cards in [text and byte crates](candidate-text-bytes.md) and
[serialization and parallelism](candidate-serde-rayon.md) are a dated research
backlog, not a global allowlist. SIMD-specific cards live with the SIMD guidance.
Promote a candidate only for the versions, features, and hosts with enough evidence.
When a required Wasm capability fails, record the blocker and choose a supported
implementation or explicit host contract. Do not hide the product from the matrix.

Primary sources, reviewed 2026-11-26:
[Cargo features](https://doc.rust-lang.org/cargo/reference/features.html),
[metadata](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html),
[tree](https://doc.rust-lang.org/cargo/commands/cargo-tree.html),
[RustSec](https://rustsec.org/),
[cargo-deny](https://github.com/EmbarkStudios/cargo-deny),
[registry source](https://doc.rust-lang.org/cargo/reference/registries.html).
