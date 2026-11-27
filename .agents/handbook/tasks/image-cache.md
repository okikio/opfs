# Verify container build cache reuse

Use this prompt when image construction is a measured source of engineering cost.

Skills: `build-devtools`, `release-software`.

Read the [applicable procedure](../engineering/selection-cache.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Verify container build cache reuse.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed build-devtools, release-software
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Inspect the actual build context, definition, platform matrix, dependencies,
secret inputs and release artifact contract. Identify stable dependency
layers and changing inputs without altering required output.

Use the existing supported builder and cache mechanisms. Prove relevant
invalidation, fresh-runner restoration, writer trust and platform-specific
artifact identity. Distinguish image layers from writable build caches.
Measure transfer, setup and total cost under comparable conditions, then
exercise the final image's required entrypoint and behavior. Preserve required
release checks.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
