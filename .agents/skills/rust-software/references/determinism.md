# Define which result must repeat

Determinism can mean identical semantic output, exact serialized bytes, stable
test outcomes, reproducible binaries or comparable benchmark measurements.
Name the required level before selecting algorithms, parallelism or build flags.
One kind does not imply the others.

## Make data and execution stable where the contract requires it

Specify order for maps, sets, event emission and parallel reductions. Use an
ordered representation or explicit sorting at serialization. Keep hash-flood
protection for untrusted input; do not replace a secure hash strategy merely to
obtain repeatable iteration. Seed generated fixtures and record their version.
Inject clocks, IDs and randomness when they are inputs to a deterministic core.

Use fixed-width numbers in persisted/wire contracts and checked conversion to
`usize`. Native64 and Wasm32 do not share a pointer width. Specify endianness,
overflow behavior, rounding, canonical strings and malformed-input handling.
Do not serialize a struct's raw memory or a Rust enum's default layout.

Floating-point reductions can change with grouping, SIMD, thread schedules,
fused operations and GPU precision. Define exact versus tolerant comparison,
the tolerance's physical meaning, and treatment of NaN/infinity/signed zero.
Rust does not promise identical NaN payload bits across targets/operations.
Do not use an unexplained large epsilon to hide a wrong algorithm.

Parallel work needs deterministic publication when order matters. Retain input
indices and publish in a defined order, or explicitly document unordered output.
Test cancellation and retry so a late task cannot overwrite terminal state.

## Pin inputs without overstating build reproducibility

Use an exact toolchain, committed lockfile, selected features/targets, linker,
build scripts, native libraries and generated inputs. `--locked` prevents a
lockfile change; it does not make the network, compiler or environment immutable.
`--offline` limits network use; it does not prove the cached graph is complete.

For byte-for-byte release reproducibility, build twice in independent clean
directories with the declared environment. Compare artifacts and investigate
paths, timestamps, ordering, generated files and native tools. Use path remapping
or timestamp controls only after inspecting the actual source of variation.
Do not claim a single successful cached build proved reproducibility.

Keep benchmark identity separate for target/runtime/compiler/profile/features,
corpus and hardware. Shared output directories can accidentally compare native
and WASI results under the same benchmark name. Separate their baselines.

Sources: [f32 guarantees](https://doc.rust-lang.org/std/primitive.f32.html),
[HashMap](https://doc.rust-lang.org/std/collections/struct.HashMap.html),
[Cargo build flags](https://doc.rust-lang.org/cargo/commands/cargo-build.html),
[build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html).
