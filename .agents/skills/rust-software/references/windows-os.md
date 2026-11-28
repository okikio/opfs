# Verify Windows as its own native host

This file concerns Windows the operating system. For stream/chunk windows, read
[stream windows](stream-windows.md). A Linux build or successful Wasm build does
not establish a Windows native binary, DLL or C# consumer.

Record architecture, MSVC/GNU target, compiler/linker and native SDK requirements.
Match the actual consuming process architecture and ABI. Test `.dll` loading,
export names, calling conventions and dependent library discovery on Windows.
Keep the Rust allocator paired with Rust release functions across the ABI.

Use `Path`/`PathBuf` and `OsStr`/`OsString` for OS paths. Do not assume every
native path is UTF-8 or turn `to_string_lossy()` into a lossless storage format.
Define a separate portable path/identifier format for serialized contracts.
Test spaces, non-ASCII names, roots, drive prefixes, separators and case behavior.
Lexical path operations do not reproduce every filesystem's case/symlink rules.

Do not import `std::os::unix` or call Unix process/socket functions unconditionally
in a supposedly portable crate. Put platform custody and I/O behind actual host
adapters with equivalent documented behavior. Windows process termination,
inherited handles, console behavior and file-sharing semantics need real tests.
WASI/browser adapters have separate capability constraints again.

Test binary streams without assuming text-mode newline conversion is harmless.
Distinguish protocol CRLF rules from native text presentation. Keep exact bytes
through Rust/FFI boundaries when lossless input is the contract.

For C#, test the chosen .NET runtime and generated/manual interop on each claimed
native platform. Explicitly specify string encoding and ownership. Use safe
handle/lifetime patterns; a successful P/Invoke declaration does not establish
allocator, callback or cancellation correctness. See [C#](ffi-dotnet.md).

Use Windows CI for Windows-specific behavior, with a focused shared portable
suite plus host fixtures. Cross-check and cross-link are useful earlier gates,
but cannot replace runtime loading and resource lifecycle checks.

Sources: [Windows target](https://doc.rust-lang.org/rustc/platform-support/pc-windows-msvc.html),
[paths](https://doc.rust-lang.org/std/path/index.html),
[OsStr](https://doc.rust-lang.org/std/ffi/struct.OsStr.html),
[Windows Rust bindings](https://github.com/microsoft/windows-rs),
[.NET interop](https://learn.microsoft.com/en-us/dotnet/standard/native-interop/best-practices).
