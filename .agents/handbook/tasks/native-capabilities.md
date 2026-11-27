# Audit custom tooling against native capabilities

Use this prompt when a repository maintains selection, caching, discovery or build logic.

Skills: `explore-ecosystems`, `build-devtools`.

Read the [applicable procedure](../engineering/native-tools.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Audit custom tooling against native capabilities.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed explore-ecosystems, build-devtools
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Inspect installed versions, command help, task definitions and the current
implementation. Compare native discovery, selection, caching, build and
packaging only where they affect the requested outcome.

Run a representative comparison with the same input and expected behavior.
Check failure exits, ignored files, generated definitions, permissions and
consumers. Identify the exact gap that justifies custom logic, or the complete
migration needed to retire it. Do not replace working code or introduce a
toolchain merely because an alternative exists.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
