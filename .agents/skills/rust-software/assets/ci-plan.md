# Adopt fast Rust CI through an explicit contract

This is a reviewed adoption plan, not an installed or executed CI workflow.
Choose the repository root and read its actual Cargo manifests before using commands.
All named package, target, feature, runner, action SHA, and threshold fields must be
filled from the repository and product requirements. Unresolved fields block adoption.

## 1. Record scope before creating jobs

Run from the chosen workspace root:

```sh
rg --files --hidden --no-ignore -g Cargo.toml -g '!**/.git/**' -g '!**/target/**' -g '!**/vendor/**' -g '!**/node_modules/**'
cargo metadata --format-version 1 --no-deps --locked
cargo metadata --format-version 1 --locked
rustc -Vv
cargo -V
rustup show active-toolchain
```

Record every manifest, package ID, maintained Cargo target, consumer, and source revision.
Compare disk inventory with metadata; inspect other workspaces and excluded paths.
Review these exclusions against actual generated/third-party directories; never
exclude a maintained tool merely because it is hidden or outside the root workspace.
For each maintained Rust package/bin, assign native, browser Wasm, and/or WASI host contracts.
Require a real Wasm deliverable for the packages/binaries whose project contract
includes it. Keep native-only build hooks distinct. A missing required host
feature needs an adapter, alternative or recorded blocker.
List required acceptance cases and fixture identities. Empty inventories fail.
Keep host build machinery separately identified without treating maintained tools as exempt.

## 2. Establish the full correct path

For each valid native workspace feature set, the command forms are:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --lib --bins --tests --locked
cargo test --workspace --doc --locked
cargo build --workspace --all-targets --locked --timings
```

Select actual feature flags before running these. Do not invent an all-features contract.
Test the supported native OS behavior on its actual OS.
Build each final product profile and inspect Cargo's reported distributable artifacts.
For a concrete Wasm target, compile the selected product artifact and execute its
non-empty acceptance suite through the recorded browser/WASI runner.
Build and execute scalar and accelerated variants where both are promised.
For foreign interfaces, compile and execute real foreign consumers against the output.
Package each public crate and test a clean external consumer when publication is relevant.
Record passed, failed, skipped, and blocked results with artifact and revision identities.

## 3. Reduce work only after the full path is correct

Calculate changed packages and their affected reverse dependencies/consumers.
Broaden selection for manifests, lockfiles, toolchain, build scripts, schemas, shared
generators, feature flags, and CI selection changes. Test the selection algorithm itself.
Require the aggregate job to account for every planned lane, including unaffected lanes.
Keep the full matrix for releases and periodic verification of the selection rules.
Cancel superseded PR runs; give compilers, tests, browsers, and benchmarks one CPU/RAM budget.

Share package downloads; keep writable build/target directories per worktree.
Key output caches by trust domain, OS/architecture, compiler/Cargo, target, profile,
features/flags, linker/SDK inputs, and graph/lock identity as applicable.
Use Cargo validation on restored caches; a cache hit does not skip correctness checks.
Keep secrets out of caches and restrict writers to trusted contexts.
Pin third-party Actions by reviewed full commit SHA; record their permissions.
Measure restoration/upload cost before preserving large output directories.

## 4. Add sharding and performance gates deliberately

When test execution dominates, build a compatible nextest archive once and shard it.
Use one revision, selection, toolchain, target, and archive across all shards.
List the expected cases; verify every case appears exactly once across partitions.
Fail on missing, duplicate, unexpectedly empty, or failed shard results.
Run doctests separately. Retry metadata must retain the initial failure.
Benchmark baselines must match workload, runtime, profile, hardware, and source scope.
Keep browser, WASI, native, and FFI results in distinct output/baseline directories.
Use controlled runners for time thresholds; use CI smoke cases for executable coverage.
Store raw results, artifact hashes, and the tested contract for the aggregate gate.

Adoption is complete after a deliberately broken fixture fails the intended gate,
a new maintained Cargo target is detected, cache-free execution passes, and required CI statuses
pass on the exact revision. Until then, this plan is a candidate, not deployed enforcement.

Sources: [Cargo CI](https://doc.rust-lang.org/cargo/guide/continuous-integration.html),
[metadata](https://doc.rust-lang.org/cargo/commands/cargo-metadata.html),
[nextest partitioning](https://nexte.st/docs/ci-features/partitioning/),
[GitHub cache guidance](https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows).
