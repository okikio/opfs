# Map the source owners of a change

Use this prompt before changing CI, tests, packages or a contract with several consumers.

Skills: `plan-changes`, `explore-ecosystems`.

Read the [applicable procedure](../engineering/source.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Map the source owners of a change.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed plan-changes, explore-ecosystems
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Map the changed and affected source, public exports, callers, tests,
generated output, configuration and release consumers. Distinguish existing
files from proposed additions. Inspect the current branch, full revision,
local changes and concurrent writers before assigning ownership.

Identify the complete-work inventory and uncertain dependency edges. Use
structural source inspection when it resolves ownership or references.
Record each missing prerequisite with its owner and the smallest resolving
check. Deliver the owner map, consequential questions, affected capabilities
and next bounded action.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
