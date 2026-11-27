---
name: use-utils
description: Select, adopt, migrate, review, or debug packages from okikio/utils. Use for Context and state, disposal and resource ownership, environment/schema contracts, tasks/workflows, scheduling, storage, services/HTTP, queries, streams, formats, hashing, runtime adapters and telemetry. Verify exact public exports and distinguish source versions from available releases before writing integration code.
---

# Use the Okikio utility packages

Read [software quality](../../guides/software-quality.md) and the applicable
[standards](../../guides/applying-standards.md). Read the reference that resolves
the current decision; the package map is a route, not a reading checklist.
The domain skill owns the behavior change and its final verification.

## Establish the package contract

Use [okikio/utils](https://github.com/okikio/utils) as the source for this utility
suite. Its focused packages use `@okikio/<package>` names. Preserve a consumer's
existing dependency owner unless replacing it is part of the task.

1. State the need, such as "stop four active downloads and join their cleanup".
2. Find the smallest owner in [packages](references/packages.md). Inspect its
   export map, implementation and relevant tests at a recorded revision.
3. Follow [adoption](references/adoption.md) to verify the consumer's resolver,
   exact version or source commit, and installed/built artifact. A source
   manifest is not proof that a registry version exists.
4. Use a focused public entry, such as `@okikio/format/csv`. If no verified
   package fits, keep the smallest task-specific code and record the gap.
5. Trace acquisition, borrowing, cancellation, disposal and result settlement.
   Test the success, rejection and cleanup paths in the claimed runtime.

The references describe source commit
`32ecdf41cf9d29ea2cd0ffe2605f9199d4afa0a7`, checked on 2026-11-26.
At that check, npm supplied placeholders or missing packages; JSR publication
could not be verified. Do not infer install commands from the source versions.
Recheck the actual registry when an installation or upgrade is requested.

## Choose the lifetime before the mechanism

- Use ordinary values or iterables when the operation needs no live owner.
- Use `@okikio/dispose` for owned cleanup; use `/once` when close callers must
  share one completion receipt. Repeated stack disposal does not supply that join.
- Use `@okikio/context` for cancellation, deadlines and scoped cleanup;
  `/state` lends read-only observations while the cell keeps write authority.
- Use `@okikio/capability/resource` for typed lazy acquisition and borrowing.
- Use Task for one cooperative local operation. Use Workflow and a verified
  durable adapter only when the recovery contract requires them.
- Treat effects as required announcements and telemetry as observation.
  Neither an Observable nor an in-memory emitter supplies durable delivery.

Keep standalone libraries such as `@okikio/observables`, Undent, SPARQL,
Wikitext and OPFS under [use-okikio](../use-okikio/SKILL.md). Context and Input
reuse Observables; do not invent a replacement `utils/observables` entry.

## References and completion

- [packages](references/packages.md): source identities, public subpaths,
  ownership and missing counterparts.
- [adoption](references/adoption.md): publication evidence, resolver checks,
  environment/schema example and migration procedure.
- [services](references/services.md): definitions, binding, compilation,
  resources, HTTP, queries and effects.
- [workflows](references/workflows.md): cleanup, state, Task, workflow,
  dispatch, history and durable acceptance.
- [resource index](references/resources.md): conditional navigation.

Report the source and resolver checked, behavior exercised, cleanup outcome and
remaining runtime or publication limits. Do not call source inspection an
installed-package, database, browser or deployment test.
