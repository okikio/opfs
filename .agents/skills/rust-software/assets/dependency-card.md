# Dependency decision

- Required capability and customer cost:
- Existing standard-library/local owner and why it is insufficient:
- Exact registry package, canonical repository, release/revision and license:
- MSRV, edition, features, direct/transitive dependency graph:
- Build scripts, procedural macros, native code, linker and generator inputs:
- Native/Wasm host contract and optional accelerator/fallback behavior:
- Ownership, allocations, copies, unsafe surface and failure semantics:
- Current maintenance/security evidence and source of each claim:

| Candidate | Correctness/semantics | Native/Wasm proof | Runtime/memory | Build/size | Decision |
| --- | --- | --- | --- | --- | --- |
| Standard/library baseline | | | | | |
| Candidate | | | | | |

Keep exact inputs, seeds, versions, flags and raw benchmark output. Compare equal
work and guarantees. Documented SIMD or a respected maintainer is not a measured
speed or compatibility result. Include rejection reasons and revisit triggers.

- Smallest direct experiment and actual result:
- Known limitations and unrun hosts:
- Selected owning package and public API:
- Consumer migration, removal and rollback implications:
- Required acceptance tests and performance budget:
