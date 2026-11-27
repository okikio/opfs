# Review the final candidate against the agreed outcome

Use this prompt before handing off a substantial CI or tooling change.

Skills: `verify-behavior`, `review-code`.

Read the [applicable procedure](../engineering/handoff.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Review the final candidate against the agreed outcome.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed verify-behavior, review-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Verify final source and integration with concurrent work. Compare the outcome,
accepted plan, implementation, generated output and actual checks. Inspect
public consumers, configuration, documentation and obsolete paths.

Run or inspect relevant types, tests, frozen preparation, builds, artifact
contents and required runtime operations. Reconcile selection/cache evidence
with complete required work. Record passed, failed, blocked and unrun checks
at the exact candidate. Deliver a reviewable result, concrete limits and
recoverable continuation for unfinished work. A push or green partial
workflow does not establish broader behavior.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
