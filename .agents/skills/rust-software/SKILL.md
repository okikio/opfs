---
name: rust-software
description: Research, design, implement, review, test, benchmark and deliver Rust packages, binaries, workers, Cargo tooling, SIMD, Wasm and native FFI. Use for Rust source or dependencies, memory and streaming correctness, C++/C# bindings, data-oriented layouts, GPU/ML/UI choices, toolchains, worktrees and CI. Verify declared target support, resource ownership and measured performance. Apply Wasm requirements when the project selects that host.
---

# Deliver portable Rust product capabilities

Read [the contract](references/contract.md) and
[the host support contract](references/portability.md) for every Rust task.
Then read only the decision-specific references below. Each is a short complete
unit. Recover truncated reads. Keep one product question, plan and verdict with
the repository's current skills/guides; do not build a competing workflow.

## Establish the work before implementing

Identify the customer outcome, decision, consequential unknowns, current source
and smallest useful probe. Start experiments early and alternate them with
research. Retain failures and exact conditions. Choose a useful timebox from
the decision and probe cost; do not pad solved work or invent observations.

Inspect actual Cargo workspaces/targets, feature sets, consumers, build inputs,
host imports, resource ownership and existing CI. Read the applicable repository
guides. Ask only for missing intent that changes the decision; resolve technical
unknowns through source and narrow execution.

Inventory every maintained package and binary and identify its declared hosts.
Require real Wasm execution when Wasm belongs to that product contract; a
native-only project does not acquire a Wasm requirement by using this skill.
A compiled core, empty stub or skipped required operation does not satisfy a
claimed host. Keep an unmet required host explicit and investigate the conflict.

## Select references by the decision

| Decision | Read before making it |
| --- | --- |
| Native/Wasm architecture and artifact inventory | [Portability](references/portability.md), [targets](references/wasm-targets.md) |
| Browser and WASI runtime behavior | [Hosts](references/wasm-hosts.md), [WASI](references/wasi.md) |
| JavaScript/Wasm ownership and bindings | [Bindings](references/wasm-bindings.md) |
| SIMD code, feature dispatch and fallbacks | [SIMD](references/simd.md) |
| Allocation, lifetime and resource bounds | [Memory](references/memory.md) |
| UTF-8, byte strings and copies | [Strings](references/strings.md) |
| Chunks, frames and sliding windows | [Stream windows](references/stream-windows.md) |
| Threads, async, cancellation and queues | [Concurrency](references/concurrency.md) |
| Unsafe operations and invariants | [Unsafe](references/unsafe.md) |
| Native ABI and consumer ownership | [C ABI](references/ffi-c.md), [C++](references/ffi-cpp.md), [C#](references/ffi-dotnet.md) |
| API shape, functions, methods and traits | [Idioms](references/idioms.md) |
| Data-oriented algorithms, storage and access patterns | [Data-oriented design](references/data-oriented-design.md), [Oxc/Deno patterns](references/ast-layout.md) |
| Interpreting layout, ownership or upstream evidence | [Layout evidence and limits](references/layout-evidence.md) |
| Dependency choice and build/target cost | [Dependencies](references/dependencies.md), [byte kernels](references/dependencies-bytes.md) |
| Byte, encoding, serialization and parallelism candidates | [Text and buffers](references/candidate-text-bytes.md), [Serde and Rayon](references/candidate-serde-rayon.md) |
| Correctness, regression, fuzzing and safety proof | [Testing](references/testing.md) |
| Repeatable outputs and release artifacts | [Determinism](references/determinism.md) |
| Windows binaries, paths and resource behavior | [Windows](references/windows-os.md) |
| Performance experiments and benchmark harnesses | [Benchmarks](references/benchmarks.md), [profiling](references/profiling.md) |
| Cargo packages, features and profiles | [Cargo](references/cargo.md) |
| Rust-owned generators and build inputs | [Build scripts](references/build-scripts.md) |
| Compiler versions and Mise | [Toolchains](references/toolchains.md) |
| Concurrent checkouts and reuse | [Worktrees](references/worktrees.md), [caching](references/caching.md) |
| Fast complete CI and partitioning | [CI](references/ci.md), [sharding](references/sharding.md) |
| GPU computation and portability | [GPU](references/gpu.md) |
| AI/ML acceleration and precision | [ML](references/ml.md) |
| GPUI and portable user interfaces | [UI](references/ui.md) |
| Comments, examples and rustdoc | [Documentation](references/documentation.md) |
| Context reset, handoff and progress report | [Continuity](references/continuity.md) |
| Reusing a dated research result | [Exact evidence and fixtures](references/evidence-index.md) |
| Applying the policy to a repository | [Adoption](references/adoption.md) |

## Implement from evidence and preserve the contract

Bind work to verified files, symbols, APIs and expected outputs. Use idiomatic
safe Rust first. Make copies, retention, error semantics and cleanup intentional.
Use standard Rust/Cargo conventions for Rust-owned work. Keep dependencies small
but justify quality from exact source, features and measurements.

For layout or allocation work, map fields, passes and lifetimes before choosing
containers. Compare equal semantics and separate layout, ownership and allocator
changes. Include construction, complete-record work and post-request retention;
a faster narrow scan alone cannot decide the product design.

Prove optimized output against an independent oracle before comparing speed.
Exercise tails, chunk splits, limits and failures. Measure the costs the product
pays, including memory, binary size and build time when relevant. Keep native,
browser, WASI, C ABI and GPU evidence distinct. Documented support is not a run.

Recheck the selected references when discovery changes a decision or ownership.
Record unsafe assumptions next to code. Preserve useful failed content and its
metadata. Test the connected consumer before claiming the customer problem fixed.

## Close only with the declared evidence

Run the relevant format/lint, test, build, runtime and artifact checks at the
exact revision and feature sets. Verify every declared Wasm operation and native
consumer. Missing required hosts or failing gates remain release blockers.
Validate the actual packaged artifact, not only the working tree.

Use [task](assets/task-record.md), [support](assets/support-matrix.md),
[dependency](assets/dependency-card.md) and [review](assets/review-record.md)
records when useful. Use the [layout record](assets/layout-record.md) for data design.
Follow the [CI adoption plan](assets/ci-plan.md) to wire gates. Retain
source/versions, raw attempts, explicit limits and the next unresolved question.
Report an anchor: observation, evidence scope, product meaning and next decision.
Before interruption or handoff, update [continuity](references/continuity.md).

## Follow this distribution's connected owners

Read [shared quality](../../guides/software-quality.md) once per task. Use the
[Rust handbook](../../handbook/rust/README.md),
[engineering](../../handbook/engineering/README.md) and
[task procedures](../../handbook/tasks/README.md) for repository delivery.
