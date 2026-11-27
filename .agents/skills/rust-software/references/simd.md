# Accelerate a measured kernel without changing its answers

Use this when representative profiling identifies a data-parallel cost.
First remove avoidable work, improve layout, and measure ordinary optimized
Rust. Explicit vectors are justified when they improve the required workload
enough to pay for code size, dispatch, build time, and maintenance.

## Choose the lowest-cost sufficient approach

1. A clear scalar implementation with contiguous slices and visible loop bounds.
2. A focused, reviewed primitive such as byte search or UTF-8 validation.
3. A portable SIMD abstraction with verified target coverage and semantics.
4. Small target-specific intrinsics behind a safe public wrapper.

Keep a simple reference implementation or independent oracle. Check the current
`std::simd` stability contract before selecting it. If it requires nightly, do
not silently add nightly to a stable project. Stable `std::arch` intrinsics and vetted stable crates remain options.
Portable vector types do not guarantee a single instruction or SIMD on every
target; examine generated code for the selected operation and feature set.

## Native dispatch and Wasm selection differ

On native targets, guard architecture-specific code with `cfg` and prove the
required feature before entering a `#[target_feature]` kernel. Runtime CPU
detection supports a broad baseline binary. `target-cpu=native` is appropriate
only when deployment CPUs are intentionally restricted; it is not a portable
release default. Do not infer ARM features from x86 results.

For Wasm, unsupported instructions can prevent module loading even when the
function would not be called. Build a baseline artifact without SIMD code and
a separate `simd128` artifact. Let the host validate/detect the feature before
selecting the accelerated artifact. `cfg(target_feature = "simd128")` excludes
the kernel from the baseline; an unconditional target-feature function can
accidentally keep SIMD requirements in it.

## State the kernel's exact invariants

- Process full vector-width blocks and a correct scalar tail.
- Use unaligned loads when alignment is not guaranteed; never read past input.
- Match overflow, saturation, signedness, comparison, and reduction semantics.
- Define floating-point tolerance, NaNs, signed zero, subnormals, FMA behavior,
  and reduction order. Relaxed SIMD needs an explicit numerical contract.
- Count units correctly: bytes, elements, lanes, and bit masks are different.
- Bound lengths and offset arithmetic for 32-bit Wasm as well as 64-bit hosts.

No generic speed claim follows from the presence of SIMD. Measure short inputs,
tails, aligned/unaligned data, realistic distributions, and large scans. Include
dispatch, allocations, conversion, and transfer when the product pays those
costs. Record which kernel and feature set actually executed.

## Required evidence before adoption

Compare full results over all short lengths around each vector width, every
relevant alignment, high-bit bytes, zero/matching/nonmatching lanes, malformed
inputs, and randomized cases with saved seeds. Execute baseline and SIMD Wasm
artifacts in required hosts. Run native paths on the architectures claimed.

Retain the executed input set and host/artifact identities. Report the exact
coverage of the probe; a kernel result does not establish a general production
performance result or untested architecture support.

## Sources

- [Portable SIMD status and semantics](https://doc.rust-lang.org/std/simd/index.html)
- [Wasm intrinsics and artifact requirements](https://doc.rust-lang.org/core/arch/wasm32/index.html)
- [Target-feature safety](https://doc.rust-lang.org/reference/attributes/codegen.html)


Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
