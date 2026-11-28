# Choose data layout for the operations that matter

Use this page for parsers, ASTs, indexes, and repeated scans.
Apply [the data-oriented procedure](data-oriented-design.md) before borrowing a pattern.
Start with the customer operation, input limits, mutation pattern, and lifetime.
Measure traversal time, allocations, retained bytes, and full request latency.
A compact structure helps only when its access pattern and ownership fit the work.

## Learn from Oxc's specific choices

At commit `58b07b7fe4d2213dacb737a059a93d0be6a0d3da`, Oxc uses:

- A bump allocator for groups of objects with one shared lifetime.
- Compact byte spans with `u32` start/end offsets.
- Typed symbol/scope IDs that index side tables.
- Structure-of-arrays tables for scope and symbol fields.
- A separate sparse table for less common redeclarations.
- Capacity estimates derived from measured JavaScript corpora.

These choices avoid storing every property on every AST node.
Separate frequently read fields from diagnostic or rarely used data.
Prefer ordinary `Vec<T>` columns and checked IDs before custom unsafe allocation.
Compare array-of-structures and structure-of-arrays for the actual traversal:
reading every field of one object can favor a different layout from scanning one
field of every object. Include construction and mutation costs in the comparison.

Oxc's `MultiIndexVec` stores several arrays in one allocation. Its implementation
owns alignment, capacity arithmetic, initialized elements, moves, and destruction.
Copying this machinery adds obligations beyond choosing a useful data layout.
Its `Span::new` documents an invariant without checking it; validate offsets at
untrusted input boundaries, including UTF-8 boundaries when slicing `str`.
The compact representation needs an explicit maximum input size and overflow test.

Oxc's allocator rejects types with destructors. Arena reset is not a substitute
for closing resources or releasing owned heap allocations in arbitrary types.
Reset invalidates arena allocations and retains the largest chunk for reuse.
Test a large parse followed by tiny parses: capacity can remain allocated.
Measure process residency separately; allocator capacity is not RSS.
Do not reset while references, callbacks, or foreign consumers can still reach data.
The allocator's `fixed_size` feature targets 64-bit little-endian systems;
`track_allocations` is documented as internal and unsafe for production use.
These are not general Wasm features or recommended defaults.

## Learn from Deno's ownership choices

At Deno commit `d8c551b5a5b46d8ec3892a91d0364cfcbca2c681`, `FastString`
distinguishes static strings, static ASCII strings, owned strings, and shared
strings. Its cheap-copy operation cannot cheaply copy every owned representation.
Some operations allocate; V8 conversion has its own lifetime and encoding rules.
Use a similar representation only when observed storage modes justify its branches.

In the separately pinned deno_ast source, `ParsedSource` shares an inner object,
source text, and program with `Arc`; it builds source-text information lazily.
It attempts to consume a uniquely owned AST before cloning for a transformation.
The transferable pattern is explicit sharing plus lazy derived data.
An `Arc` reduces some copies but adds atomic operations and can retain a large graph.

Deno's resource table uses `Rc<dyn Resource>` in a `BTreeMap` for a thread-local
JavaScript runtime. That is a purposeful ownership/dispatch contract, not evidence
that dynamic dispatch is always free or that every resource should be `Send + Sync`.
Taking a resource out of the table does not itself close or cancel pending work.
Buffer views retain backing storage and advance a cursor for partial operations.
Review the read-into-buffer path: a default adapter may still allocate and copy.

## Verify before adopting

Use representative small, large, malformed, and repeated inputs.
Check equal semantic output, identity stability, source offsets, and drop counts.
Test memory after the request and after a high-water workload, not only allocations.
Keep a simpler layout as the reference until the alternative proves useful.
Do not claim that an upstream architecture makes this product fast or portable.
Use [layout evidence and limits](layout-evidence.md) to interpret a comparison.

Primary sources, reviewed 2026-11-26:
[Oxc allocator](https://github.com/oxc-project/oxc/blob/58b07b7fe4d2213dacb737a059a93d0be6a0d3da/crates/oxc_allocator/src/allocator.rs),
[scope tables](https://github.com/oxc-project/oxc/blob/58b07b7fe4d2213dacb737a059a93d0be6a0d3da/crates/oxc_semantic/src/scoping.rs),
[multi-index vector](https://github.com/oxc-project/oxc/blob/58b07b7fe4d2213dacb737a059a93d0be6a0d3da/crates/oxc_semantic/src/multi_index_vec.rs),
[spans](https://github.com/oxc-project/oxc/blob/58b07b7fe4d2213dacb737a059a93d0be6a0d3da/crates/oxc_span/src/span.rs),
[Deno FastString](https://github.com/denoland/deno/blob/d8c551b5a5b46d8ec3892a91d0364cfcbca2c681/libs/core/fast_string.rs),
[resource table](https://github.com/denoland/deno/blob/d8c551b5a5b46d8ec3892a91d0364cfcbca2c681/libs/core/io/resource_table.rs),
[buffer views](https://github.com/denoland/deno/blob/d8c551b5a5b46d8ec3892a91d0364cfcbca2c681/libs/core/io/buffers.rs),
[parsed source](https://github.com/denoland/deno_ast/blob/ec4c0161df91e777c0e8bc8640a5c5425c25195f/src/parsed_source.rs).
