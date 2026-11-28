# Select byte and SIMD dependencies by a measured contract

Use this when standard operations do not meet an observed workload requirement.
These candidates are investigation starting points, not an automatic approved
bundle. Pin the resolved version, inspect features/transitives/unsafe code,
then execute the required native and Wasm consumer paths.

## Focused primitives often beat a custom unsafe subsystem

| Candidate checked on 2026-11-26 | Capability | Decision-changing constraint |
| --- | --- | --- |
| `memchr` 2.8.3 | Byte and substring search | SIMD implementations cover x86_64, aarch64, wasm32; feature/CPU selection differs |
| `simdutf8` 0.1.5 | UTF-8 validation | `basic` omits error positions; `compat` preserves streaming-relevant error information |
| `wide` 1.7.1 | SIMD-compatible fixed-width types | Integer operators wrap even in debug; NaN payload bits are not guaranteed |
| `pulp` 0.22.3 | SIMD abstraction and runtime dispatch | Verify actual architecture/operation support; portability can mean scalar fallback |

For byte search, compare the real size and match distribution. Throughput on
large absent-match input is different from latency on a tiny string. Reuse a
prepared substring finder when the same needle is searched repeatedly, but
include construction when the caller actually constructs it per operation.

`memchr`'s standard-library feature provides runtime SIMD CPU detection;
disabling it can change which native kernel is selected. A smaller feature
set is not automatically faster. Its algorithms operate on bytes, so text
validation and user-visible Unicode semantics remain the caller's job.

For UTF-8 validation, match error behavior before comparing speed. Replacing
`std::str::from_utf8` with a zero-detail error API can remove the offsets needed
to preserve partial stream input. `simdutf8` selects its Wasm SIMD kernel from
the compile-time `simd128` feature; ship/select an appropriate artifact.

For general vector math, explicitly compare overflow, saturation, rounding,
NaNs, subnormals, signed zero and reduction order. A fast answer to a different
numerical question is not an optimization. Check both scalar fallback and
accelerated paths, plus release size and compile time.

## Decide what a new dependency buys

Record capability owner, version/MSRV, license, direct/transitive features,
native code/build scripts, allocation behavior, feature detection, unsafe
surface, fallback, target matrix, test/benchmark evidence, and removal cost.
Repository ownership and a familiar maintainer are useful provenance, not
proof that every crate or release meets this contract.

Choose no dependency when a clear standard-library solution meets the need.
Choose a focused dependency when it reduces implementation/soundness cost and
demonstrably fits the product. Do not reimplement a mature SIMD parser simply
to reduce the manifest's dependency count.

For buffers, encodings, serialization, parallel execution and broader options,
use the [dependency catalogue](dependencies.md). Recheck the exact chosen version;
do not project these versioned notes onto an untested upgrade.

## Sources

- [memchr 2.8.3](https://docs.rs/memchr/2.8.3/memchr/)
- [simdutf8 0.1.5](https://docs.rs/simdutf8/0.1.5/simdutf8/)
- [wide 1.7.1](https://docs.rs/wide/1.7.1/wide/)
- [pulp 0.22.3](https://docs.rs/pulp/0.22.3/pulp/)
