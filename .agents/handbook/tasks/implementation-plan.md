# Make the next implementation step concrete

Use this prompt when findings must become an executable change plan.

Skills: `plan-changes`, `explore-ecosystems`, `review-code`.

Read the [applicable procedure](../playbook.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Make the next implementation step concrete.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed plan-changes, explore-ecosystems, review-code
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Verify current source, instructions, outcome, questions and observations.
Trace the real entrypoint, reusable owner, exports, consumers, schemas,
state, lifecycle and relevant host before proposing work.

Bind each item to verified files or explicit additions, symbols, inputs,
outputs, commands, failure/cleanup behavior, dependencies and acceptance.
Include affected docs, configuration, persisted data and obsolete-path
removal when needed. Tie unresolved choices to the probe or human decision
that resolves them. Deliver one complete plan with evidence checkpoints and
the exact next action. Planning alone does not authorize implementation.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
