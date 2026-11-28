# Rust product engineering anchored in observed behavior

Use this guide whenever Rust owns a product capability, worker, library,
binding, tool, or build step. Start with the customer outcome and the decision
that needs evidence. Read the current source, identify consequential unknowns,
and run a small direct probe before substantial implementation.

The [product method](../product/README.md) owns the research and experiment loop.
The [software-quality contract](../software-quality.md) remains in force.
The [Rust skill](../../skills/rust-software/SKILL.md) supplies Rust-specific
implementation references. This guide connects those rules to product decisions,
acceptance evidence, and adoption in an existing repository.

## Make the intended operation portable

Inventory the supported hosts of every maintained package and binary, including
workers and tools. When the project requires Wasm, prove the complete operation
on its declared host. A successful compile, empty stub or skipped target does
not establish support. Keep unmet requirements visible. A native-only project
can remain native-only; record that scope without describing it as Wasm support.

Separate reusable computation from real host adapters when that helps. Give
each adapter an actual consumer, explicit ownership, and a test of the complete
operation. Browser Wasm, WASI commands/components, and native C/C++/C# consumers
have different contracts. Record which contract each observation establishes.

## Learn before committing to a design

Find the smallest question that can change the next decision: whether a
dependency compiles, an import exists, a buffer survives reuse, a stream gives
the same answer after a split, or a SIMD path preserves output. Use an existing
executable, public function, or tiny fixture before constructing a harness.

Alternate research and useful experiments under the product method. Begin early. A useful cycle includes execution or direct observation;
reading and setup alone cannot prove the intended behavior. Preserve failures,
conditions, and metadata. A negative result can be a valuable team anchor.

Choose idiomatic safe Rust and standard Cargo conventions first. Make layout,
copies, retention, concurrency, and error behavior deliberate. Optimize only
after equivalent output is established, then measure the costs the product
pays: latency, memory, transfer, artifact size, build work, and operation count.

## Read the next decision's owner

| Need | Read |
| --- | --- |
| Understand mandatory behavior and unresolved conflicts | [Policy](policy.md) |
| Decide what the current observations prove | [Evidence](evidence.md) |
| Choose data representation from access, lifetime and measurements | [Data-oriented design](data-oriented-design.md) |
| Connect rules to an existing package graph and CI | [Adoption](adoption.md) |
| Choose exact Rust implementation techniques | [Rust skill](../../skills/rust-software/SKILL.md) |
| Apply the method through project procedures | [Rust handbook](../../handbook/rust/README.md) |
| Start a complete copyable task | [Task prompts](../../handbook/tasks/README.md) |

The current repository and explicit user requirements control concrete owners,
commands, supported hosts, and authorized effects. A dated research result is
evidence for its recorded conditions, not a permanent compatibility guarantee.
