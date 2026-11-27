# Standalone delivery fallback

Load this reference when Deno is the only selected implementation capability.
It preserves the complete change lifecycle without imposing a duplicate plan
when a focused capability and domain owner already cover that work.

## End-to-end workflow

### Stage 1: Resolve the objective

Translate the request into an outcome that can be verified.

Capture:

- user-visible or maintainer-visible outcome;
- behavior that must stay unchanged;
- intentional behavior changes;
- supported runtime, operating systems, CPU architectures, and deployment
  targets;
- public APIs and compatibility promises;
- acceptance criteria;
- constraints imposed by connected systems.

Do not mistake a requested edit for the actual outcome. For example, “replace
npm scripts” may really mean “make local development and CI deterministic under
Deno without breaking external tooling.”

### Stage 2: Discover the repository

Run or emulate the audit in `scripts/audit.ts`. At minimum inspect:

```text
deno.json / deno.jsonc
package.json
npm, pnpm, Yarn, Bun, and Deno lockfiles
workspace declarations
imports and exports
tasks and scripts
entrypoints
source and test layout
CI and release workflows
container and deployment configuration
generated output and ignored paths
```

Build a short repository model:

```text
project mode:
minimum Deno version:
workspace shape:
dependency sources:
entrypoints and public exports:
tasks and CI gates:
permissions:
artifacts and deployment targets:
connected systems:
```

### Stage 3: Classify the project mode

#### Deno-native

Use when Deno owns execution, tasks, dependency declaration, and distribution.

Typical source of truth:

- `deno.json` or `deno.jsonc`;
- `deno.lock`;
- JSR and npm imports declared through Deno configuration;
- Deno tasks and built-in tooling.

#### package.json-first

Use when npm ecosystem tooling, package publication, framework conventions, or
existing consumers require package.json to remain authoritative.

Typical approach:

- preserve package.json dependencies, scripts, exports, and workspace metadata;
- run existing workflows with Deno where compatible;
- use Deno configuration only for Deno-specific behavior;
- consider `preferPackageJson` only after confirming it fits the current Deno
  version and repository workflow.

#### Hybrid

Use when both ecosystems have durable responsibilities.

Document ownership. A common split is:

```text
package.json
  npm publication metadata
  dependencies required by Node-oriented tooling
  scripts consumed by external tools
  exports for npm consumers

deno.json
  Deno workspace membership
  Deno tasks and permission sets
  lint, fmt, test, coverage, compiler configuration
  Deno-native imports and JSR publication metadata
```

Do not duplicate dependency declarations without an explicit synchronization
rule.

### Stage 4: Research uncertain contracts

Before implementation, verify current official documentation and source when any
of these are material:

- a feature landed in a recent Deno release;
- a flag or config field may be unstable;
- framework detection, compilation, desktop packaging, or deployment behavior
  matters;
- Node compatibility depends on package internals, native addons, subprocesses,
  postinstall scripts, or filesystem layout;
- a package's runtime behavior determines architecture;
- a recommendation would replace established tooling.

Read connected-system documentation and source too. A Deno solution can still
fail because of Vite, Astro, Hono, Drizzle, npm lifecycle scripts, a database
driver, or a deployment target.

### Stage 5: Design the complete change

Create an implementation map with objective outcomes, not progress percentages.

For each deliverable specify:

- files to add, edit, move, or delete;
- interfaces and data flow;
- behavior preserved and behavior changed;
- configuration and dependency changes;
- migration and rollback concerns;
- tests and fixtures;
- manual or artifact-level validation;
- obsolete paths to remove.

Revisit the alternatives after research. Compare them again using the same
criteria: correctness, compatibility, security, operability, simplicity,
performance, maintenance cost, and reversibility.

### Stage 6: Implement with Deno-appropriate defaults

Unless the repository requires otherwise:

- use strict TypeScript, ESM, and explicit local file extensions;
- prefer JavaScript-native TypeScript syntax;
- prefer web APIs for portable concerns and Node APIs when compatibility or
  ecosystem integration makes them the better contract;
- use JSR for Deno-native packages and `@std/*`, npm for the best available npm
  package;
- keep I/O, process, network, environment, FFI, and system access explicit;
- propagate `AbortSignal` through cancellable async work;
- close resources deterministically with `using` / `await using` where supported
  and appropriate;
- avoid module-level side effects in libraries;
- keep CLIs thin over reusable application modules;
- keep servers explicit about startup, shutdown, errors, timeouts, and
  telemetry;
- make generated outputs reproducible and excluded from lint/format only when
  justified.

### Stage 7: Remove superseded paths

A refactor or migration is incomplete while an older implementation remains
reachable or documented.

Search for and remove:

- old modules and duplicate implementations;
- stale exports and re-export barrels;
- abandoned tasks and scripts;
- unused dependencies and import aliases;
- obsolete compatibility branches;
- outdated docs, examples, fixtures, comments, and environment variables;
- generated artifacts accidentally committed by the old workflow.

Preserve an old path only when backward compatibility is an explicit
requirement. Mark ownership, deprecation behavior, removal criteria, and tests.

### Stage 8: Verify in layers

Start narrow, then expand:

```bash
deno fmt --check <changed paths>
deno lint <changed paths>
deno check <affected entrypoints>
deno test <affected tests>
```

Then run repository gates:

```bash
deno task check
deno task test
deno task ci
```

Use only tasks that actually exist. When no aggregate task exists, run the
underlying commands directly.

Artifact-level verification is mandatory when producing artifacts:

- bundle: execute or import the bundle in its intended runtime;
- compiled executable: run the binary and test exit behavior and permissions;
- package: validate exports, docs, publish dry-run, and consumption from a clean
  fixture;
- desktop app: build and smoke-test the generated package on supported targets;
- container/deployment: start it with production-like configuration and check
  readiness/shutdown.

### Stage 9: Report exact results

Report:

- repository mode and important constraints;
- completed behavior and architecture;
- intentional behavior changes;
- removed obsolete paths;
- commands run and observed results;
- artifact smoke tests;
- unresolved risks and checks blocked by the environment.

Do not substitute “should work” for verification.

## Task routers

### Create a new project

1. Establish artifact type: script, CLI, library, server, web app, worker,
   binary, or desktop app.
2. Pick Deno-native, package.json-first, or hybrid based on consumers and
   tooling.
3. Define minimum Deno version and runtime targets.
4. Create the smallest complete structure, including tasks, tests, permissions,
   and CI.
5. Add only dependencies required by the design.
6. Verify from a clean checkout or equivalent fixture.

Use templates in `templates/` as starting points, not unquestioned output.

### Add a dependency

1. Confirm the package actually solves the requirement.
2. Check JSR, npm, built-in web APIs, Node APIs, and `@std/*` in that order of
   relevance, not ideology.
3. Confirm runtime support, package exports, license, maintenance, transitive
   graph, and required permissions.
4. Add through the owning package manager.
5. Inspect `deno list`, lockfile changes, scripts, and native/build
   requirements.
6. Add focused integration tests.

### Migrate Node to Deno

Treat migration as staged compatibility validation:

1. preserve the current manifests and lockfile;
2. install with Deno and inspect the resulting graph;
3. run existing scripts unchanged;
4. classify failures: CLI assumptions, Node API gaps, lifecycle scripts, native
   addons, module resolution, CJS/ESM, filesystem layout, or unsupported
   tooling;
5. fix the smallest incompatibilities first;
6. only move ownership into deno.json when it reduces complexity;
7. keep a reversible checkpoint until production workflows pass.

Never begin with a broad rewrite.

### Refactor

1. map the old design and all consumers;
2. define invariants and intentional changes;
3. introduce the final structure in one coherent change;
4. migrate every caller;
5. remove the old structure and dependencies;
6. search for residue;
7. verify behavioral parity and repository-wide gates.

Do not leave “temporary” duplicate paths unless the user requested a staged
migration.

### Review

Prioritize:

1. correctness and data loss;
2. security and permission expansion;
3. public API and persisted-data compatibility;
4. cancellation, concurrency, disposal, and shutdown;
5. module resolution and workspace behavior;
6. package and Node compatibility;
7. tests and observability;
8. performance;
9. maintainability;
10. style.

Every finding must include concrete behavior, affected scenario, complete
correction, and verification.

### Debug

1. reproduce with the smallest valid command;
2. record Deno version, OS, architecture, project mode, flags, and environment
   assumptions;
3. distinguish resolution, type-check, permission, runtime, network, native
   dependency, subprocess, and application failures;
4. use permission traces/audits, `deno info`, `deno list`, logging, and focused
   tests as appropriate;
5. fix the cause rather than disabling the guardrail;
6. add a regression test.

### Publish a library

1. define the public entrypoints and supported runtimes;
2. avoid hidden global state and broad permissions;
3. validate exported types and documentation;
4. test direct source consumption and packaged consumption;
5. verify semver impact;
6. run a publish dry-run or equivalent package check;
7. test from a clean consumer fixture.

### Performance work

1. define the user-visible metric and workload;
2. measure a stable baseline;
3. inspect algorithmic, allocation, I/O, serialization, module-loading, and
   permission overhead before micro-optimizing;
4. change one causal factor at a time;
5. benchmark under equivalent conditions;
6. run correctness tests after optimization;
7. report distributions and environment, not only a single best number.

