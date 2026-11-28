# ESM packaging, exports, and selective adoption

Use this reference when publishing a TypeScript library, splitting optional
integrations, designing subpath exports, diagnosing tree-shaking, or validating
the package from a clean consumer.

## Architecture before metadata

Tree-shaking begins with module ownership. `"sideEffects": false` cannot repair
an entrypoint that eagerly imports every adapter, constructs a registry, or
performs work at module scope.

A selectively adoptable graph should look like:

```text
@scope/library
  core use cases and public domain values

@scope/library/browser.js
  browser adapter and browser-only dependencies

@scope/library/storage.js
  storage adapter

@scope/library/logtape.js
  optional diagnostics integration helpers
```

Importing core must not traverse browser, database, CLI, workflow, or telemetry
dependencies.

## Preserve ESM

Publish static ESM entrypoints where supported. Preserve `import` and `export`
through the library build so bundlers can reason about symbol use. Avoid making
CommonJS the only distributed representation when tree-shaking is a requirement.

Use explicit file extensions in relative imports and public subpaths according
to the repository's runtime and package policy.

## Public exports

Define the public contract with `exports`:

```json
{
  "name": "@example/analysis",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./browser.js": {
      "types": "./dist/browser.d.ts",
      "import": "./dist/browser.js"
    },
    "./storage.js": {
      "types": "./dist/storage.d.ts",
      "import": "./dist/storage.js"
    }
  }
}
```

Explicit subpaths encapsulate internals and give consumers stable entrypoints.
Do not export source-directory wildcards merely to avoid deciding the API.
Patterns can be appropriate for large regular surfaces, but audit what they
expose.

## Named exports and root barrels

Named exports support selective use:

```ts
export { analyzeDomains } from "./analyze-domains.js";
export { evaluateBatches } from "./evaluate-batches.js";
```

A root barrel is acceptable when re-exporting side-effect-free core modules.
It becomes harmful when it imports adapters, registrations, polyfills, generated
catalogues, or dependency-heavy defaults.

Avoid eager namespace objects:

```ts
export const library = {
  analyzeDomains,
  createBrowserCollector,
  createDatabaseStore,
  registerAllDetectors,
};
```

Such objects encourage unit retention and can require importing every member.

## Side effects

Import-time effects include:

- global registration;
- logging configuration;
- signal installation;
- environment or config discovery;
- resource acquisition;
- polyfill mutation;
- filesystem or network work;
- decorators or static initialization with observable effects.

Prefer explicit functions:

```ts
export function registerBuiltInDetectors(
  registry: DetectorRegistry,
): void {
  // The caller requested mutation.
}
```

Declare package metadata truthfully:

```json
{
  "sideEffects": false
}
```

or list exact effectful built files:

```json
{
  "sideEffects": [
    "./dist/polyfill.js",
    "./dist/register.js"
  ]
}
```

Incorrect `sideEffects` metadata can remove required behavior. Treat it as a
verified contract, not an optimization incantation.

## Optional dependencies and peer dependency ranges

Place optional adapters in separate modules or packages. Avoid top-level imports
that make optional dependencies mandatory at resolution time.

Choose dependency ownership explicitly:

- dependency: implementation requires it at runtime;
- peer dependency: host must supply a compatible singleton or framework;
- optional peer: integration is optional and imported separately;
- development dependency: build/test only.

Test missing optional dependencies. Core imports should continue to work.

## Conditional exports

Use conditional exports only for meaningful runtime differences with equivalent
public contracts. Do not create browser, Node, Deno, worker, import, and require
branches without testing every branch.

Keep runtime-specific code in leaf modules. Avoid conditions that silently
change semantics, precision, error types, or resource ownership.

## Build output

Preserve useful module APIs. A library distributed only as one bundled
file can still tree-shake in some toolchains, but separate side-effect-free ESM
modules and explicit subpaths make ownership and optional dependencies easier to
verify.

Verify:

- JavaScript entrypoints;
- declaration entrypoints;
- source maps if promised;
- exports and imports targets;
- package file inclusion;
- license and metadata;
- runtime-specific conditions;
- absence of source-only or internal files from public exports.

## Tree-shaking evidence

Source inspection is insufficient. Create clean consumers:

```text
consumer-core
  imports one core function

consumer-adapter
  imports one optional adapter

consumer-root
  imports supported root facade
```

Bundle each with the supported bundler or representative bundlers. Inspect:

- output bytes and metafile/module graph;
- presence of known optional dependency markers;
- import-time behavior;
- retained top-level initializers;
- warnings about CommonJS or side effects;
- semantic output.

Use a negative marker in optional modules to prove they are absent, not merely a
small bundle-size threshold.

## Import and startup paths

Measure import-only and first-call cost for:

- core entrypoint;
- each optional adapter;
- root convenience entrypoint;
- CLI help/version path if the package includes an executable.

Lazy dynamic imports can reduce startup but add first-use latency and async
failure modes. Use them when runtime selection is real, not to hide a poorly
partitioned root graph.

## Compatibility and release

Adding `exports` to an existing package can break undocumented deep imports.
Inventory real consumers before cutover. Decide whether to:

- preserve selected legacy subpaths temporarily;
- publish a major release;
- provide codemods or migration notes;
- intentionally remove unsupported internals.

Do not keep compatibility surfaces indefinitely without an owner and removal
condition.

## Failure signatures

- root entrypoint imports every adapter and rule pack;
- module import launches work or configures globals;
- `sideEffects: false` is added without auditing top-level effects;
- source modules tree-shake but the distributed build converts them to CommonJS;
- optional dependencies are reachable from core;
- wildcard exports expose internal mechanisms;
- types and JavaScript exports disagree;
- a package test imports source paths instead of the packed artifact;
- bundle size is reported without proving which modules were retained;
- only one runtime or conditional branch is tested.

## Verification

- pack the exact publishable artifact;
- install it into clean Deno, Node, or bundler consumers as supported;
- import every public subpath and reject private paths;
- run type checking against declarations;
- bundle core and adapter consumers with metafile analysis;
- assert unused adapter markers and dependencies are absent;
- test import-time global and resource effects;
- verify missing optional dependencies do not break core;
- compare package contents and exports against an allowlist;
- run the published artifact's examples, not source aliases.

## Sources and freshness

- Node.js package `exports`, subpath, and conditional export documentation,
  reviewed 2026-07-23.
- esbuild tree-shaking and side-effect documentation, reviewed 2026-07-23.
- unbuild and package tooling evidence in the repository, reviewed 2026-07-23.
- Library-first guidebook, reviewed 2026-07-23.
