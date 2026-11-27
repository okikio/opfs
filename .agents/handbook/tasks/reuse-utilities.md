# Adopt an existing utility through its public contract

Use this prompt when a project duplicates a maintained mechanism or chooses a utility dependency.

Skills: `refactor-code`, `explore-ecosystems`.

Read the [applicable procedure](../architecture/reuse.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Adopt an existing utility through its public contract.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed refactor-code, explore-ecosystems
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Trace the local mechanism, callers, errors, ownership and supported hosts.
Inspect maintained dependencies and native capabilities first. Use use-utils
when the project selects its public utility workspace, and use-okikio for
its distinct supported libraries.

Verify the package, subpath, exports, resolved revision and publication
status. A matching name or namespace does not establish correspondence.
Compare the replacement through a real consumer and relevant failure cases.
Migrate callers, tests, docs and configuration before removing duplication.
Deliver the supported adoption or exact missing capability without inventing
a published release.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
