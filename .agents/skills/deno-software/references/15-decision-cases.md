# Deno Decision Cases

Use these cases when a repository looks like more than one Deno project mode or when a familiar rule would produce a misleading answer.

## Deno-native library with `package.json`

A library can use Deno as its source/task authority and still ship npm metadata. Do not classify it as package.json-first merely because `package.json` exists.

Inspect:

- which manifest owns source imports;
- which task builds/publishes npm output;
- whether npm metadata is generated or hand-authored;
- which lockfile is authoritative;
- whether Node is a supported consumer or only a validation runtime.

Keep one TypeScript source graph unless a real runtime incompatibility requires an explicit adapter.

## package.json-first project run with Deno

Do not migrate manifests automatically. Deno can run many npm/Node projects directly. Preserve package-manager and framework ownership unless the requested change is a migration.

First prove the actual incompatibility. If the project works under Deno with its existing `package.json`, changing every import to `jsr:` is churn, not architecture.

## Hybrid workspace

A workspace can contain Deno-native and package.json members. Determine which settings are root-owned and which manifest syntax is valid in each member before editing dependency protocols or task configuration.

Do not copy a root-only option into every member merely to make configuration look symmetrical.

## Node API in otherwise portable source

A Node API import is not automatically wrong. Ask whether:

- the package promises browser/worker portability;
- a Web API or `@std/*` package already covers the requirement;
- the Node-specific path can live behind an explicit runtime subpath;
- Deno's Node compatibility is intentionally part of the contract.

Choose from the supported runtime surface, not from ideology.

## Missing Deno in the validation host

Do not install Deno or rewrite production imports merely to satisfy an agent host unless the task explicitly requires environment provisioning.

Use available validation tooling for contracts it can prove, then report native Deno commands as blocked. A Node type-check with a Deno shim does not prove Deno runtime behavior.

## JSR versus npm publishing

Treat registry choice as a consumer and package contract. Inspect:

- intended consumers;
- package exports and generated files;
- dependency protocols;
- runtime support;
- publication tasks and provenance;
- clean-consumer tests.

Do not publish the same source shape to two registries unless both artifacts are intentionally supported and independently verified.

## Deno task versus mise task

When mise is the repository task authority, use its task graph. A Deno project does not imply `deno task` is the top-level operator interface.

Package-local `deno task` commands can still be valid implementation details. Avoid creating a second top-level workflow that drifts from CI.

## `node:test` in a Deno-first repository

This is valid when the project deliberately uses one shared TypeScript test source across Deno and Node. In the Deno-first default used by this collection, `node:test` plus `@std/expect` is the normal package-test API while runtime-specific suites prove Deno/browser/worker/Node/Bun claims.

Do not replace the shared test API with a Deno-only wrapper merely because Deno is the primary runtime.

## Experimental Deno capability

If a feature is unstable or newly introduced:

1. verify its current official status;
2. identify the minimum runtime version;
3. isolate it from unrelated import paths when practical;
4. document fallback or failure behavior;
5. test the exact artifact/runtime path;
6. do not describe it as universally available.

## Compile or desktop artifact

A passing source test does not prove a compiled or desktop artifact. Build the artifact, inspect its contents/size/configuration, run the exact artifact in a clean location, and verify permissions, assets, runtime files, and startup behavior.

## Replacement refactor

When compatibility is not requested, migrate every current consumer, export, task, test, doc, fixture, and generated artifact to the replacement, then remove the obsolete path. Search for stale names afterward.

Do not leave a forwarding alias “just in case.”

## Decision template

For an ambiguous Deno change, write the decision in this order:

```text
Repository mode
Current authority
Claimed runtimes/consumers
Exact contract that must change
Current Deno/upstream evidence
Rejected alternatives and why
Required migration/removal
Native verification gates
Blocked gates
```

This keeps the decision tied to the repository rather than to a generic Deno preference.
