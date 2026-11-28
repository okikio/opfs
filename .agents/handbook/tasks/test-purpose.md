# Classify tests by the contract they protect

Use this prompt when a suite mixes durable tests with temporary investigation or source-text checks.

Skills: `test-code`, `refactor-code`.

Read the [applicable procedure](../engineering/tests.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Classify tests by the contract they protect.
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

Identify the purpose and consumer of each affected check before removing or
moving it. Preserve behavior, security, schema, lifecycle, compatibility and
release protection. Syntax/AST checks are valid when syntax or ownership
is the actual contract.

Move only disposable probes and redundant implementation-detail assertions
to the project's temporary location. Trace discovery, fixtures, runner
configuration and cache inputs so the maintained inventory does not shrink
accidentally. Run affected tests and inspect their observable assertions.
Deliver the classification, removal rationale and preservation evidence.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
