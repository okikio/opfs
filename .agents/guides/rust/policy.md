# Require the complete Rust operation to work

Use this policy when selecting a dependency, designing a crate or binary,
reviewing portability, or deciding whether a change is ready to deliver.
Apply the [product method](../product/README.md) and the Rust skill's mandatory
[contract](../../skills/rust-software/references/contract.md) together.

## Every maintained artifact has a declared host contract

Inventory actual Cargo packages and targets, including implicit binaries,
excluded workspace members, generated targets, workers, maintained executable examples,
and internal tools. Folder names such as `crates/` and `workers/` describe
placement; they do not establish the artifact's ownership or portability.

For each artifact, record the customer or operator operation, required native
and optional Wasm hosts, runtime/version, imports, feature set, permissions,
entrypoint, error behavior, limits, and proof. Use the
[support matrix](../../skills/rust-software/assets/support-matrix.md) when useful.

Each required operation must execute with its agreed semantics on every host
the project claims. Wasm is required when the project contract includes it. A compiled helper library does not prove the full worker works.
Deleting a target from CI, returning success without doing the work, skipping
a required feature, or remotely invoking the original native service cannot
satisfy the portability requirement.

If the operation cannot be implemented on the intended host, record the exact
conflict and smallest next test. Investigate another implementation or host
interface. Ask only when the remaining product or deployment choice requires
the user. Preserve the failing acceptance row; do not invent an exemption.

Cargo build scripts and procedural macros run on the build host. Record this
construction step separately from target execution. Keep reusable generator
logic independent of host details when that serves its consumers. A native
build hook does not need a Wasm build unless its own contract requires one;
a hook building a Wasm product does not prove that product runs correctly.

## Preserve correctness and ownership while improving cost

- Start with a clear safe implementation and an independent expected result.
- Make every buffer, view, handle, callback, thread, and task lifetime explicit.
- Bound records, queued bytes, retained capacity, and offset arithmetic before
  growth. Cover the 32-bit Wasm case as well as native pointer widths.
- Preserve stream results across arbitrary chunk splits, final partial input,
  malformed data, cancellation, and buffer reuse.
- Keep scalar and accelerated semantics equivalent. Native CPU dispatch and
  Wasm artifact selection require different support checks.
- Keep C ABI, C++ bridge, .NET marshalling, and Wasm bindings explicit. Test the
  consumer's allocation, release, encoding, panic, and error contracts.

## Prefer the smallest justified tool and dependency surface

Use Rust and Cargo conventions for Rust-owned generators and build mechanics.
CI coordinates the owners; it does not duplicate their implementation in another
language. Review exact dependency features, source, target support, licenses,
transitives, unsafe code, and build cost. A focused dependency can be safer and
cheaper than maintaining a replacement; a small manifest alone proves little.

Measure before choosing manual SIMD, arenas, custom containers, extra threads,
GPU paths, or broad generic abstractions. Count runtime work, compile time,
binary size, and maintenance costs that affect the decision. No abstraction
label or benchmark from another workload establishes a local improvement.

For data design, follow [the operation and lifetime procedure](data-oriented-design.md).
Map fields and passes first. Isolate layout, string ownership and allocator
effects; compare complete lifecycle cost and post-request retention as well as
hot scans. Keep source-derived models distinct from the production representation.

## Make missing evidence visible

Required target or host failures block the corresponding delivery claim.
Cross-compilation, unit tests, an API smoke test, and a customer-flow test prove
different things. Use [the evidence contract](evidence.md) to state what ran,
what failed, what was blocked, and which decision the result supports.
