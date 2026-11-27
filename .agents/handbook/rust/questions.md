# Answer the smallest Rust question first

Identify the decision that depends on uncertain behavior: a host API, allocation pattern, chunk split, FFI transfer, dependency feature or acceleration path. Inspect enough current source and documentation to design a direct probe.

Use a small operation with an independent expected result before building a harness or wider service. Preserve compiler, target, features, host, input and failed attempts. A setup failure does not answer the intended behavior question.

Check semantic equivalence before measuring performance. Exercise relevant tail lengths, malformed input, alignment, chunk partitioning, cancellation and resource limits. Compare accelerated paths with a trustworthy scalar or reference result.

Keep compile, instantiate, execute and integrated-consumer evidence distinct. A native test cannot establish browser policy, a cross-build cannot establish a foreign consumer, and a GPU build cannot establish that an adapter executed the kernel.

Turn the result into a scoped [anchor](../../guides/product/anchors.md). State what it permits, what remains uncertain and which real consumer should be checked next. Scale experimentation to the question rather than a fixed time ratio.
