# Select and shard tests with their native runner

Use this prompt when a test job is slow or selection depends on a maintained file list.

Skills: `test-code`, `benchmark-code`.

Read the [applicable procedure](../engineering/tests.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Select and shard tests with their native runner.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed test-code, benchmark-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Inspect the runner's actual discovery and shard unit. Preserve its runtime
and assertion contracts. Compare complete discovery with selected and sharded
work.

Check new, renamed and deleted tests, shared fixtures, runner configuration
and dependencies. Split broad files only when behavior and resource ownership
justify it. Keep integration journeys understandable. Verify independence,
cleanup and no order dependence. Measure duplicated setup, imbalance,
contention, wall time and total runner time before claiming a gain. Report
unavailable expensive environments.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
