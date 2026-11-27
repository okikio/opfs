# Implement the authorized change

This reference applies when implementation is authorized. It does not turn a
review or planning request into permission to edit.

Your job is to carry a locked deliverable through concrete code or docs changes without stopping at partial slices, stale compatibility code, or unvalidated edits.

When researching or searching, prefer this order unless the task clearly requires something else:
1. the repository's established research cache, when one exists
2. applicable instruction files, especially `.github/instructions/`
3. the rest of the codebase

## Constraints
- DO NOT start editing before you understand the repo instructions that govern the touched surfaces.
- Resolve instruction conflicts using the actual instruction priority and existing authorization. Ask only when a material conflict remains unresolved.
- DO NOT start writing custom code before checking whether the codebase already solves the problem or whether a maintained package or documented API already covers it.
- DO NOT use the terminal for routine exploration or manual editing when workspace tools can do the job more directly.
- DO NOT stop at an initial slice when the locked deliverable is larger.
- DO NOT leave TypeScript issues, deprecated APIs, stale Zod usage, or instruction violations behind.
- Run the narrowest automated checks & any end-to-end workflows that cover the files or modules you modified, such as unit tests, type-check, or lint for the touched paths, and leave full integration or end-to-end test runs to the verification stage.
- DO NOT create ad hoc shell, Python, or one-off scripts under `.agents/scripts/` when a reviewable Deno + TypeScript script would do the job.
- DO NOT keep obviously parallelizable exploration or implementation prep work serialized when a focused subagent can own it safely.

## Approach
### Read / Research
1. Before the first edit, read the parent agent instructions, the repo instructions, and the task-specific instruction files that apply to the touched surfaces.
2. Search an established repository research cache first, then relevant
   instructions, code, and dependencies for existing patterns before creating new code.
3. When external libraries or framework APIs might already solve the problem,
   check current primary documentation before hand-rolling an implementation.
   Record reusable findings only when the repository has an established
   research mechanism. Preserve exact API names, deprecations, versions, and
   caveats when they affect the implementation.

### Implement
4. If the deliverable cannot be unambiguously restated from the provided input, stop and list the specific clarifying questions needed before any edits are made.
5. Restate the locked deliverable and identify the smallest controlling code path to change first.
6. Use workspace read, search, and edit tools as the default path for implementation work.
7. For repetitive bulk edits or other scripted writing tasks, use a reviewable temporary script outside production source; keep a script in the repository only for a recurring operation with an owner instead of repeating the same edit pattern manually. Feel free to use `jsr:` and `npm:` packages, especially `jsr:@std/*`, when they simplify the script without obscuring review.
8. When separate exploration, codepath discovery, or repetitive edit preparation can be split safely, use focused subagents in parallel rather than doing all investigation yourself.
9. After the first substantive edit, run the narrowest meaningful validation step before widening scope.
10. Continue until the full locked deliverable is implemented, cleaned up, and locally validated.

## Handoff

Explain the resulting behavior and owners, exact validation and remaining gaps.
Use the task’s output requirements; no independent role template is required.
