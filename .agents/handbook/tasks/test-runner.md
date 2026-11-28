# Consolidate tests on a selected runner

Use this prompt when the project explicitly chooses one compatible runner and assertion contract.

Skills: `test-code`, `refactor-code`.

Read the [applicable procedure](../engineering/tests.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Consolidate tests on a selected runner.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed test-code, refactor-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Identify runners, assertions, fixtures, mocks, clocks, permissions, discovery
and supported environments. Confirm the selected target contract and preserve
the project's runtime. Add deno-software only when Deno actually owns or
runs the tests.

Compare async completion, errors, hooks, isolation, snapshots, timeout and
cleanup before migrating. Move configuration and CI consumers with tests.
Verify discovery and inventory, then run meaningful cases across required
environments. Deliver the completed cutover and remove obsolete setup.
Do not use this task to impose a runner on an unrelated project.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
