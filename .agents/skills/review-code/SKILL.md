---
name: review-code
description: Review code or a diff for correctness, comments and documentation, naming, imports, file structure, formatting, readability, tests and relevant performance claims. Use for code review or a maintainability audit; a review does not authorize fixes.
---

# Review code as a complete maintained artifact

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



A review includes comments, TSDoc, affected documentation/examples, function and
file naming, imports/exports, formatting, structure, readability and correctness.
They are part of reviewing code even when the user does not name them. Tests and
performance evidence are reviewed for the claims the change makes.

## Required reading

Read required resources in bounded outputs, one file or section at a time;
do not concatenate the entire reference/guide tree. If a tool truncates a
required read, recover the omitted portion before relying on it. For the
decision-triggered resources below, find the relevant headings and read
those sections. A listed filename or truncated output is not a completed
read; report any consequential unavailable guidance.

Read these before evaluating a non-trivial review:

- [Quality obligations](../../guides/software-quality.md): the complete task scope, source precedence and companion selection.
- [Review procedure](../../references/review.md): trace owners/callers, prioritize findings and tie each to a demonstrated consequence.
- [Comments and TSDoc](../../references/comments.md): exports and important internal invariants, fields, lifecycle and fixture explanations; avoid coverage-only comments.
- [Documentation](../../references/docs.md): verify examples and explanations, distinguish fact from proposal, and preserve technical detail in plain English.
- [Readability and ownership](../../guides/readability-and-ownership.md): inspect the actual artifact from its maintainer's position, including connected user/system flows where relevant.

Read the applicable sections below before judging those decisions. These are
required by the decision, not optional because another skill could cover them:

| Decision being reviewed | Required detail |
| --- | --- |
| Function/field/type/file naming, folder ownership, namespace imports | [Naming and folder structure](../../guides/naming-and-folder-structure-guide.md): current naming contract, functions, fields, namespace imports and file naming |
| Formatting, import layout, control flow or explanatory comments | [Formatting](../../guides/code-formatting-guide.md): applying examples, scope, imports, control flow, comments and practical decision table |
| Types, schemas, exports, host globals or compatibility | [Standards](../../references/standards.md), [TypeScript](../../references/typescript.md), and [general design](../../references/general.md); [base](../../references/base.md) supplies inherited rationale when needed |
| Tests or assertions supporting the change | [Testing](../../references/testing.md): independent oracles, lifecycle, real runtime proof and role-appropriate imports; follow aliases/helpers before reporting missing assertions |
| Performance claims or affected measured workloads | [Benchmarking](../../references/benchmarks.md): semantic equivalence, representative work, setup costs, output consumption and uncertainty; use benchmark-code for substantial measurement work |
| Substantial wording or document restructuring | [Plain technical English](../../guides/writing-technical-docs-in-plain-english-handbook.md): choose the sections for the reader's question; formal STE applies only when requested |

## Review workflow

Read the applicable [product planning](../../guides/product/planning.md) and
[anchor](../../guides/product/anchors.md) sections when reviewing a plan,
investigation, or progress claim. Check whether the change answers a real
customer question, cheap decisive probes were used, scaffolding is justified,
and the claimed outcome matches the observed scope. A plausible implementation
or a green component check does not establish an unrun customer path.

1. Establish the requested mode, base/head/diff and scope. Preserve dirty work;
   inspect before writing. A review or audit authorizes findings, not edits,
   migrations, commits, installs or publication.
2. Trace definitions, public exports, callers, schemas, tests, benchmarks and
   affected documentation. Determine the actual runtime and domain owners; load
   companions for their decisions instead of guessing from a filename.
3. Follow common and failure paths. Check units, ownership, ordering, validation,
   cancellation, replay and cleanup where relevant. Inspect assertions, not only
   a green summary; compare descriptions/examples with real behavior.
4. Apply every quality obligation to this surface. Report substantive defects
   with path/symbol, trigger, consequence and a concrete correction or proof.
   Rank risks before style. Do not invent a bug to fill a category or penalize
   justified direct imports, framework conventions or self-explanatory glue.
5. Use the user's/host's review output format. Separate observed defects from
   proposals and unverified concerns. Report exact checks and material limits.
   Before finishing, reread the findings as a maintainer without chat history.

For example, a helper named in minutes that returns seconds requires tracing
its consumers and examples. A positive-number assertion does not establish the
unit contract. Review the misleading comment and README as well as the code.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Failure catalogue](../../handbook/failures/README.md), [Retrospective coverage](../../handbook/failures/retrospectives/README.md), [Task prompts](../../handbook/tasks/README.md).

For any project using the pack, see [Product development](../../handbook/product/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
