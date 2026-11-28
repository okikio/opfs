# Rust artifact and host evidence

Inventory actual Cargo metadata and manifests, including excluded workspaces,
tools, workers, explicit/implicit binaries and required features. Do not delete
a row because the target is difficult. Use one row per meaningful configuration.

| Package/target | Customer operation | Native OS/arch | Wasm target/host | Features/imports | Artifact/entrypoint | Compile proof | Runtime/equivalence proof | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | |

For each row, record:

- Exact compiler, dependency lock, runtime/generator versions and full source SHA.
- Allowed output/error differences, input/output encoding and ordering.
- CPU feature baseline and optional SIMD artifact selection.
- Allocation ownership, byte limits, callbacks/views, cancellation and cleanup.
- Runtime permissions, startup, generated glue and deployment assets.
- Exact validation commands, raw results and actual artifact hashes.

Allowed evidence labels: observed, source-backed, inferred, failed, blocked,
unrun. Define release readiness separately; source-backed support alone cannot
make a required runtime row pass.

A portable core build, empty stub, unsupported return, removed binary or remote
client of the native implementation does not prove equivalent Wasm behavior.
Name the unresolved host/design decision and the next useful probe.
