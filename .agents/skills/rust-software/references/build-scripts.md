# Build Rust-owned artifacts through Cargo

Use this page for small generators, native bindings, build scripts, and task tools.
Choose the least machinery that makes the operation reproducible.

| Operation | Owner |
| --- | --- |
| Compile ordinary Rust source | Cargo, without a custom build script |
| Generate private data needed to compile a crate | A small `build.rs` |
| Refresh checked-in generated source on demand | An explicit Rust task with check/write modes |
| Compose existing Cargo commands | The repository's existing task runner or Cargo alias |
| Compile a required C/C++ dependency | Cargo build integration with the target's verified native toolchain |

An `xtask` is a community convention implemented with a Cargo alias and Rust
package. It is not a built-in Cargo subcommand. Add one only when task logic
justifies it; keep Mise as the existing task entrypoint when the project uses it.
Do not introduce JS, Python, or a shell framework to own a small Rust generator.
Foreign host adapters and experiment capture tools are different responsibilities.

## Keep cross-compilation honest

Cargo compiles and runs `build.rs` and procedural macros on the build host.
The product crate may be compiled for Wasm at the same time.
In `build.rs`, `cfg!` and `#[cfg]` describe that host. Use `TARGET`, `HOST`,
and `CARGO_CFG_*` environment inputs when choosing target behavior.
Do not run a target executable on the host to discover target layout.
Do not assume the host compiler or system library can produce a Wasm object.

Compiler build scripts are host build machinery, not evidence that a shipped
executable supports Wasm. A task executable needs Wasm execution only when its
own supported-host contract requires it. If that requirement cannot be met, change
the design or avoid introducing that executable; do not invent an exemption.

## Make generation reproducible and cheap

Write crate-private build output only below `OUT_DIR`.
Treat that directory as persistent: replace owned outputs explicitly and remove
obsolete owned outputs when the generator's contract requires it.
Emit `cargo::rerun-if-changed=...` for real input files and
`cargo::rerun-if-env-changed=...` for relevant external configuration.
Do not rerun because an unrelated repository file changed.
Do not read undeclared network data, the clock, arbitrary environment variables,
or filesystem iteration order to produce deterministic source.
Pin source datasets, generator inputs, encoding, sort order, and normalization.

Provide a check mode for checked-in generated files. It must fail on drift.
Keep check mode read-only and write mode explicit.
Use ordinary Rust parsing/types rather than text replacements when structure matters.
Do not regenerate unrelated human-owned code or documentation.
Track the input and generator version beside a derived table or header.

Propagate subprocess failures with the command, target, and useful stderr.
Do not report success after a missing generator, failed native compiler, or stale output.
When a task promises a total deadline, apply it to metadata discovery, generation,
subprocesses and cleanup. Bound captured output and reap children on cancellation.
Keep any unavoidable external compiler invocation behind the Cargo build owner.
Prefer an existing vetted `cc`/binding tool integration over a hand-written linker driver.

## Test the build contract

Check first build, unchanged rebuild, changed input, removed input, and clean output.
Run the generated product on the intended target, including Wasm.
Check the archive/package includes the generator inputs a clean consumer needs.
Compare output bytes across two clean generations where byte determinism is promised.
Record changes in generation time separately from Rust compilation and linking.

Primary sources, reviewed 2026-11-26:
[Cargo build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html),
[build environment](https://doc.rust-lang.org/cargo/reference/environment-variables.html),
[xtask convention](https://github.com/matklad/cargo-xtask/tree/1559f86ece1f32ce1c41ed00fc15bbff2a386217).
