# Replace source reach-through with a package contract

Use this prompt when a consumer imports another package’s private source or checkout layout.

Skills: `build-libraries`, `refactor-code`.

Read the [applicable procedure](../architecture/files.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Replace source reach-through with a package contract.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed build-libraries, refactor-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Trace the import, owning implementation, exports, build output and downstream
consumers. Determine which capability is public and which remains private.

Define or use the supported package export with its runtime, type and
dependency contract. Migrate all consumers and remove obsolete paths when
authorized. Test an installed package outside the source checkout, including
relevant hosts and errors. Inspect the produced artifact and publication
status separately. Deliver the coherent export, consumer migration and
evidence; a hidden source alias is not a substitute for the public contract.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
