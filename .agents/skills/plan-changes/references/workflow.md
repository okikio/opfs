
# Delivery Workflow

Use these rules for delivery agents, reusable research notes, and repo-local automation scripts.

## Search and research order

Use [anchor-based product development](../../../guides/product/README.md).
Start with the customer question and run the first useful direct probe as soon
as current research identifies it. Alternate research with experiments using a timebox
that fits the uncertainty, cost and feedback speed. Existing notes can suggest a probe, but their claims
need current scope and source checks. Do not finish a long research survey
before trying an operation that can answer the question in minutes.

When researching or searching, prefer this order unless the task clearly requires something else:
1. the repository's established research cache, when one exists
2. applicable instruction files, including `.github/instructions/`
3. the rest of the codebase

Search local code and reusable notes before inventing new code or repeating external research.

When the repository already uses `.agents/research/`, store a reviewable note
there only when external research produced a durable, non-obvious conclusion
that future work is likely to reuse. Do not create bookkeeping directories or
research files merely because this reference mentions them.

Keep research notes reusable, but do not compress away the details that motivated the search.

Research notes should preserve exact details when they matter, such as:
- specific API names or method names
- deprecated symbols and their replacements
- exact commands, flags, or invocation shapes
- version-sensitive behavior
- subtle caveats, exceptions, or migration notes
- the source that established the conclusion

Prefer compact notes over raw transcripts, but do not shrink away the evidence a later agent would need to act correctly.

## Reuse before invention

Before introducing custom implementation work:
- search the codebase for existing patterns, helpers, and abstractions
- check whether a maintained package already solves the problem
- use current documentation when library or framework APIs may already cover the need

Prefer evidence of reuse checks before approving hand-rolled solutions.

## Tool priority

Prefer workspace read, search, symbol, and edit tools first.

Use the terminal mainly for:
- verification
- tests
- benchmarks
- typechecks
- lint
- running scripts

Do not default to terminal-driven exploration when workspace tools can do the job more directly.

## Script policy

For a one-time bulk edit, prefer a reviewable temporary script outside the
production source tree and provide its patch or output when useful. Commit a
script only if the repository has a recurring operation and a clear owner.
Where Mise already owns repository tasks, keep `.mise/tasks/` as small shell
entry points. Put substantial reusable logic in the appropriate package or a
focused typed CLI, not a second `scripts/` or `.mise/lib/` task framework.
Use Deno and TypeScript when they fit the repository; do not introduce Deno
into an unrelated project solely for a temporary edit.

Feel free to use `jsr:` and `npm:` packages when they improve clarity, safety, or reviewability.

Prefer `jsr:@std/*` modules when they fit the task, especially for:
- filesystem work
- encodings
- buffers
- collections
- paths
- related standard utilities

Keep scripts narrow and task-specific.

## Validation and verification bar

Validation is about the changed surface being internally sound.
Verification is about the real deliverable actually working.

Plan completion is separate from deliverable completion.

A task is not fully done unless you complete both checklists in order.

1. Deliverable checklist
- zero TypeScript issues in the changed surface
- no deprecated APIs left behind
- no stale Zod usage when current APIs should be used
- schemas treated as the source of truth when they define the contract
- the real deliverable is complete and verified

2. Plan checklist
- all intended deliverables were identified, tracked, and reviewed against the original goals, requirements, and intent
- the full plan coverage is complete and reviewed

Do not stop at tests, benchmarks, or lint when the real deliverable can be run directly.

For runnable deliverables such as CLIs, jobs, migrations, generators, servers, or user-facing workflows, run the actual capability whenever possible.

For implementation, verify every promised behavior at the required level and
record any failure, blocker, or unrun check. For discovery, supported,
contradicted, or unexpected observations can answer the requested question
within their scope. An inconclusive result can complete a bounded investigation
or support a reversible decision while leaving the original question open.
An investigation completing does not imply that the product fix is complete.
State the scope of the evidence and the decision it supports.

If the capability cannot run because of missing environment, credentials, or
infrastructure, report the exact blocker and remaining verification steps.
Write a repository progress note only when the repository already uses that
mechanism or the user requests a durable handoff.

Review plan coverage separately. If work remains, distinguish known unfinished
work from a concrete blocker and name the next action.

## Progress notes

Use the repository's established progress mechanism or the requested handoff
format to share [anchors](../../../guides/product/anchors.md): the customer
question, actual observation, scope, evidence, meaning, and next decision.
Progress updates establish shared understanding and do not replace completion
of the full authorized deliverable.
