# Integrate C++ through a verified language contract

Use this for Rust embedded in C++ or Rust consuming a C++ library. First choose
whether a small C ABI is sufficient. Choose CXX when its supported type and
ownership model materially reduces the amount of handwritten unsafe binding.

## Compare the two integration shapes

| Shape | Benefit | Work that remains |
| --- | --- | --- |
| C ABI | Broad language reach, small stable protocol | Explicit ownership, status, layout, headers and safety wrappers |
| CXX bridge | Generated paired bindings and type checks | Supported-type limits, unsafe C++ implementations, build/target proof |

CXX statically checks its described Rust/C++ interface and generates both sides.
That does not validate arbitrary C++ pointer behavior, hidden aliases, callback
lifetime, or concurrent mutation. Keep the Rust API safe only when every
foreign implementation satisfies its documented obligations.

Do not repeat an upstream "zero overhead" statement as a product measurement.
Inspect the selected types and generated bridge for copying, allocations,
encoding conversion, ownership changes and exception handling. Measure the
consumer operation, including the work on both sides of the call.

## Preserve ownership instead of translating blindly

Borrow views only while the owner stays alive and unmodified. Use the bridge's
supported ownership types deliberately; a moved `UniquePtr` and a borrowed
reference have different lifetime consequences. Do not export raw Rust
`String`/`Vec` layout as a C++ standard-library layout.

Review callbacks for capture lifetime, execution thread, cancellation and
unregister-before-destroy. C++ exceptions and Rust panics need separate handling.
In current CXX documentation, an exception through a non-`Result` C++ function
terminates, and a panic in an exposed Rust function aborts even when it returns
`Result`. A normal Rust error translated through `Result` is not the same as a
panic. Test the selected policy in the real consumer.

## Keep builds owned and reproducible

Use Cargo's build-script convention with the selected binding generator and
C++ compilation crate when those are actual build prerequisites. Build scripts
run on the host: use Cargo's target configuration, declared inputs and output
directory correctly. Do not introduce an external scripting system merely to
compile a small Rust-owned helper.

For Wasm, verify both languages' target, linker, standard library, exceptions,
and imported host facilities. A native CXX example passing does not establish
Wasm linkage. The Rust core still needs its working Wasm capability path; do
not exempt an operation because the chosen native dependency cannot compile.

## Minimum acceptance evidence

Compile the generated header/bridge with the real consumer compiler. Test
empty and binary data, ownership transfer, repeated destruction, returned
errors, callbacks, and thread use. Verify exports and release packaging on
every supported ABI. Keep native and Wasm results separate in the ledger.

## Sources

- [CXX design and example](https://cxx.rs/)
- [CXX Result and exception behavior](https://cxx.rs/binding/result.html)
- [Cargo build scripts](https://doc.rust-lang.org/cargo/reference/build-scripts.html)
- [Wasm C/C++ target considerations](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)


Read the [reproducible evidence requirements](evidence-index.md) before relying on a research observation.
