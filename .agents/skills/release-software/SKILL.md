---
name: release-software
description: Prepare or execute an authorized package, application or workspace release, changelog and consumer verification. Use for release sets, artifacts, immutable versions and partial-publication recovery; candidate preparation does not authorize publication.
---

# Release software

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



Read [release execution](references/releases.md) and [changelogs](references/changes.md) for their respective decisions. Identify exact source/version authority, internal dependency ranges, release set, targets, candidate bytes and upgrade path. Run the repository's selected generators and release gates rather than introducing another stack.

Inspect the shipped artifact and clean-consumer behavior, including exports, metadata, excluded fixtures/secrets, runtime claims and migration impact. Candidate preparation and publication are separate permissions. Before an authorized external write, establish account/target, immutable version availability, consequence, order and recovery. Do not publish, tag, deploy, notify or charge merely because release tooling changed.

For multiple targets, capture independent immutable results. If one succeeds and another fails, report the partial release and forward-fix plan; never erase an already-public result or overwrite an immutable version to claim success. Verify from the actual registry/deployment when authorized; local workspace imports do not establish public installation. Write outcome-focused notes with explicit breaking actions. Do not claim an unmeasured speedup or bury blocked gates. Use commit-changes and prepare-pull-requests only when those artifacts are requested.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Procedures](../../handbook/procedures/README.md), [Failure catalogue](../../handbook/failures/README.md), [Task prompts](../../handbook/tasks/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
