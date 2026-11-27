# Make Wasm support an executable product contract

Use this before adding a Rust package, binary, dependency, or public capability.
Use this reference when the project requires a working Wasm path. Inventory
which packages and binaries provide that path and which remain native-only.
An empty entrypoint, omitted binary, or permanent `Unsupported` result cannot
satisfy that requirement. If the operation cannot be supplied, keep the design
blocked and change the implementation or product contract explicitly.

## Record what must run

For every package and binary, record its owner, real entrypoint, customer
operation, input/output semantics, target triple, runtime/version, host imports,
feature set, memory limit, and executable acceptance test. Include build and
maintenance tools in the inventory; do not silently exempt them because they
are inconvenient. Cargo build scripts execute on the build host, which is a
different claim from target portability.

Separate these questions:

1. Can a build host produce the artifact?
2. Does the artifact validate in the deployment runtime?
3. Can its imports and required capabilities be supplied there?
4. Does the complete operation preserve the required behavior and limits?

A portable algorithm crate helps answer the first question. It does not prove
that a native worker, process launcher, networking stack, or UI works in Wasm.
Native and Wasm adapters may implement the same operation through different
host APIs. The executable contract must exercise those adapters.

## Choose the target from the host contract

| Target | Relevant contract | Required caution |
| --- | --- | --- |
| `wasm32-unknown-unknown` | Core module with explicit imports | It supplies no general operating-system interface |
| `wasm32-wasip1` | WASI Preview 1 core module | Confirm runtime imports, permissions, and required operations |
| `wasm32-wasip2` | WASI Preview 2 component | Requires a component-aware runtime, not plain browser instantiation |
| `wasm32-wasip3` | WASI 0.3 component with async facilities | First stable in Rust 1.100; check the exact runtime and threading status |
| `wasm32v1-none` | Minimal `no_std` core/alloc target | Useful when the actual contract requires that restricted feature set |

This is a selection table, not an obligation to ship every target. Select the
hosts the product needs, then make their gates mandatory. Support for Linux,
macOS, or Windows as build hosts does not identify the Wasm runtime feature set.

## Make the gate hard to evade

- Enumerate `cargo metadata` packages/targets and compare them with the ledger.
- Build every required artifact with its real feature set and locked resolution.
- Validate imports, exports, required Wasm features, and deployment size limits.
- Execute the same semantic fixtures through native and Wasm public adapters.
- Fail when an artifact or capability disappears from the matrix.
- Keep unsupported combinations explicit; a successful subset cannot green the
  whole release. Do not make a required gate `continue-on-error`.

Keep baseline and SIMD/threaded variants distinct. The baseline must preserve
correctness when optional acceleration is absent. Version the feature contract:
Rust's default Wasm features can change with LLVM and toolchain upgrades.

## Sources and freshness

Checked against Rust 1.100 documentation on 2026-11-26. Recheck at a toolchain
upgrade or host change, especially Preview 3 and default feature changes.

- [Minimal Wasm target](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)
- [Preview 2](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip2.html)
- [Preview 3](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip3.html)
