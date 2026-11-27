---
name: test-code
description: Design, implement or diagnose meaningful tests and regression fixtures. Use for independent oracles, test isolation, lifecycle, runtime parity and test-container ownership; compose with benchmark-code for performance claims.
---

# Test code

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



Read [testing](../../references/testing.md) and use [validation](../../references/validator.md) for a distinct read-only validation pass. Resolve the actual selected runner, aliases and assertion helpers. Name the failed behavior and independently expected result before writing a test; do not mirror the candidate's implementation or settle for length/checksum/positive-only assertions.

When an edge-case policy is unresolved, keep the proposed expectation exploratory
until the source owner or controlling contract resolves it. Do not turn an
assumption into a required regression assertion merely because it is listed
openly in the report. Characterization may preserve observed behavior; a new
expected policy needs independent authority.

Preserve visible setup and scenario intent. Test failure, cancellation, partial acquisition, cleanup, ordering, concurrency and serialization when they are part of the contract. Direct runner/assertion imports are legitimate. Document important fixtures and units, but do not require essays on trivial private glue. Use the owner's disposable fixtures for real integration; never fall back to ambient credentials. Inspect TestKit/Testcontainers APIs and cleanup in the actual installed version before changing provisioning.

Keep diagnosis separate from a fix unless both are authorized. Start with the smallest useful reproduction, then affected full checked gates. Use build-devtools for runner/container/CI mechanics, the actual domain owner for semantics, and deno-software or python-software for runtime proof. Tests do not replace verify-behavior when the claimed CLI, artifact or workflow can run.

For browser rendered-content fixtures, read the shared [Break UI catalog](../design-interfaces/references/rendered-content.md) with build-web. Pure contract tests do not need that browser detail or a visual redesign companion.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Engineering and CI](../../handbook/engineering/README.md), [Task prompts](../../handbook/tasks/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
