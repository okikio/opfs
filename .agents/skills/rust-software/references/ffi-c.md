# Design a small C ABI with one owner per resource

Use this when Rust is consumed by C, C++, C#, or another native FFI host.
Keep a safe Rust API behind the adapter. The ABI is a separate, versioned
contract; exposing a Rust struct directly does not make it stable.

## Define the ABI explicitly

Use `extern "C"` and deliberately exported symbols. Rust 2024 requires unsafe
attributes such as `#[unsafe(no_mangle)]`; document the symbol-uniqueness and
ABI obligations. Use `#[repr(C)]` only for structs whose fields are all valid
ABI types. `String`, `Vec`, slices, trait objects, and ordinary Rust enums do
not become portable C parameters by being placed inside a C-layout struct.

| Contract | Required definition |
| --- | --- |
| Numbers | Width, signedness, overflow, enum/discriminant validation |
| Buffers | Pointer, element count, encoding, capacity where relevant |
| Empty input | Exactly which null/zero pairs are accepted |
| Results | Status codes, output initialization, error details and lifetime |
| Resources | Constructor, owner, borrowed uses, matching destructor |
| Callbacks | User context, thread, reentrancy, cancellation and unregister |
| Versioning | ABI version, layout/feature negotiation, compatibility policy |

Use explicit integer representations for foreign enum/bool inputs and validate
before converting to Rust values that have restricted valid bit patterns.
Use `usize`/`size_t` only when the native ABI intentionally uses pointer-sized
lengths. A serialized wire format usually needs fixed widths and endianness.

## Keep allocation and release in the same ownership protocol

Prefer caller-provided output buffers or opaque handles where suitable.
If Rust allocates, export the matching Rust release operation. Preserve exact
allocation metadata; do not free it with C `free`, C++ `delete`, or a managed
runtime allocator. A raw pointer plus length does not supply a guessed `Vec`
capacity or authorize reconstructing ownership from a borrowed slice.

Document whether failure consumes or preserves each input, and whether returned
data remains valid until the next call, handle mutation, or explicit free.
For async work, unregister callbacks and observe completion before freeing
callback state. A stale pointer cannot be made safe by an address-range check.

## Choose a deliberate failure policy

Use normal status/results for expected failures. Keep panics from escaping a
non-unwinding ABI: catching unwinding panics can map them to an error only if
the code was built with unwind support. `panic=abort` still aborts. Foreign
exceptions require the appropriate ABI/protocol; do not assume `catch_unwind`
is a portable exception catcher.

Generate headers from the owned Rust declarations when practical, then compile
an actual C/C++ consumer against the produced library. Header generation is
not ABI verification. Compare field sizes, offsets, calling convention and
exported symbols on the supported platforms, including Windows.

## Required consumer tests

Exercise empty and binary/non-ASCII input, small output capacity, repeated
allocate/use/free, errors, lifecycle invalidation and callbacks. Test invalid
inputs only where the API promises to handle them; deliberately violating an
unsafe pointer precondition is not a valid in-process correctness test.

The local Linux probe passed 2,565 cases and 513 Rust-allocation cycles through
C++20. It provides no C#, Windows, or cross-compiler ABI result.

## Sources

- [Rust FFI contracts](https://doc.rust-lang.org/nomicon/ffi.html)
- [Rust layout guarantees](https://doc.rust-lang.org/reference/type-layout.html)
- [Rust 2024 unsafe attributes](https://doc.rust-lang.org/edition-guide/rust-2024/unsafe-attributes.html)
- [cbindgen](https://github.com/mozilla/cbindgen)
