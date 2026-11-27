# Organize data around the work the product performs

Use this before changing records, ASTs, indexes, batches, pools or hot loops.
Data-oriented design starts with data volume, access and lifetime. It includes
the algorithm, representation and order of transformations, not only containers.
Use the [layout record](../assets/layout-record.md) inside the existing task plan.

## Describe the work before choosing a layout

Trace one complete operation from input through output and release. Record:

- Real input families, sizes, skew, limits and the number of simultaneously live requests.
- Each pass, fields read/written, traversal order and number of repetitions.
- Whole-record lookups, sparse exceptions, insert/remove/update rates and ID stability.
- Source ownership, retained results, foreign consumers and thread handoffs.
- Current time, allocations, capacity, peak live bytes and the customer cost to improve.

Distinguish captured product data, projections from source fixtures and generated
stress data. A source-derived record model is not evidence that production uses it.
Start with an independent semantic oracle and the current safe representation.
Consider eliminating a pass, duplicated work or unused data before rearranging bytes.

## Choose a small comparison that can reject the proposed design

| Candidate | Question to test | Costs and invariants to retain |
| --- | --- | --- |
| Array of structs, such as `Vec<Record>` | Are most fields used together? | Padding, growth, moving records and whole-record access |
| Structure of arrays, one `Vec` per field | Do repeated passes use only a few fields? | Equal lengths, construction, mutation and gathering complete records |
| Blocks of columns | Does bounded batch processing help the selected kernel? | Block size, tails, conversion and target-specific vectorization |
| Compact IDs and side tables | Can stable indices replace independent pointers? | Range/generation checks, removals, remapping and graph lifetime |
| Sparse cold metadata | Are expensive fields absent or rarely read? | Lookup cost, determinism and worst-case dense inputs |
| Shared source plus byte spans | Can unchanged text remain borrowed? | UTF-8 bounds, source lifetime and small results retaining large sources |
| Phase arena | Do values really end their lives together? | Destructor rules, reset safety, retained chunks and concurrency |

Change one mechanism at a time. A boxed record with an owned string versus a
flat record with a span changes allocation, indirection and string ownership.
Separate those comparisons, or use a declared factorial design to expose interactions.
Keep the same validation, errors, output order and resource-release semantics.

## Prove semantic and lifecycle equivalence first

Compare complete outputs, not only a checksum or count. Use hand-auditable cases
and an independent simple implementation for larger generated cases. Cover empty,
singleton, tails, duplicate/invalid IDs, deletion, Unicode and configured limits
when those operations exist. Check mutation results and post-release ownership.
Compare diagnostics and partial-result semantics, not only successful outputs.

Use checked conversions before narrowing lengths or offsets to `u32`. Enforce
input and record caps before allocation. Keep column lengths and ID validity true
after partial failure. IDs into reused storage need a lifetime or generation rule.
Keep source offsets distinct from normalized or decoded text positions.

Prefer safe `Vec` columns before a custom single-allocation container. A custom
container must prove alignment, arithmetic, initialization, growth, panic safety,
drop behavior and Send/Sync assumptions. Upstream unsafe code is not a local proof.
Measure actual `size_of`, alignment and capacity on each required target.
Account for native and Wasm pointer-width differences when both are supported. `repr(C)` defines a representation, not an optimal layout.

## Measure the operation at the lifetime the customer pays for

Benchmark narrow scans and the complete build/query/mutate/release cycle.
Keep construction outside a scan-only benchmark only when explicitly labeled.
For reuse, measure a realistic pass count and the break-even point: extra setup
must be repaid by saved work before the data is discarded. Include conversion
at FFI/Wasm or pipeline handoffs when the alternative requires it.

Use multiple sizes and access patterns, balanced repeated order, raw samples and
a fresh confirmatory comparison. A fast hot-field scan does not settle random
whole-record access. Consume inputs/outputs and inspect suspicious generated code.
Keep timing baselines separate for each required target and host. Follow [benchmarks](benchmarks.md).

Measure arena/buffer state after small, large, then small requests and at teardown.
Capacity, used bytes, requested allocations, process RSS and Wasm linear memory
are different observations. Add a retention policy only after testing its cost.
Releasing allocations does not promise lower RSS or a smaller Wasm linear memory.
Test bounded concurrency because per-request retention multiplies across workers.

Treat SIMD, cache locality and branch behavior as mechanisms to investigate.
Elapsed time alone does not prove a cache-miss or vectorization explanation.
Parallelize ownership and independent work before adding shared locks or atomics.
Do not infer a production win from a shared-host microbenchmark or an upstream brand.

## Record the decision and its next falsifier

State observed benefit/regression by workload, correctness scope, memory costs,
maintenance burden, host limits and the next product-level test. Keep the simple
layout if the alternative does not improve the required operation. Record an
inconclusive comparison as an anchor with a concrete next experiment.

Read [Oxc and Deno patterns](ast-layout.md) for pinned examples, then
[memory](memory.md) and [strings](strings.md) for the ownership decision.
Primary layout contract: [Rust type layout](https://doc.rust-lang.org/reference/type-layout.html).
