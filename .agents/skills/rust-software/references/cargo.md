# Keep Cargo's graph explicit

Use this page when changing packages, features, profiles, or build scope.
Inventory every `Cargo.toml`, including manifests outside the root workspace.
Compare that inventory with `cargo metadata --format-version 1 --no-deps`.
Every maintained Rust artifact needs an explicit supported-host contract. A
Wasm deliverable is required only when the project selects it; record its runtime
check. Workspace defaults, `required-features`, and exclusions must not hide it.

## Own the public contract

Use a workspace when packages share releases, dependencies, and validation.
Centralize compatible dependency versions in `[workspace.dependencies]`.
Keep public types and behavior in a library; executables should adapt inputs,
call the library, and report outcomes through a supported host contract.
Use `rlib` for Rust consumers, `cdylib`/`staticlib` for explicit foreign consumers.
Those crate types do not establish a stable Rust ABI or a usable Wasm API.

Declare the edition, `rust-version`, license, and intended package contents.
Keep a reviewed lockfile for the reproducible workspace and use `--locked` in CI.
A library consumer resolves its own graph; test a clean packaged consumer too.
Pin the compiler independently of the minimum compiler version you promise.
An exact lockfile does not make time, filesystem order, or build output deterministic.

## Features select capabilities

Prefer additive features with small defaults. Keep host dependencies target-specific.
Inspect actual feature unification with `cargo tree -e features --target TARGET`.
`default-features = false` on one edge cannot disable a feature enabled elsewhere.
Test minimal, normal, and supported material combinations on their declared targets.
Do not substitute `--all-features` for a feature contract: internal, nightly,
mutually exclusive, or native-only features can make that command misleading.
An incompatible native dependency must not silently remove required Wasm behavior.

Use the current resolver appropriate to the edition and supported Cargo versions.
Set it explicitly in a virtual workspace. Resolver 3 accounts for incompatible
Rust versions differently from resolver 2; review dependency selection on upgrades.
Keep MSRV tests distinct from current-toolchain tests and optional nightly analysis.

## Profiles express a measured tradeoff

Start from Cargo defaults and measure the real edit/build/test loop.
Change optimization, debug info, codegen units, incremental work, and LTO separately.
Use a named fast build profile if release settings make normal work too expensive.
Reserve expensive release optimization for an artifact that benefits from it.
`opt-level = "z"` disables loop vectorization; it is not a universal Wasm default.
Compare code size, compilation time, startup, and representative runtime work.
Never use `target-cpu=native` for an artifact promised to a weaker CPU baseline.

Use `cargo build --timings` to locate expensive compilation units before splitting
crates or changing dependencies. `cargo check` omits code generation and linking;
it is a useful early check, but cannot prove a final native, FFI, or Wasm build.
Read artifact paths from Cargo JSON messages instead of guessing internal layout.

## Verify the decision

Record compiler/Cargo identities, lockfile hash, target, profile, features, flags,
workspace members, final artifact, and the runtime that actually executed it.
Check packaging from outside workspace links. Exercise the documented public API.
See [toolchains](toolchains.md), [build scripts](build-scripts.md), and [CI](ci.md).

Primary sources, reviewed 2026-11-26:
[workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html),
[features](https://doc.rust-lang.org/cargo/reference/features.html),
[resolver](https://doc.rust-lang.org/cargo/reference/resolver.html),
[profiles](https://doc.rust-lang.org/cargo/reference/profiles.html),
[build command](https://doc.rust-lang.org/cargo/commands/cargo-build.html).
