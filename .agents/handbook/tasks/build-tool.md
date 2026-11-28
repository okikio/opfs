# Evaluate a compiler or build-tool change

Use this prompt before replacing or upgrading a compiler, bundler or major toolchain.

Skills: `build-libraries`, `release-software`, `explore-ecosystems`.

Read the [applicable procedure](../procedures/upgrades.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Evaluate a compiler or build-tool change.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed build-libraries, release-software, explore-ecosystems
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Identify current/proposed tools, target hosts, public exports, features,
generated files and release consumers. Verify actual supported APIs and
configuration before designing the change.

Compare semantic output, diagnostics, source maps, modules, tree shaking,
declarations, native dependencies and installed consumers where relevant.
Measure cost after required behavior agrees. Preserve publication and
recovery contracts. Deliver the justified option, migration inventory,
artifact evidence and unresolved tradeoffs. Keep proposals separate from
implemented changes.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
