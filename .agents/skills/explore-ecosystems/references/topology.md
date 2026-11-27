# Ecosystem topology and relationship discovery

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Topology classes](#topology-classes)
- [Discovery algorithm](#discovery-algorithm)
- [Relationship taxonomy](#relationship-taxonomy)
- [Monorepo package discovery](#monorepo-package-discovery)
- [Multi-repository ecosystem discovery](#multi-repository-ecosystem-discovery)
- [Specification and framework ecosystems](#specification-and-framework-ecosystems)
- [Private, personal, and generated ecosystems](#private-personal-and-generated-ecosystems)
- [Capability graph and ownership map](#capability-graph-and-ownership-map)
- [Stopping and completeness](#stopping-and-completeness)
- [Failure signatures](#failure-signatures)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference after a material dependency is identified and before assuming
the named package represents its full capability surface. It is especially
important for monorepos, organizations such as UnJS, packages with many official
adapters/plugins/drivers, framework bindings, specifications, and remembered
private/personal libraries.

## Outcome

Produce a bounded, evidence-backed graph in which nodes have exact identity and
status, edges have named semantics, capability ownership is visible, and
incidental adjacency is excluded. The graph should reveal missing siblings or
adapters without pressuring the implementation to install all of them.

## Topology classes

Classify actual topology after investigation:

| Class | Defining evidence | Common discovery risk |
|---|---|---|
| Standalone | no task-relevant first-party/spec siblings found | inventing an ecosystem from naming |
| Monorepo | verified workspace root and package manifests | inspecting only the flagship package |
| Multi-repository ecosystem | canonical owner/docs connect separate repositories | treating all org repos as one product |
| Package family | separately published core/adapters/plugins under one project | installing core without needed adapter |
| Framework integration ecosystem | bindings by renderer/runtime/deployment | copying a binding for the wrong host |
| Specification ecosystem | independent implementations share a versioned contract | assuming optional capabilities interoperate |
| Service/platform ecosystem | API/SDK/CLI/plugins plus remote service | ignoring credentials, quotas, region, lifecycle |
| Private/personal ecosystem | relationships observed in source/consumers, not public registry | inventing unpublished APIs |
| Hybrid | more than one of the above with verified edges | flattening status/version across layers |
| Unresolved | identity or relationships cannot be established | asserting topology from memory/search snippets |

"Ecosystem" is a capability relationship, not a compliment or brand category.

## Discovery algorithm

### 1. Seed exact identities

For each known import/product, record package name, resolved version, registry,
repository, owner, manifest path, export map, and integrity/revision. Expand aliases,
workspace protocols, patches, overrides, forks, and generated clients.

### 2. Inspect local graph

Search:

- root/nearest manifests and workspace declarations;
- lockfile package and peer/optional dependency edges;
- import graph, wrappers, reexports, lazy/dynamic imports;
- config/plugin/adapter registration;
- examples/tests/fixtures and generated code;
- tasks/build/release/deployment/docs;
- patches and vendored source.

Local use can reveal an ecosystem package absent from current docs, but it does
not establish that the relationship remains supported upstream.

### 3. Inspect canonical project surfaces

Search exact-version source first, then current:

- repository workspace/package directories and manifests;
- root README/docs navigation/API/package index;
- examples, starters, templates, recipes, integrations;
- package exports, peers, optional dependencies, plugin registries;
- changelog/release/deprecation/migration notes;
- CI matrices and tests connecting packages;
- ownership/maintainer/security policy.

### 4. Inspect organization and registry carefully

Organization repositories, scopes, keywords, download pages, and search results
generate candidates only. Confirm each relationship through canonical docs,
source edges, maintenance, or a specification. Do not mark every `@scope/*`
package a companion.

### 5. Expand only decision-changing edges

Follow an edge when it owns a required capability, adapts a selected owner to the
repository's host, changes version/security/deployment risk, or is a plausible
alternative. Do not recursively inventory the entire ecosystem.

## Relationship taxonomy

Assign one primary label and evidence/status to each edge.

| Label | Required evidence | Inclusion implication |
|---|---|---|
| Workspace sibling | same verified workspace/revision and package manifest | candidate only; inspect capability |
| First-party repository sibling | same owner plus explicit project relationship | candidate only |
| Official adapter/driver/plugin | canonical docs/index and maintained compatibility | include if host/capability requires |
| Optional integration | peer/optional/source edge with conditional behavior | include only with feature and fallback policy |
| Implements specification | named/versioned contract and conformance evidence | verify optional behavior separately |
| Generates | one node deterministically produces another | generator/source ownership required |
| Publishes | source/build maps to registry artifact | artifact/version integrity required |
| Alternative/replacement | overlapping ownership scope | choose; do not stack silently |
| Community integration | third party, no first-party support promise | higher verification/maintenance burden |
| Experimental | explicitly unstable/prerelease/research | isolate and version-pin |
| Deprecated/superseded | canonical deprecation/migration evidence | avoid new adoption; plan migration |
| Incidental adjacency | name/domain/org similarity only | exclude |
| Unresolved | insufficient identity/relationship evidence | no API or support claim |

Edges can be asymmetric. A community adapter may support an upstream package
without upstream support. One repository can list an example without committing
to the example library's versions. Record direction and source.

## Monorepo package discovery

Do not assume the root manifest lists the public packages or that directory names
equal published names.

1. Find actual workspace config (`package.json`, `pnpm-workspace.yaml`,
   `deno.json`, Cargo/Go/Python equivalents, custom generation).
2. Expand workspace globs with exclusions; detect missing/ignored/nested roots.
3. Read every material package manifest: name, version strategy, private flag,
   exports/bin/files, peers/optional/runtime dependencies, engines, publish config.
4. Map internal dependency and peer edges plus package categories.
5. Inspect root docs/integration index and per-package tests/examples.
6. Identify generated packages, compatibility shims, deprecated packages, and
   packages not published despite living in the workspace.
7. Record versioning/release policy: lockstep, independent, canary, prerelease.

Common capability splits:

```text
core protocol/types
  -> runtime implementation
  -> framework bindings
  -> platform/driver adapters
  -> configuration/loaders
  -> observability/testing
  -> build/devtools
```

Inspect public exports. A package named `core` may contain runner/discovery
features; a directory named `adapter` may be internal. Names are hints.

## Multi-repository ecosystem discovery

UnJS demonstrates a cohesive multi-repository ecosystem. Its package index and
cross-dependencies connect focused tools, but each package owns a narrow concern:

- c12 discovers/resolves config layers;
- defu supplies defaults-oriented merge primitives;
- jiti loads/transforms modules at runtime and executes code;
- rc9 owns user RC persistence;
- std-env reports runtime/CI/TTY/provider signals;
- ofetch owns an HTTP client adapter;
- unstorage owns portable key/value storage drivers;
- pkg-types inspects package/workspace metadata and exports;
- nypm detects/operates through project package managers;
- unbuild builds libraries; changelogen assists release notes/version actions;
- Automd owns bounded generated Markdown; Giget acquires templates; Magicast
  edits supported static-ish JS/TS shapes.

They can work together because capability ownership aligns, not because all
come from UnJS. Select by required owner. For example, using c12 does not require
unbuild or unstorage. Citty and Optique normally compete for command grammar;
they are not companions merely because Citty is used by other UnJS tools.

For a multi-repository ecosystem, record package-level versions independently.
The same attached codebase can resolve c12 stable 3.x while research also finds
4.x beta; do not assign the beta's combined capability to stable.

## Specification and framework ecosystems

A specification edge is narrower than a package-family edge. Standard Schema can
let consumers validate with Zod, Valibot, or other conforming libraries through
a minimal interface. It does not guarantee enum introspection, JSON Schema,
labels, transformations, codecs, completion choices, or identical error shapes.
Build a required/optional conformance table and test the exact implementations.

Framework ecosystems require host dimensions:

```text
framework version x renderer x server adapter x bundler x runtime x deployment
```

An icon loader's Astro integration and its React/Solid compiler can have different
imports, SSR output, styling, and bundler hooks. A database ORM's PostgreSQL
dialect cannot be inferred to support ClickHouse because SQL methods look alike.
A Better Auth plugin may require both server and client registration and an
adapter/schema migration. Map exact peer ranges and integration tests.

Official examples are topology evidence, not universal compatibility proof.

## Private, personal, and generated ecosystems

For packages from `okikio/utils` (see `use-utils`), standalone Okikio libraries
(see `use-okikio`), custom adapters or unpublished packages:

- search consuming workspaces, lockfiles, local registries, import maps, source
  directories, docs, tests, and package metadata;
- distinguish exact spelling and version (`observables` versus a remembered
  misspelling);
- inspect actual exports and maturity; do not fill gaps from a similar public API;
- record unavailable source as unresolved and provide the next required path;
- never publish or expose private implementation details just to complete a map.

Generated clients/schemas/packages have two identities: generator/source schema
and generated artifact. Connect both. A generated API client's version may not
match the service version; capture protocol/schema compatibility.

Duplicate archives or mirrors require content comparison. Same paths/digests
mean one evidence body with multiple archive identities, not two evolutionary
stages. Forks require base revision plus patch set and update policy.

## Capability graph and ownership map

Prefer a table for review and a graph only when topology is genuinely complex.

```text
required capability
  -> current owner
  -> candidate node
  -> relationship status
  -> version/host compatibility
  -> include/exclude/unresolved
  -> verification
```

Each selected capability needs one canonical owner. Companions connect different
owners; alternatives overlap. Explicit examples:

- Optique owns grammar, LogTape owns output transport, `@optique/logtape`
  connects verbosity/configuration: companion.
- LogTape and another process-wide logger both owning diagnostics: alternative
  unless one is a bounded bridge.
- PostgreSQL owns transactional state, ClickHouse owns analytical projections:
  companion with a delivery/reconciliation contract.
- Two ORMs both writing the same schema/migrations: duplicate authority.

Include connected systems: build, generated code, package manager, CI, runtime,
data store, service, authentication, observability, deployment, and docs.

## Stopping and completeness

Topology is sufficiently complete when:

- the required capability path has no unexplained gap;
- each selected edge has primary evidence and version/status;
- likely official adapters/siblings for the actual host were inspected;
- overlapping alternatives and plausible exclusions are recorded;
- unresolved nodes cannot be included without more source;
- expanding more nodes would not change ownership, risk, or verification.

Report coverage, not omniscience: "inspected workspace packages, official
integration index, export/peer edges, and current releases; did not enumerate
unrelated organization repositories."

## Failure signatures

| Signature | Likely topology error | Next evidence |
|---|---|---|
| Core looks too small for docs | capability in sibling/adapter | workspace, exports, integration index |
| Package exists in scope but is private | workspace mistaken for publication | manifest/private/publish workflow |
| Community project called official | ownership edge collapsed | canonical docs/maintainer policy |
| Same org treated as required stack | adjacency treated as capability | owner table and dependency edges |
| React example proposed for Solid | framework binding dimension omitted | peer ranges, compiler/renderer docs |
| Similar dialect API proposed | structural resemblance treated as support | dialect/driver source and generated SQL |
| All UnJS packages recommended | ecosystem discovery confused with selection | material capability path |
| Private package API invented | unresolved node promoted | consuming source/export evidence |
| Two archives yield fake chronology | names used instead of hashes | normalized content comparison |
| Graph is huge but decision unclear | unbounded recursive discovery | stopping rule and decision-changing edges |

## Sources and freshness

- Current UnJS package index and pinned published source records for c12, defu,
  jiti, Unbuild, Pkg-types, Automd, Changelogen, Giget, Magicast and related
  focused packages; verified 2026-07-17.
- Current Optique and LogTape official full documentation, observed package-family
  and integration separation; verified 2026-07-17.
- Retained uploaded monorepos/codebases and source registry, observed package,
  framework, private/personal, duplicate-archive, generated and stale-contract
  topologies; verified 2026-07-17.

Organization membership and mutable package indexes are discovery surfaces.
Recheck exact versions, maintainers, package manifests, and current integration
status before making an implementation decision.
