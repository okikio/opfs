# Use controlled clocks for deterministic timing logic

Use this prompt when tests wait on real time without needing to prove real timing.

Skills: `test-code`.

Read the [applicable procedure](../engineering/tests.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Use controlled clocks for deterministic timing logic.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed test-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Classify each wait: logical deadline/retry behavior, actual scheduling,
external timing or resource cleanup. Inspect the runner's clock facilities
and the operation's cancellation model.

Replace only waits whose contract can use a controlled clock. Exercise
ordering, deadlines, repeated retries, cancellation, terminal state and cleanup
without relying on another test's clock state. Retain real timing checks
where elapsed behavior is the requirement. Deliver changed tests, the
preserved timing contract and executed results; less waiting does not by
itself establish broader coverage.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
