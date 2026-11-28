# Regenerate a lock and verify reproducible preparation

Use this prompt when dependency resolution changes or installations differ between environments.

Skills: `explore-ecosystems`, `build-devtools`.

Read the [applicable procedure](../procedures/upgrades.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Regenerate a lock and verify reproducible preparation.
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

Identify the actual runtime, package manager, lock owner, registries and
supported preparation modes. Add deno-software only when Deno owns the
contract. Trace the reason for the lock change and verify intended versions,
exports, integrity and publication status.

Use native lock generation in the supported environment. Inspect its diff,
then exercise the frozen or equivalent reproducible preparation from a clean
consumer state. Separate missing access, unavailable artifacts, generation
restrictions and dependency defects. Do not fabricate lock entries or
generated files. Report exact preparation and consumer checks and their limits.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
