# Order caches and constrain their writers

Use this prompt after a cache is correct and before expanding it across jobs.

Skills: `build-devtools`, `review-code`.

Read the [applicable procedure](../engineering/selection-cache.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Order caches and constrain their writers.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed build-devtools, review-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Map dependency downloads, compiler data, deterministic task outputs,
container layers and final artifacts. Record restore/save order, complete
input identity, writer trust, read-only consumers and failure behavior.

Compare valid preparation orders on fresh and warm runners. Preserve source
and lock integrity before admitting reused output. Measure transfer and setup,
and check missing or corrupt layers recover correctly. Do not stack result
caches on one task without a clear authority. Deliver ownership, observed
costs, protected release checks and remaining limits.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
