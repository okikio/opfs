# Report CI impact by change class

Use this prompt after an engineering change alters selection, caching or execution cost.

Skills: `benchmark-code`, `verify-behavior`.

Read the [applicable procedure](../engineering/measurements.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Report CI impact by change class.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed benchmark-code, verify-behavior
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Compare baseline and final candidate using the same relevant change classes
and complete-work oracle. Explain why each task ran, reused output or was
skipped. Include newly discovered, moved and deleted tests and shared input
changes where they affect the graph.

Report output and test-inventory parity, workflow wall time, total runner
time, setup, cache traffic and failed attempts. Separate measurements from
estimates and preserve confounders. Use currency only with verified rates.
Deliver the supported decision, required gates retained, unrun cases and
next unresolved question.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
