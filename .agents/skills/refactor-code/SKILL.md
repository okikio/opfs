---
name: refactor-code
description: Refactor or migrate code and cut consumers over to a replacement while preserving explicit behavior. Use for obsolete-path removal, package reorganizations and compatibility cutovers; retain domain and runtime owners.
---

# Refactor code

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



Read [refactors and migrations](references/refactors.md) before cutover and [implementation](references/implementer.md) for a complete change. Use [cases](../../references/cases.md) for ambiguous scope. Trace the current runtime entrypoint and every consumer before editing; a new helper with direct tests does not establish adoption.

Create required-end-state and removal inventories. Characterize inputs, outputs, errors, timing, permissions, ownership, cancellation, cleanup, persistence and measured guarantees. List deliberate behavior changes separately. Use an atomic replacement when all consumers can move; use an explicit staged migration only when the system requires it, with an owner and removal condition.

Update real registration, exports, imports, dependencies, config, generators, fixtures, benchmarks, comments and docs together. Search old identifiers and retrace the runtime, including dynamic registration. Keep dirty user work intact. Select build-data for persistence decisions, build-workflows for recovery, and actual domain/runtime owners. Never redesign a database or UI merely because this refactor touches guidance about it.

Run focused characterization, affected full checks and real public-path verification. Use verify-behavior for a distinct evidence pass. Do not report complete while an obsolete path remains authoritative.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Handbook](../../handbook/architecture/README.md), [Task prompts](../../handbook/tasks/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
