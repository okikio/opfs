# A declared host must support the required operation

Read before choosing dependencies, host APIs, crate boundaries or CI targets.
Wasm is an instruction format with a host interface. An operating system that
runs a Wasm engine does not automatically supply browsers, sockets, processes,
threads, files, GPUs or a particular WASI version.

## Inventory what is actually delivered

Use `cargo metadata --no-deps --format-version 1` at the repository's pinned
toolchain. Record each package and target kind, explicit/implicit binaries,
features, generated files and publication/container consumers. Include crates
outside the root workspace and excluded members. Check actual artifact contents.

For each maintained package and binary, record the supported hosts. Mark Wasm
not required when the current project does not promise it; do not add that
product requirement implicitly. For each required host, record:

| Field | Required meaning |
| --- | --- |
| Operation | The customer behavior, including failures and cleanup |
| Native hosts | OS, architecture, minimum CPU contract and runtime |
| Wasm target | Exact target triple and required feature set |
| Wasm host | Engine/browser version, imports, WASI world and permissions |
| Entry point | Actual callable export, command or component interface |
| Equivalence | Inputs, outputs, errors, limits and allowed differences |
| Proof | Compile, instantiate and execute commands with dated evidence |

Use [Wasm targets](wasm-targets.md), [hosts](wasm-hosts.md) and [WASI](wasi.md)
to select the host. Keep host requirements visible in the package documentation.

## Keep the product contract intact

Separate pure computation from capability adapters when this reduces host
coupling. Reuse the same computation and tests where possible. Give each adapter
an actual caller and explicit resource lifetime. Test the complete operation
through the adapter. A portable library is one part of a portable worker.

A CLI may use a WASI command entry point and a browser integration may expose
the same operation as an async export. These are different artifacts and hosts;
name both. A browser cannot reproduce arbitrary OS process supervision merely
because a native process module has been hidden with `cfg`.

If a required capability has no usable Wasm implementation, record a blocking
design conflict. Research another host interface or implementation, or ask for
the necessary product decision. Never waive the requirement by labeling the
binary "internal", deleting it from the matrix, returning success without work,
or shipping only a native implementation behind a remote Wasm client.

Cargo build scripts and procedural macros execute on the build host. Record
that host/target split explicitly. Test the product on its required target; a
successful host macro build does not close the product's Wasm row. Test a
generator on Wasm only when its own supported-host contract requires it. Keep
host hooks and portable logic distinct where that serves real consumers.

## Gate behavior, not green checkmarks

1. Compile every declared target/feature configuration with the lockfile and
   pinned compiler. Do not let `required-features` silently omit a binary.
2. Inspect exports/imports, startup and generated bindings. Load the actual file.
3. Execute at least one meaningful valid case and each important failure path
   on the declared host. Use the same semantic oracle across adapters.
4. Exercise ownership, allocation growth, cancellation and limits where relevant.
5. Record unavailable hosts as unverified. Cross-compilation alone does not prove
   Windows, macOS, browser policy, a C# consumer or GPU availability.
6. Check default, minimal and selected combined features. `--all-features` is
   neither a portable default nor proof of every supported combination.

For Wasm SIMD, use separate baseline and accelerated artifacts when hosts vary.
Test host feature selection before instantiation. A branch inside a module
cannot rescue an engine that rejects an unsupported opcode at validation time.

Sources: [target support](https://doc.rust-lang.org/rustc/platform-support.html),
[unknown host](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html),
[Cargo targets](https://doc.rust-lang.org/cargo/reference/cargo-targets.html),
[Cargo features](https://doc.rust-lang.org/cargo/reference/features.html).
