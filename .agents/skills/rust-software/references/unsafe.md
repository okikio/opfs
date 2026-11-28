# Keep unsafe code small enough to explain and test

Use this for SIMD loads, raw buffers, FFI, custom containers, allocation, and
concurrency primitives. Safe Rust remains the default. `unsafe` transfers proof
obligations to the author; it does not relax aliasing, validity, or lifetime rules.

## Write the invariant before the unsafe operation

For each block, state which fact makes the operation valid and where that fact
was established. A comment saying "safe because checked" is insufficient when
the check covers length but not ownership, initialization, aliasing, or CPU
features. Keep the unsafe operation adjacent to the evidence it relies on.

For every exported unsafe function, write a `# Safety` section describing caller
obligations. Put ordinary fallible validation in a safe wrapper when possible.
Do not expose a safe function whose callers can supply a dangling pointer or
violated lifetime and thereby trigger undefined behavior.

Enable `unsafe_op_in_unsafe_fn` as a deny-level lint in owned code so unsafe
operations require explicit blocks. Use Clippy's safety-documentation checks
where they fit the repository. Prefer a small reviewed unsafe module over
scattered annotations or a broad lint suppression.

## Raw slices need more than a non-null pointer

`slice::from_raw_parts` requires one live allocation, correct alignment,
initialized elements, valid lifetime and aliasing, nonwrapping size no greater
than `isize::MAX`, and a non-null pointer even for zero length. An FFI wrapper
may accept a null/zero pair by handling it before creating a Rust slice.
Adjacent allocations do not become one allocation merely because addresses
happen to touch. Checking an address numerically cannot prove it is live.

Do not read uninitialized spare capacity, use `set_len` before initialization,
guess a `Vec` capacity for reconstruction, or create aligned references to
packed/unaligned fields. Preserve provenance and ownership when moving between
raw pointers and safe wrappers. Bounds checks do not repair an invalid pointer.

## Validate according to the failure being prevented

- Unit/property tests: semantic behavior, ranges, tails, state transitions.
- Miri: supported Rust interpreter executions for memory-model violations.
- Sanitizers: supported native builds for memory/race problems under workloads.
- Fuzzing: input/state-space exploration against an independent oracle.
- Loom: modeled small synchronization protocols and selected schedules.
- Actual Wasm/native consumers: ABI, host lifecycle, imports, and target behavior.

These checks complement review; none proves all executions sound. Miri may not
support a target intrinsic or foreign call. Test the safe/scalar layer there,
record the unsupported operation, and exercise the actual kernel separately.
Do not suppress a failure and call the whole unsafe path validated.

## Panics and exceptions need an explicit policy

Ordinary errors should use the API's error channel. A panic crossing a
non-unwinding C ABI aborts; a foreign exception entering it can be undefined
behavior. `catch_unwind` does not catch `panic=abort` and is not a general
foreign-exception shield. Keep cleanup and ownership valid on each supported
failure path, and test the panic policy in a subprocess where appropriate.

## Sources

- [Raw-slice safety contract](https://doc.rust-lang.org/std/slice/fn.from_raw_parts.html)
- [FFI and unwinding](https://doc.rust-lang.org/nomicon/ffi.html)
- [Miri scope and usage](https://github.com/rust-lang/miri)
- [Rust 2024 unsafe extern declarations](https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-extern.html)
