# Install the rules where decisions and checks happen

Use this when adopting the Rust policy in an existing repository. Preserve its
actual ownership, task families and current skill/handbook structure.
The companion complete pack includes visible skills, guides and handbook plus
the native repository layout. Do not install only a summary and discard detail.

## Connect authority before changing implementation

Route Rust work from the repository's `AGENTS.md` or skills router to this skill.
Link the project handbook's Rust procedure to the same requirement and evidence
contract. Keep existing product-question, planning, review, benchmark and writing
rules in force. Name the current source revision and adopted guide version.

Inventory all Cargo manifests, workspaces, excluded members and targets. Record
the required native/Wasm operation for every package and binary. Use the
`support-matrix.md` template when useful. Identify missing runtime capability,
not merely missing compiler flags. Establish the first direct probe for each
high-consequence unknown before planning a broad refactor.

## Put the gates in the repository's existing task owners

These are verified Cargo command forms, with scope chosen from the real graph:

```sh
rustc -vV
cargo --version
cargo metadata --locked --no-deps --format-version 1
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo test --workspace --doc --locked
cargo build --locked --target wasm32-unknown-unknown
```

This list is not a ready CI workflow or a claim that every repository can run
the same target. Select explicit packages/binaries/features from the inventory;
virtual workspace defaults and `required-features` can omit work. Do not add
`--all-features` blindly. Target builds must be followed by actual host execution
of each required operation. Choose browser, WASI/component and FFI runners from
the selected contract and verify their current CLI/API.

Keep artifact inspection and clean-consumer tests after packaging/staging.
Make changes to lockfiles, toolchains, Cargo configuration, build scripts,
embedded docs/assets, shared tests and transitive owners select affected checks.
An unknown path or empty unexpected selection must not report skipped success.

## Reduce work after proving selection completeness

Separate pure tests from timing, process, network and host fixtures. Reuse one
built test archive across compatible shards when supported. Check shard union,
duplicates and non-empty inventory. Keep doctests and Wasm runners explicit.
Use compiler/download caches with correct identities; keep writable target
directories isolated by worktree and relevant configuration.

Measure cold/restored/repeated/edit builds and total CI runner time. Preserve
cache transfer costs and contention. Wall-clock speed is useful only while the
same required checks and artifacts remain covered. See [CI](ci.md),
[sharding](sharding.md), [caching](caching.md) and [worktrees](worktrees.md).

## Make context loss recoverable

Keep the small mandatory contract in the skill entry point. Record the selected
topic files, full plan, evidence matrix, exact stopping point and next command
in the existing task record. After a reset, reload the entry point and record.
Use executable gates for omissions that prose cannot reliably prevent.

Adoption is complete only after a representative task exercises the routes and
the actual CI/host gates pass. Creating a guide or template does not modify a
live repository's CI or establish all future behavior.

Sources: [Cargo commands](https://doc.rust-lang.org/cargo/commands/),
[Cargo targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html),
[Cargo workspaces](https://doc.rust-lang.org/cargo/reference/workspaces.html).
