# Report an observation the team can act on

Use this prompt when a progress update must connect evidence to the next decision.

Skills: `verify-behavior`, `write-docs`.

Read the [applicable procedure](../product/README.md) and [prompt instructions](README.md). Copy the complete prompt and replace the bracketed fields with the task's actual scope.

```text
Task: Report an observation the team can act on.
Source or repository: [identify the actual source].
Mode and outcome: [review, plan, implement or verify; useful result].
Scope and allowed effects: [use the existing task authorization].

Read current repository instructions and the installed verify-behavior, write-docs
skills. Use their shared software-quality and product guides. Preserve the
project's runtime, supported environments and native task interface. Verify
the starting branch, revision and local changes.

State the user or maintainer outcome, consequential question and existing
evidence. Trace the real owner and consumer. Use a small direct probe early
when its result can change the next decision.

Inspect the actual observation and its input, source, environment and time.
Identify the customer or maintainer question it addresses. Keep evidence
separate from interpretation.

State what happened, what it establishes, what remains uncertain and what
the team should do next. Distinguish reported, source-inspected, directly
observed, integrated and customer-outcome claims. Preserve failed or
inconclusive results and explain superseded conclusions. Do not present
implementation activity as user benefit or invent confidence percentages.
Deliver a concise anchor, traceable evidence and the next owner or action.

Keep observations, hypotheses and blocked checks distinct. Preserve relevant
failed attempts and cleanup state. Report the evidence-backed result, its
scope, remaining checks and next concrete action. Do only the work authorized
by the selected mode and current task.
```
