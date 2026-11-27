---
name: prepare-pull-requests
description: Prepare source-grounded pull request titles, descriptions and reviewer handoffs. Use for a concrete review narrative and validation limits; writing a draft does not authorize opening, merging or publishing a PR.
---

# Prepare pull requests

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



Read [pull request prose](references/pulls.md). For a diagram read [diagram fidelity](../../references/diagrams.md); for substantial explanation use the relevant [plain-English sections](../../guides/writing-technical-docs-in-plain-english-handbook.md). Inspect the actual final diff, controlling source, callers and checks before describing it.

Lead with the concrete problem, resulting behavior and mechanism. Preserve the complete causal explanation for a reader without chat history. Scale detail: a local fix may take two sentences; a multi-component change needs customer outcome, user steps and system handoffs, with failures and recovery. Link review priorities and deep detail after the useful opening.

Distinguish implemented behavior, future design and live verification. State exact tests and material gaps; never copy a plan as deployed proof or invent a percentage, integration or successful migration. Diagrams must preserve relevant branches and authority, and each arrow needs evidence. A draft request is read-only; use available authorized publication tooling only when explicitly asked to open/update a PR. Shared comments/docs/naming/imports/readability/correctness duties also apply to the code being explained.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Agent execution](../../handbook/agents/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
