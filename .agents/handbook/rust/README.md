# Deliver Rust behavior on the required hosts

Start with the intended operation and the hosts the project actually supports. The [Rust skill](../../skills/rust-software/SKILL.md) owns implementation detail; the [Rust guide](../../guides/rust/README.md) connects it to shared quality and evidence rules.

Skills: `rust-software`, `plan-changes`, `build-devtools`, `benchmark-code`, `verify-behavior`.

| Decision | Procedure |
| --- | --- |
| What must work, and where? | [Declare the contract](contract.md) |
| What experiment can resolve the next design choice? | [Test the question](questions.md) |
| How are memory, streams and foreign resources kept correct? | [Ownership](ownership.md) |
| Which representation fits the operation and its lifetime? | [Data design](data-design.md) |
| How can build and CI cost change without skipping behavior? | [Builds and CI](ci.md) |
| What evidence and continuation make delivery usable? | [Delivery](delivery.md) |

Native, browser, Wasm, WASI, FFI and GPU behavior have distinct host contracts. Require real operations on every declared supported host. Do not add Wasm to a native-only project merely because this chapter discusses it, and do not weaken an explicitly required Wasm outcome when a host capability is unavailable.
