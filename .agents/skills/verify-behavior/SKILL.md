---
name: verify-behavior
description: Validate a changed contract and execute the real CLI, artifact, package consumer or service workflow to establish evidence. Use for verification and completion audits; verification itself does not authorize implementation fixes or live external mutations.
---

# Verify behavior

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



Read [validation](../../references/validator.md) for internal contracts and [verification](references/verifier.md) for the real consumer workflow. Read [delivery evidence](../../references/delivery.md) for multi-surface reconciliation. Keep those proof levels separate: a green type check or source test cannot establish an unrun built artifact or native runtime.

Use [experiments](../../guides/product/experiments.md) to choose the smallest
execution that can answer the current product question. Verify early when a
direct operation is available; do not reserve all evidence for final integration.
Keep direct component, application, and customer-outcome claims separate. A
contradicted hypothesis can complete an investigation while the requested
product fix remains open. Publish the observation and next decision as an
[anchor](../../guides/product/anchors.md), including failed or blocked attempts.

Name the exact target, inputs, runtime, artifact, credential owner and permitted state changes before executing. Use disposable fixtures and reversible local workflows where applicable. Inspect package/archive contents, extract or install the exact produced artifact in a clean location, and exercise its public entrypoint. Check output/state and cleanup, not exit code alone. Never use production credentials or external writes merely to make a verification claim.

Inspect comments, docs, names, imports and readability as part of validation. Do not edit the implementation during a verification-only request. Report each required scenario as observed, failed or blocked, with commands and limits. Reconcile request, plan, actual implementation and proof; one passing scenario cannot erase a failed or unrun required scenario. Suggest a concrete next step rather than substituting mock evidence for a real capability.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Task prompts](../../handbook/tasks/README.md).

For any project using the pack, see [Product development](../../handbook/product/README.md).
