# Delivery playbooks

These playbooks combine the Deno-specific runtime/tooling model with the general delivery contract. Always inspect the repository first. A Deno project can be Deno-only, browser-first, server-side, hybrid Deno/Node, or a multi-runtime library, and the correct gates differ.

## Feature implementation

1. **Map the user flow and execution realms.** Identify Deno CLI/service code, browser/worker code, Node-compatible consumers, package entrypoints, and external services involved.
2. **Inspect manifests and task ownership.** Read `deno.json(c)`, `package.json`, workspace metadata, lockfile, mise tasks, CI, import maps, and JSR/npm configuration.
3. **Define schemas and public types.** Use Zod project schemas where runtime validation is required, infer project data types, and preserve Standard Schema interop when consumers need validator independence.
4. **Choose module ownership.** Generic programming models belong in the appropriate utility layer; concrete domain capability belongs in a package; executable wiring belongs in CLI/app/service composition.
5. **Implement core behavior.** Keep deterministic logic independent of I/O where that improves testing, but do not create abstraction layers without a real owner or second use.
6. **Integrate runtime resources.** Make permissions, cancellation, disposal, environment use, and injected resource ownership explicit.
7. **Add tests at the right layers.** Use `node:test` + `@std/expect` for the normal portable package suite, then add Deno/browser/worker/Node/Bun execution for behavior that depends on those runtimes.
8. **Update docs/examples.** Explain public usage, lifecycle, failure behavior, support limits, and environment requirements.
9. **Run focused gates, then repository gates.** Do not report blocked Deno checks as passed because a Node-hosted fallback succeeded.
10. **Verify the real artifact/workflow.** Run the CLI/service/package consumer from the built or packaged output when applicable.

## Complete replacement

Use this when compatibility is not required and the old path must disappear.

1. Inventory old modules, exports, consumers, tests, docs, dependencies, task/config entries, import-map aliases, JSR/npm metadata, and generated output.
2. Trace current runtime dispatch and public imports.
3. Define final architecture and observable invariants.
4. Separate formatting-only work from functional changes.
5. Implement the final modules and public entrypoints.
6. Migrate every consumer, including examples and clean-consumer fixtures.
7. Remove old modules, aliases, task/config keys, dependencies, and stale lock entries.
8. Search the whole repository for old identifiers/imports.
9. Run parity/regression tests and supported-runtime gates.
10. Inspect and run the final artifact.

A replacement is not complete because the new abstraction exists. The old abstraction must no longer participate unless the requirement explicitly keeps it.

## Dependency migration

Deno projects can consume `jsr:`, `npm:`, URL, import-map, and workspace dependencies. Before changing a dependency, identify which manifest owns it and how Node-compatible consumers resolve it.

1. Find every direct use, re-export, import-map alias, lock entry, and transitive expectation.
2. Read current upstream source/docs for version-sensitive behavior.
3. Create characterization tests for behavior/types that matter.
4. Add the replacement through the final public API rather than a temporary parallel API when possible.
5. Migrate all call sites and generated/configured references.
6. Remove the old dependency, types, adapters, and lock entries.
7. Run security, type, behavior, and packaging checks.
8. Compare bundle size, startup, or runtime performance when the dependency migration was motivated by those costs.

Do not preserve both dependencies indefinitely unless a real compatibility window requires them.

## Deno and Node portability migration

When a Deno-first library must also work in Node, keep one TypeScript implementation whenever the runtime APIs permit it.

Prefer Web APIs and portable `@std/*` contracts. Put truly runtime-specific behavior behind explicit subpaths or adapters. Do not move Node shims into production merely because a validation host lacks Deno.

Validate:

```text
Deno type/runtime path
Node type/runtime path
browser/worker path when claimed
package export/import paths
clean consumer in each published ecosystem
```

A Node-hosted test of Deno-like code is useful supporting evidence, not proof that Deno permissions, module resolution, or runtime APIs work.

## Publishing a Deno/JSR library

Before publishing:

- validate `deno.json(c)` exports and workspace relationships;
- ensure the lockfile and generated output are current;
- inspect JSR/npm package metadata and exclusion rules;
- run `deno publish --dry-run` or the current equivalent when the project publishes to JSR;
- build any npm translation/export using the repository-selected tool such as dnt when applicable;
- inspect exact tarballs/artifacts;
- install them in clean consumers and run public APIs.

Do not claim JSR readiness from an npm tarball or npm readiness from a JSR dry run. They are different consumer paths.

## Review

Report findings in descending impact. Prefer concrete lifecycle, security, persistence, public API, runtime, packaging, and performance defects over style commentary.

Each finding should answer:

```text
What concrete behavior occurs?
Why is it wrong or risky?
When does it happen?
Which implementation owns it?
What is the complete correction?
How can the correction be proven?
```

For Deno-specific claims, include the relevant permission/module/config/runtime evidence.

## Debugging

Build an evidence table before changing code:

| Dimension | Observation |
| --- | --- |
| Deno version | exact output |
| OS/architecture | exact target |
| command | exact command and cwd |
| manifest mode | Deno/package/hybrid |
| workspace | relevant members |
| lockfile | version and state |
| permissions | exact grants |
| import source | JSR/npm/URL/workspace |
| error phase | resolve/check/runtime/artifact |
| minimal reproduction | path or command |
| regression test | expected behavior |

Find the earliest divergence. A permission error, resolver error, type error, runtime API error, and packaged-artifact error can have similar downstream symptoms but require different fixes.

## Architecture planning

A Deno architecture plan must include:

- direct current-state evidence;
- execution realms and supported runtimes;
- module/package ownership and dependency direction;
- permission/resource ownership;
- manifest, import, and package-export effects;
- alternatives compared by consistent criteria;
- migration/removal steps;
- tests and runtime verification for every phase;
- artifact/publishing effects;
- rollback or forward-recovery strategy for persistent/external state.

Do not use percentage progress as a substitute for completed outcomes and verified gates.
