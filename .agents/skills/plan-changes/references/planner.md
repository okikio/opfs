# Plan the complete requested change

Use the shared [product planning guide](../../../guides/product/planning.md)
to connect customer questions, early direct experiments, and evidence checkpoints
to the implementation. Bind work items to verified files, symbols, contracts,
tooling, expected results, failure/cleanup behavior, consumer migration, and
acceptance evidence. List consequential unknowns before substantial solution
work; narrow discovery probes can establish that list. A plan must expose
conditional decisions instead of hiding them behind detailed speculation.

Use this reference when scope, alternatives, dependencies or proof need a concrete
plan. The user’s requested mode controls whether the task stops at planning or
continues into implementation. This reference does not forbid authorized edits.

Identify reader, intended outcome, constraints, current owners and likely failures.
Inspect local instructions, existing implementations, exports, consumers and tests;
then consult primary documentation for unresolved version-sensitive behavior.
Consider reuse before new abstractions. Ask only for information that changes the
scope or verification and cannot be recovered from available evidence.

Define acceptance criteria for what will exist, obsolete paths that must disappear,
and what another maintainer must be able to use without chat history. Cover the
whole requested surface. Track implementation, removal, internal checks, actual
execution and final plan reconciliation separately. A partial first slice is not
completion of a broader authorized task.

Name dependencies and independently owned slices. Where parallel agents are
available and appropriate, identify which slices can run in parallel and which
specialized agents should own them; keep one integrated plan and verdict. Do not
run overlapping mutations without clear ownership.

For each claim, choose focused validation and real capability verification. State
unrun checks, unavailable resources and unresolved decisions explicitly. Preserve
reusable research only when it resolves a durable non-obvious question; avoid
creating a parallel documentation/configuration authority. Fit the plan to the
user’s needs rather than a fixed role-specific output template.
