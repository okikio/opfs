# Preserve reproducible Rust evidence

Use this reference when a dependency claim, performance result or portability
observation affects a decision. Record current primary sources and actual
observations separately. This collection does not ship private experiment logs
or treat another project's results as acceptance evidence.

For each relevant probe retain:

- repository revision, minimal source, lockfile and exact compiler;
- target triple, features, build profile, host/runtime and permissions;
- representative inputs, independent expected output and command;
- every attempt, exit status, output and failure metadata;
- artifact identity, elapsed/resource measurements and measurement scope;
- interpretation, residual unknowns and the next decision.

For data design, also retain fixture provenance, the fields/passes/lifetimes
map, equivalent complete outputs, and the exact request sequence used to measure
reuse and retention. Record source-review and executed-package identities
separately. Use [layout evidence and limits](layout-evidence.md) before reusing a
comparison; a source-derived model does not establish production behavior.

Start with an existing operation or a tiny fixture. A successful compile does
not prove runtime behavior. Generated instructions do not prove a speedup.
An isolated kernel does not prove an application flow. Verify the required
consumer before extending the claim.

Keep raw evidence in the project's approved task record. Remove credentials,
personal data and unrelated source before sharing it. Link publicly accessible
sources when publishing a finding. If the original evidence cannot be supplied,
repeat a bounded probe or label the claim unverified.

Use [the task record](../assets/task-record.md) and
[host support matrix](../assets/support-matrix.md) when their fields help.
The [product method](../../../guides/product/README.md) governs questions,
experiments and revisable observations.
