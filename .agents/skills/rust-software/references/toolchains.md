# Give Rust one toolchain authority

Use this page when configuring Cargo, Rustup, Mise, CI, editors, or worktrees.
Pin an exact stable compiler for production unless a measured requirement needs
a dated nightly. Record the reason, owner, and removal condition for nightly use.
Keep `rust-version` as the minimum supported compiler contract, not the CI pin.

A repository `rust-toolchain.toml` can own the channel, profile, components,
and targets. Keep CI and the editor on that same resolved toolchain.
Do not duplicate a version in several files without an executable agreement check.

```toml
# Example shape; choose the version and targets the product has validated.
[toolchain]
channel = "1.100.0"
profile = "minimal"
components = ["rustfmt", "clippy"]
targets = ["wasm32-unknown-unknown", "wasm32-wasip1", "wasm32-wasip2"]
```

Installing a target supplies compilation support. It does not install a browser,
WASI runtime, C linker, SDK, FFI consumer, or proof that an artifact executes.
Declare and pin those tools separately when the capability requires them.

## Check Mise precedence

Mise installs Rust through Rustup and sets `RUSTUP_TOOLCHAIN`.
Rustup gives that variable higher priority than `rust-toolchain.toml`.
A global Mise Rust entry can therefore override a repository file silently.
When the file is authoritative, configure Mise to read Rust idiomatic version
files locally and verify the effective value. The documented command is:

```sh
mise settings add --local idiomatic_version_file_enable_tools rust
mise exec -- rustup show active-toolchain
mise exec -- rustc -Vv
mise exec -- cargo --version
```

Check current Mise help before writing configuration during an upgrade.
An installed plugin named `rust` can override Mise's built-in implementation.
Use `mise exec` or the project's task for CI parity; shell activation alone
does not establish what a child process, editor, or coding agent invokes.
Pin auxiliary Cargo tools independently and use their reviewed lockfiles.

## Make differences visible

Capture effective compiler commit, host triple, LLVM, Cargo, linker, SDK,
Wasm runner, browser, and benchmark versions with an experiment or release.
Record flags and relevant feature sets. Capture source and lockfile hashes.
Fail a required lane on a missing target or runner; do not silently substitute native.
Use an explicit optional analysis lane for Miri, sanitizers, or experimental APIs
when that lane needs a different compiler. Its success does not replace release tests.

Before updating Rust, compare native/Wasm outputs and FFI behavior, not just builds.
Measure cold build and edit/rebuild costs using the same inputs and cache state.
Check changed target defaults and generated code before repeating SIMD claims.
Keep old experiment results versioned so a new compiler does not rewrite history.

Record `rustc -Vv` and `cargo -V` for each relevant result. A past experiment
is not a reason to freeze later projects on its compiler version. Recheck
current target and tooling support when adopting the result.

Primary sources:
[Rustup overrides](https://rust-lang.github.io/rustup/overrides.html),
[Mise Rust](https://mise.jdx.dev/lang/rust.html),
[Cargo rust-version](https://doc.rust-lang.org/cargo/reference/rust-version.html).
