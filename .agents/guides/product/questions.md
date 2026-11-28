# Find the unknowns that control the product decision

Begin with a concrete customer situation. A user cannot export every variant,
waits too long for a result, or cannot tell whether a saved change succeeded.
Separate the reported effect from an explanation such as "the queue drops rows."
The explanation is a hypothesis until a discriminating observation supports it.

## Classify what is missing

| Kind of unknown | Example | Useful evidence |
| --- | --- | --- |
| Value | Do customers need a scheduled export enough to use it? | Relevant customer behavior, current workaround, or a bounded demand experiment |
| Usability | Can a customer select the intended variants? | A representative person performing the task; observe errors and recovery |
| Feasibility | Can the exporter preserve all variants? | Direct execution against a small input with an independent expected result |
| Viability | Can this service meet the operating cost or policy constraint? | Current constraints plus measured costs and the appropriate decision owner |
| Cause or integration | Where do rows first disappear? | Compare inputs and outputs across the few relevant transitions |

These categories help choose evidence. They do not require five separate
documents. A technical experiment cannot establish customer demand or prove that
people understand an interface. A synthetic user can help inspect a flow but
does not replace the people whose behavior the claim concerns.

For each consequential question, record the decision it changes, existing
evidence, plausible alternatives, cheapest useful probe, and current state:
untested, observed, supported within scope, contradicted within scope,
inconclusive, blocked, or superseded. Preserve surprising results. Avoid labeling
unknowns as inherently positive or negative.

## Prioritize information, consequence, and cost

Ask which answer could invalidate a large implementation, remove a dependency,
change the product promise, or unblock other work. Prefer a cheap test that
distinguishes those possibilities. Do not invent numerical probabilities or a
complex scoring model when a short comparison is enough.

Classify questions early:

- **Answer now:** an available command, fixture, source trace, or authorized
  observation can address it with little setup. Run that probe early.
- **Answer after one named prerequisite:** identify the credential, fixture,
  customer access, tool, or environment actually needed. Try a smaller valid
  substitute while obtaining it.
- **Answer later or accept provisionally:** the answer needs representative
  traffic, time, access, or cost that is not justified yet. State the assumption,
  exposure, owner, and trigger for revisiting it.

Do not confuse "hard to prove in general" with "hard to learn anything useful
about." One direct run can establish feasibility for one configuration even
when it cannot estimate production reliability. Conversely, a favorable first
run is not grounds to stop asking about failure frequency when the decision
depends on reliability.

## Keep the search open without drifting

List the obvious alternatives and a baseline, including existing capability or
configuration and doing nothing when that is a real option. Search current
exports, callers, source, and official documentation before creating an owner.
If evidence changes the problem, revise the question before expanding the plan.
Inspect adjacent inputs, outputs, lifecycle, persistence, and consumers where
they could explain the symptom. Do not tour the entire system without a reason.

Ask a focused clarification only when a missing answer would change the real
target or a consequential tradeoff. Explain the decision that depends on it and
offer a concrete choice when possible. Continue authorized independent probes.
If the user already supplied the important questions, work on them immediately
and add discovered questions as evidence warrants.

## Preserve newly discovered issues

Record a new architectural or product issue with its observed trigger, source
path, consequence, evidence, relationship to the current question, and proposed
next step. Use the [issue template](templates/issue.md) if useful. Fix it within
the current task when it is required for the authorized outcome. Otherwise keep
it visible without turning every discovery into a redesign. A nonblocking issue
must not erase the useful anchor already obtained.
