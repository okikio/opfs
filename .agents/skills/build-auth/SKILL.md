---
name: build-auth
description: Configure or review authentication, sessions, magic links, passkeys and provider integration with Better Auth. Use for auth configuration and auth-schema reconciliation; compose with API/data owners rather than treating login as per-record authorization.
---

# Build authentication contracts

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



Read [Better Auth integration review](references/better-auth.md) for version lookup, adapter/schema reconciliation, session storage and revocation, providers, hooks and verification. Resolve exact APIs against the installed package and matching primary documentation. The reference contains no automatic installation or migration workflow.

Inspect the real auth configuration, adapter, generated review candidate, physical schema and migration owner. Where Better Auth generation produces a candidate and Drizzle owns PostgreSQL migration generation/application, reconcile names, keys, relations, defaults, indexes and plugin tables without overwriting the physical schema or migration history. Never run push/migrate against ambient credentials. A schema review does not authorize database redesign or execution.

Choose build-apis for endpoint/cookie/session and record-policy decisions, build-data for storage/migration decisions, use-utils for current service/gateway contracts, and build-web/build-web-apps only when client changes are authorized. Authentication establishes identity; resource access still needs current membership and record authorization. Do not infer an enabled Google/mail/passkey provider from a product plan.

Keep secrets in the host's established environment owner, providers explicit, callbacks/imports inert and errors free of credentials. Verify relevant expiry, replay, failure, logout and access-denial behavior with the owner's disposable fixtures. State exact configured versus planned capabilities. Do not install packages or regenerate/apply schemas merely to inspect them.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
