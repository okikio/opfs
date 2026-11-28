# Deno repository discovery

Use this reference before choosing a Deno architecture or editing manifests.
Discovery should answer concrete ownership questions, not become a tour of every
file.

## Start with repository authority

Read, when present:

```text
AGENTS.md / repository instructions
mise.toml and .mise/tasks/
deno.json / deno.jsonc
deno.lock
package.json
workspace declarations
pnpm/yarn/npm/Bun lockfiles
tsconfig files
CI workflows
package manifests
public entrypoints and exports
```

Then inspect the source/test/build paths touched by the request.

## Classify project mode

Determine:

- Deno-native;
- package.json-first using Deno;
- intentional hybrid.

Do not infer mode from the existence of `deno.json` alone. Current Deno supports
package.json directly, and a deno.json can exist only for tooling/tasks while npm
metadata remains authoritative.

## Manifest ownership map

Create a small table:

| Concern | Owner | Evidence |
|---|---|---|
| workspace members | | |
| npm dependencies | | |
| JSR/import aliases | | |
| scripts/tasks | | |
| tool versions | | |
| format/lint/type settings | | |
| test/bench selection | | |
| publish/package metadata | | |
| permissions | | |
| runtime/build outputs | | |
| CI gates | | |

Conflicting owners are a design issue to resolve deliberately, not an invitation
to synchronize everything into every file.

## Source graph

Trace relevant entrypoints:

```text
public/root export
  -> package module
  -> runtime-specific adapter if any
  -> dependency/resource
  -> tests/consumer
```

For CLIs/services also trace executable composition roots. For reusable packages,
check import-time effects and optional-runtime reachability.

## Deno-specific surfaces to inventory

- `imports`, `scopes`, and public `exports`;
- workspace membership and member manifests;
- root-only settings such as resolver/security/tooling options where current
  docs define them;
- `nodeModulesDir` and npm lifecycle-script policy;
- `workspace:`/`catalog:` placement;
- permissions/permission sets;
- publish settings and JSR identity;
- compile/bundle/desktop tasks;
- lockfile and minimum-dependency-age policy;
- package-manager lockfiles Deno is expected to consume;
- generated build/npm/JSR artifacts.

## Type evidence and runtime evidence have separate owners

Expand the actual task body and follow delegated tasks/scripts before naming a
check. Read compiler pins and lock resolution separately from the command that
executes tests. A Deno task can launch a pinned TypeScript compiler; Deno as task
runner does not imply `deno check` owns type evidence. Record the concrete
compiler/version source and runtime test task found in the consumer, then keep
built declarations, packed consumers and bundles as separate proof. A missing
script limits implementation verification; it does not erase manifest evidence.

## Tests and runtimes

Record the claimed matrix separately from what the current host can execute:

```text
Deno
Node
Bun
browser Window
browser Worker
other deployment/runtime
```

A package that advertises several runtimes needs evidence for each relevant
entrypoint, not one TypeScript check with all globals available.

## Dependency ecosystem check

For material dependencies, inspect the exact package/version/export and whether a
sibling/official adapter/tool changes the integration. Use
`explore-ecosystems` when available. Do not install every sibling or migrate to a
Deno-specific package without a capability reason.

## Dirty tree and generated output

Before editing, distinguish:

- user changes;
- generated files;
- build output;
- caches;
- maintained agent guidance, including an installed `.agents/` tree;
- disposable host adaptations and probes in the repository-approved ignored
  investigation workspace.

Do not overwrite unrelated user changes or run repository-wide formatting as a
side effect of a focused fix.

## Discovery result

A useful repository model includes:

```text
mode: hybrid
workspace owner: root deno.json
npm dependency owner: package.json
Deno imports owner: root/member deno.json as scoped
canonical tests: node:test + @std/expect via Deno/Node tasks
browser tests: Playwright
benchmarks: Mitata
build/package: <actual selected owner>
release: <actual owner>
claimed runtimes: ...
blocked local runtimes: ...
```

Only state values supported by the inspected repository.

## Failure signatures

| Symptom | Discovery miss |
|---|---|
| `workspace:*` moved into deno imports | package protocol ownership not checked |
| package publishes unexpectedly | member publish contract not inspected |
| agent runs wrong task runner | Mise/root task owner ignored |
| Node compatibility broken | package.json-first/hybrid mode misclassified |
| guidance or scratch files enter a runtime package | package contents and development-only ownership were not checked |
| root-only setting copied to member | workspace ownership not checked |
| generated output edited by hand | source/generator owner not identified |

## Exit criterion

Discovery is complete when you can name the controlling manifests, affected
entrypoints, package/runtime mode, test/build/release owners, claimed runtimes,
and adjacent contracts that can change the solution. Do not inspect unrelated
packages after those decisions are resolved.
