---
name: python-software
description: Apply the existing Python runtime, package, test and lifecycle contract when Python code is in scope. Use with the affected domain/capability; do not introduce Python or replace its toolchain merely because this skill exists.
---

# Python software

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



Read [Python engineering](references/python.md) before making Python decisions. Inspect pyproject, supported versions, locks, runner, public modules and task ownership; preserve the deliberately selected toolchain. Keep Python identifiers idiomatic while preserving provider/wire/database field names exactly until an explicit transformation.

Use the project's data model and infer types from runtime schemas where it owns them; do not force TypeScript/Zod conventions into Python. Keep deterministic logic separable from I/O. Preserve cancellation, borrowing/ownership, context-manager cleanup and primary errors through partial failure. Explain important internal parsing, retry, checkpoint and lease invariants in local prose.

Use test-code, benchmark-code or verify-behavior for their actual tasks, and the relevant domain owner. Run the installed public module/CLI or packaged consumer for runtime claims, not only compilation. This skill changes guidance only; selecting it never authorizes adding a Python toolchain to a repository.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
