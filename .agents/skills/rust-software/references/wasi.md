# Select a WASI interface that the deployment implements

Use this for command-line programs, server/worker components, or portable host
facilities. WASI versions and the Component Model are deployment contracts,
not interchangeable spellings of a compiler target.

## Pin target, interface, and runtime together

`wasm32-wasip1` produces a core module using Preview 1 interfaces.
Its standard-library process and thread creation are unsupported; a filesystem
operation instead depends on the provided WASI capability. It explicitly
supports C/C++ interoperability with compatible target toolchains.
`wasm32-wasip2` produces a component and requires a component-aware runtime with
Preview 2 support. A browser's ordinary `WebAssembly.instantiate` does not
directly provide that component environment.

Rust 1.100 introduces stable `wasm32-wasip3`; its documentation requires WASI
0.3 and async Component Model support. The same document still describes
cooperative threading as incomplete in the default configuration. Treat those
operations as independently testable claims; the phrase "supports std" is not
proof that every standard-library operation works.

Record the compiler, target, component interface versions, generator, runtime,
flags, permissions, environment, and host adapters. Recheck published release
notes and executable behavior before changing any of them.

## Preserve product behavior across adapters

Map filesystem access to explicit directory capabilities. Define network
permissions, clocks, random data, stdout/stderr, exit status, arguments, and
cancellation. If the selected runtime lacks a required operation, keep the
capability gate failed; do not hide it behind conditional compilation.

For components, choose a WIT world that states required imports and exported
operations. Version serialized data and error behavior separately from the
Rust internal types. WIT strings, lists, resources, futures, and streams carry
different ownership and lifetime contracts; select only the features supported
by the actual interface and runtime versions.

## Keep commands and verification concrete

Build the named package and target with the pinned toolchain and lockfile.
Validate the produced module/component, enumerate imports, then run the public
operation with the actual runner. Capture permission-denied behavior as well
as success. A successful `cargo check` is not a runtime result.

For a test harness that cannot create threads, a supported sequential runner
may exercise pure logic; it cannot establish the product's parallel execution.
Use `--test-threads=1` only when the chosen harness supports it and sequential
execution answers the question. Record host warnings and the narrower coverage.

For Preview 3, separately probe async cancellation, stream termination,
resource drop, and any required cooperative threading. Do not promote an
experimental custom-sysroot result to a default stable-runtime guarantee.

## Sources

- [Preview 1 target](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip1.html)
- [Preview 2 target](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip2.html)
- [Preview 3 target](https://doc.rust-lang.org/rustc/platform-support/wasm32-wasip3.html)
- [WIT interface model](https://component-model.bytecodealliance.org/design/wit.html)
