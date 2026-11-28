# Pilot one result cache on a bounded task

Use this prompt after a task’s deterministic inputs and outputs are understood.

Skills: `build-devtools`, `benchmark-code`.

Read the [applicable procedure](../engineering/selection-cache.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Pilot one result cache on a bounded task.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed build-devtools, benchmark-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Choose one task with a verifiable result and one supported cache owner.
Inspect current behavior and add a runtime companion only when its contracts
apply. Keep live probes and timing measurements outside the reused result.

Prove miss execution, fresh-runner hit restoration, input invalidation,
failed/cancelled task behavior, absent or corrupt cache recovery and output
correctness. Check protected consumers cannot trust untrusted cache writes.
Measure transfers and setup as well as saved work. Deliver the bounded pilot,
exact evidence and the decision about expanding or stopping it.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
