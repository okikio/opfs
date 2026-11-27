# Explain the invariant where it is maintained

Write crate docs for the consumer's job, normal path, supported targets and
host requirements. Document public operations and the important private state
that controls correctness, memory, concurrency or performance.
Use rustdoc `///` for items and `//!` for modules/crates. Apply ordinary Rust
naming and rustdoc conventions rather than copying TypeScript's TSDoc syntax.

A useful explanation states what the operation does, why the contract exists,
who owns its input/output, and what changes on success or failure. Add examples
with real expected results. Keep one coherent narrative instead of repeating
the signature in prose.

## Include the details a caller cannot infer

- Units, valid ranges, encoding, ordering and overlap rules.
- Whether input is borrowed, copied, mutated, retained or transferred.
- Whether an arena reset, buffer growth, callback return or async yield
  invalidates a reference or foreign view.
- Partial progress, retry/cancellation semantics and cleanup after failure.
- Allocation/CPU bounds and why a limit exists.
- `# Errors`, `# Panics` and `# Safety` where the operation has those contracts.

For each unsafe block, explain the concrete facts that satisfy its preconditions
at that location. "Safe because tested" is not a safety argument. Explain bounds,
alignment, initialization, provenance, aliasing, lifetime and CPU features as
applicable. Exported unsafe operations also need the caller's safety contract.

For example, a SIMD comment should explain why the full lane remains readable
and why dispatch has established CPU support. A tail comment should explain why
it does not load past the allocation. A stream state field should define whether
its offset counts received bytes, consumed bytes or the start of retained carry.

## Keep examples and build inputs real

Prefer doctests that compile and use `?` in examples where failure is ordinary.
Do not invent a public API to make documentation simpler. Mark illustrative
commands and required substitutions; verify reusable commands with current help.
Document feature flags and host imports at the actual package entry point.

If `include_str!`, `include_bytes!`, a shader compiler or generator consumes a
document, schema or asset, it is a build input. Ensure CI selection, package
include rules, staging and containers retain it. A Markdown extension does not
make a compile-time input documentation-only.

Keep claims scoped: implemented source, documented upstream behavior, locally
observed result, inference, proposal or unverified host. A source claim is useful
evidence, but it must not become a reported benchmark or runtime test.

Use concise plain English, concrete names and one term per concept. Comments
should explain a reason or non-obvious rule. Do not narrate obvious assignments.
Update comments with behavior and inspect generated rustdoc with warnings visible.

Sources: [rustdoc](https://doc.rust-lang.org/rustdoc/how-to-write-documentation.html),
[API documentation](https://rust-lang.github.io/api-guidelines/documentation.html),
[include_str!](https://doc.rust-lang.org/std/macro.include_str.html),
[Cargo package](https://doc.rust-lang.org/cargo/commands/cargo-package.html).
