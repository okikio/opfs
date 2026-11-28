# Prove affected-work selection against complete discovery

Use this prompt when changed paths determine jobs, packages or tests to run.

Skills: `test-code`, `build-devtools`.

Read the [applicable procedure](../engineering/selection-cache.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Prove affected-work selection against complete discovery.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed test-code, build-devtools
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Discover complete required work with the owning native tools. Trace selection
from changed inputs through transitive consumers and configuration. Keep
selection independent of result-cache admission.

Compare selected work with the complete-work oracle for relevant edits,
new files, rename/deletion, nested packages, type-only dependencies, shared
fixtures, locks, generated output and task configuration. Check test names
and inventory as well as exit status. Unknown edges require conservative
execution. Deliver actual selected work, discrepancies and the final rule's
supporting evidence.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
