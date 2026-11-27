# Record a task’s inputs, outputs and environment

Use this prompt before caching a result or reconciling competing task definitions.

Skills: `build-devtools`.

Read the [applicable procedure](../engineering/selection-cache.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Record a task’s inputs, outputs and environment.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed build-devtools
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Identify each result-owning task and its command, working directory, source
and transitive inputs, discovered tests, manifests, locks, tools, platform,
relevant environment and output contract. Keep credential values out of
records.

Separate tool downloads, dependency stores, compiler intermediates, task
results and release artifacts. Assign one result-cache authority per task.
Check added, removed and generated files and downstream output consumers.
Deliver the task inventory, invalidation conditions and unsupported
assumptions. Do not introduce another cache owner while documenting the first.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
