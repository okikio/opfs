# Make the C# consumer own managed/native lifetimes correctly

Use this when .NET calls a Rust library. Export a deliberately designed C ABI;
do not attempt to marshal ordinary Rust containers or rely on their layout.
Compile and test the actual .NET consumer before claiming C# support.

## Match the ABI exactly

On .NET 7 and later, Microsoft's guidance prefers source-generated
`LibraryImport` where supported. Use the analyzer's guidance for cases that
require `DllImport`. Specify entrypoint, calling convention where needed,
character encoding, return type, and parameter direction deliberately.

| Rust/C contract | C# consideration |
| --- | --- |
| Fixed-width integer | Match signedness and width exactly |
| `size_t` / native pointer width | Use the appropriate native-sized representation |
| Byte flag / discriminant | Avoid default bool/enum marshalling assumptions |
| UTF-8 pointer and byte length | Length counts bytes, not UTF-16 code units |
| Opaque owned resource | Use a SafeHandle with the matching Rust release function |
| Borrowed buffer | Keep its owner and pin alive for the complete native use |

A string's managed representation is not a general UTF-8 byte buffer. Be
explicit about conversion and allocation. Avoid `[Out] string`; Microsoft
documents unsafe runtime consequences. `StringBuilder` marshalling can copy
and allocate substantially; a correctly sized reusable buffer may fit better.

## Tie native lifetime to managed ownership

Use `SafeHandle` for owned native resources and implement the exact Rust
destructor once. Avoid a separate finalizer that can double-release the same
resource. Define whether release may run on the finalizer thread and what it
does during shutdown. Deterministic disposal should be available to consumers.

Never free a Rust allocation through a .NET allocator. If native code retains
a pointer beyond a call, a temporary pin or temporary array is insufficient.
Design an owned transfer, registered pinned region, or copied buffer with an
explicit release protocol. Measure long-lived pinning and retained memory.

For callbacks, keep function/context lifetime valid until unregister and
in-flight completion. Follow current runtime guidance for unmanaged function
pointers and `UnmanagedCallersOnly` where applicable. Do not let managed
exceptions escape through an unmanaged ABI. Map ordinary failures explicitly.

## Verify performance without removing safeguards blindly

Batch calls when transition/marshalling costs dominate. Do not apply
`SuppressGCTransition` by default: use it only for the narrow runtime contract
it permits after checking blocking, callbacks and GC consequences. Measure the
whole consumer operation, including encoding, copies, pinning and disposal.

Test empty/non-ASCII/binary values, output capacity, repeated create/use/dispose,
errors, callbacks and concurrent use. Check Windows and other promised native
ABIs. Separately test the Wasm adapter; successful native P/Invoke is not Wasm
support, and .NET browser integration may require a different host contract.

No .NET executable was available in the 2026-11-26 research environment. These are
source-backed rules and an acceptance plan, not a locally verified C# binding.

## Sources

- [Microsoft native interop guidance](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/best-practices)
- [P/Invoke source generation](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/pinvoke-source-generation)
- [GC transition suppression contract](https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.suppressgctransitionattribute?view=net-11.0)
- [Rust FFI](https://doc.rust-lang.org/nomicon/ffi.html)
