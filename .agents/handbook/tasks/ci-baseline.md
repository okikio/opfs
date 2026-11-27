# Record the CI baseline before changing it

Use this prompt before claiming that an engineering change reduces time or cost.

Skills: `benchmark-code`, `verify-behavior`.

Read the [applicable procedure](../engineering/measurements.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Record the CI baseline before changing it.
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

Record the actual source, tools, runner, commands, discovered tasks and tests,
artifacts and required release checks. Select representative change classes
from this repository, including shared dependencies and configuration when
they affect the work graph.

Measure comparable cold and warm conditions. Keep workflow wall time, total
runner time, setup, cache transfer, duplicated work and failed attempts
visible. Preserve raw observations and correctness evidence. Report currency
only with verified applicable rates. Deliver a reproducible baseline and
comparison criteria before interpreting the proposed improvement.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
