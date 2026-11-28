# Isolate mutable Cargo output between worktrees

Use this page when multiple branches or agents build the same Rust repository.
Git worktrees share Git objects. That does not make divergent build outputs
interchangeable. Cargo normally gives each workspace path its own `target`.

Share downloaded registry/Git sources through the normal Cargo cache.
Keep each worktree's writable target/build directory separate by default.
Use a compatible compiler cache for reusable compilation results when measured
benefits justify it. See [caching](caching.md) for its actual limitations.

## Inspect before changing cache paths

Record each worktree path, branch, commit, dirty state, compiler, target, features,
profile, `RUSTFLAGS`, `CARGO_TARGET_DIR`, and Cargo build-directory configuration.
Use `cargo metadata --format-version 1 --no-deps` to inspect resolved directories.
Check parent/global Cargo and Mise configuration; a local file is not the whole
configuration. Preserve separate outputs for native, Wasm, and foreign consumers.

Do not globally point every branch to one mutable output directory.
Do not run `cargo clean` against another agent's active output.
Do not hand a consumer a fixed executable path that another build can replace.
Record and verify the produced artifact's hash and source revision at handoff.

## Test a proposed shared output directory

Create two disposable worktrees with the same package name/version and distinct
observable output. Compare their resolved target directories, build each version,
and verify the executed artifact and source hash. Include divergent source,
concurrent builds, stale artifacts and cleanup. A warm build alone cannot prove
that a shared output cache is safe. Keep the default isolated until the proposed
sharing contract passes these checks.

Do not enable unstable Cargo locking or fingerprint flags as an undocumented
fix. Pin and test any tool that changes invocation, path identity or scheduling.

## Bound disk and resource costs

Set a disk budget and expire inactive worktree output through an explicit policy.
Use worktree-specific directories under a cache root if local disk placement matters.
Delete only known inactive generated output; preserve source, lockfiles, and evidence.
Avoid multiplying CPU count by Cargo jobs by test threads by benchmark workers.
Record queue/lock wait separately from compile time when several agents share a host.
Download-cache cleanup and target-artifact cleanup are different operations.

When measuring reuse, compare fresh, warm, edited, and divergent-source builds.
Run each timing condition to completion before starting its dependent condition.
A package-cache lock or competing compiler invalidates an isolated speed comparison.
Keep that observation as contention evidence and rerun only the unresolved question.

Primary sources, reviewed 2026-11-26:
[Cargo build cache](https://doc.rust-lang.org/cargo/reference/build-cache.html),
[Cargo configuration](https://doc.rust-lang.org/cargo/reference/config.html),
[Git worktree](https://git-scm.com/docs/git-worktree),
[Cargo shared-build discussion](https://github.com/rust-lang/cargo/issues/16804).

Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
