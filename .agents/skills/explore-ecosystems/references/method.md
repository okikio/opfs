# Ecosystem investigation method

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [The ecosystem hypothesis](#the-ecosystem-hypothesis)
- [Plan at three levels](#plan-at-three-levels)
- [Phase 1: frame the decision](#phase-1-frame-the-decision)
- [Phase 2: establish identity and installed truth](#phase-2-establish-identity-and-installed-truth)
- [Phase 3: map topology and capabilities](#phase-3-map-topology-and-capabilities)
- [Phase 4: inspect behavior and operations](#phase-4-inspect-behavior-and-operations)
- [Phase 5: select and prove](#phase-5-select-and-prove)
- [Investigation worksheet](#investigation-worksheet)
- [Stopping rules](#stopping-rules)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference whenever a package, framework, service, tool, database,
protocol, or remembered project materially affects architecture or implementation.
Material means it can change public contracts, capability ownership, security,
data, deployment, build/package output, runtime support, operations, or migration.
Do not run this full investigation for an incidental leaf dependency that the
task does not touch.

## Outcome

Reach a decision-complete, claim-level evidence record. Another engineer should
be able to answer:

- what exact thing was investigated at what version/revision;
- whether it is standalone, a monorepo, a multi-repository ecosystem, a
  specification ecosystem, or unresolved;
- which sibling packages, adapters, plugins, presets, templates, integrations,
  and alternatives were considered;
- which capability each selected component owns and what remains excluded;
- how installed truth differs from current documentation/releases;
- configuration, runtime, generated, security, data, packaging, deployment,
  failure, migration, and rollback consequences;
- which statements were observed, documented, inferred, or unresolved;
- what executable verification ran and what remains blocked.

The output is not a package catalog. It is a capability and ownership decision.

## The ecosystem hypothesis

Start every material dependency as if the named package may be only one visible
node in a larger system. Search for:

- workspace siblings split by core, runtime, framework, adapter, driver, plugin,
  testing, configuration, UI, build, docs, or deployment concern;
- first-party sibling repositories and official integration indexes;
- protocol/specification peers that interoperate across owners;
- examples/starters/templates that reveal intended composition;
- optional and peer dependencies that expose adapters;
- related personal/private packages visible only in consuming repositories.

This is a mandatory investigation hypothesis, not permission to assert that
every dependency is literally a monorepo or that every sibling belongs in the
solution. After searching, classify the actual topology and record exclusions.

Examples:

- LogTape is a package family: core transport, pretty/file/redaction/testing and
  integrations have distinct roles. Selecting only the core may miss required
  result routing or tests; installing every adapter creates duplicate ownership.
- Optique separates parser core, runners/discovery, config/env/default sources,
  schema integrations, completion, man output, and LogTape integration. A task
  concerning completions cannot be decided from one parser package README.
- UnJS is intentionally multi-repository. c12, defu, jiti, rc9, std-env, ofetch,
  unstorage, pkg-types, nypm, unbuild, changelogen, Automd, Giget, Magicast, and
  others can compose, but brand membership is not an inclusion reason.
- Standard Schema is a specification ecosystem: implementations may interoperate
  through a minimal contract while optional metadata remains library-specific.
- A standalone package may have no meaningful ecosystem. That is a valid result
  after discovery, not a reason to invent relationships.

## Plan at three levels

Keep three synchronized plans so breadth does not erase the task.

### Decision plan

State the user/repository decision, deadline, reversibility, required confidence,
and acceptance criteria. Example: "Choose the configuration owner for one CLI;
preserve current precedence and provenance; no publication in this task."

### Capability plan

List capabilities and connected surfaces before naming packages:

```text
config discovery -> layer provenance -> merge algebra -> schema validation
  -> runtime object -> config inspection -> watcher/reload -> package/deploy
```

Assign current owner, candidate owner, risk, evidence needed, and verification.
This reveals missing siblings without creating a shopping list.

### Evidence plan

For each decision-changing claim identify the preferred source and fallback:

```text
installed export -> lock/source/tests at revision -> published artifact
  -> versioned official docs/release notes -> issue/discussion -> unresolved
```

Keep independent unknowns visible. Do not wait to write one monolithic summary;
update the claim ledger as evidence arrives.

## Phase 1: frame the decision

Write:

- requested outcome and authorization mode (research, recommend, implement);
- repository/runtime/package-manager/workspace context;
- current owners and observed problem/failure;
- hard requirements and non-goals;
- security/data/public compatibility constraints;
- target versions/hosts or the evidence needed to choose them;
- required verification and rollback.

Search the repository first. Existing imports, wrappers, task names, lockfiles,
patches, generated files, tests, adapter modules, comments, deployment code, and
local guides are stronger context than an internet recommendation. Do not replace
a mature wrapper because an upstream package has a similar API; establish which
policy the wrapper owns.

Define materiality. Investigate direct owners, sibling adapters needed by the
capability path, and alternatives that could replace those owners. Stop chasing
transitive utility packages unless they change the decision, risk, or failure.

## Phase 2: establish identity and installed truth

Names are ambiguous. Resolve:

| Field | Evidence |
|---|---|
| Import/package name | source import plus owning manifest/lock entry |
| Registry and version | lockfile/resolution metadata, not range alone |
| Repository/owner | package metadata and canonical project links |
| Workspace package path | root workspace declarations and package manifest |
| Artifact integrity | registry integrity/digest or revision |
| Runtime/host/platform | manifest engines/peers plus source/tests |
| License/maturity | packaged license, releases/status, not badge alone |

Inspect exact installed exports and source before current docs. Then inspect
current stable/prerelease lines and release notes to learn migration/deprecation.
Write the interface: "repository resolves c12 3.3.4; source record also examined
4.0.0-beta.5 for future capability; beta APIs are not available to current
code." Never merge versions into a fictional superset API.

For a private, personal, forked, patched, vendored, generated, or unpublished
package, record the source path/revision and lower confidence. User memory is a
discovery lead, not an import API. A repository named after a product may not
contain every implied package; search manifests/entrypoints.

## Phase 3: map topology and capabilities

Use [topology.md](topology.md) for the discovery algorithm. Produce a bounded
node/edge ledger:

| Node | Relationship | Capability | Version/status | Evidence | Decision |
|---|---|---|---|---|---|
| core | workspace sibling | command grammar | stable installed | exports/tests | include |
| log adapter | official integration | verbosity mapping | stable compatible | official index | include |
| React binding | official adapter | React renderer | stable | peer deps | exclude: Solid host |
| experimental store | community | persistence | prerelease | repo only | exclude |

Edges need semantics: depends on, adapts, implements spec, alternative to,
generates, publishes, consumes, or merely related. Organization membership is
not a semantic edge.

Build a capability owner table. Split packages only where their concerns differ.
For a CLI, Optique can own command grammar while LogTape owns output transport,
c12 owns discovery/layers, defu/custom merge owns fallback algebra, Zod owns the
application schema, and Standard Schema owns an interoperability contract. If
two tools own the same concern, select one or write an explicit composition rule.

## Phase 4: inspect behavior and operations

For each selected candidate inspect the complete lifecycle:

1. public exports/types and minimal usage;
2. configuration shapes, defaults, precedence, environment, and provenance;
3. runtime behavior, concurrency, lifecycle/disposal, errors, retries, timeout,
   cancellation, and recovery;
4. framework/runtime/driver adapters and exact version and peer ranges;
5. security/trust/secrets/permissions and supply-chain concerns;
6. persistence/schema/migration/data authority where applicable;
7. build/bundle/tree-shaking/generated/package/publication behavior;
8. tests/examples that cover real integrations and failure cases;
9. upgrade/downgrade/rollback and deprecated/experimental surfaces;
10. cost: dependencies, binaries, services, latency, memory, operations, context.

Read implementation and tests where documentation is incomplete or a claim is
fragile. Do not generalize an example beyond its host: a React adapter is not a
Solid adapter, a PostgreSQL dialect is not ClickHouse, Node compatibility is not
edge support, and matching TypeScript shapes are not behavioral interoperability.

Create a failure table before integration. If you cannot say what an adapter
does when unavailable, misconfigured, incompatible, cancelled, or partially
successful, research is not decision-complete.

## Phase 5: select and prove

Use [selection.md](selection.md) to assign owners and [integration.md](integration.md)
to implement/verify. A recommendation must include:

- chosen version/components and exact roles;
- rejected plausible siblings/alternatives and reasons;
- config/runtime/generated/deploy migration sequence;
- compatibility and rollback point;
- minimal proof and real connected workflow;
- unresolved claims and evidence needed next.

Prefer a small spike in an isolated fixture when documentation cannot establish
behavior. Install exact versions, assert types and observable behavior, test one
failure, remove the fixture afterward or retain it as an eval. Do not turn a
research spike into an unreviewed production dependency.

## Investigation worksheet

```text
Decision
  task/outcome:
  current owner/problem:
  constraints/non-goals:
  authorization/reversibility:

Identity
  exact package/import/product/protocol:
  installed version/revision/integrity:
  canonical owner/repository/license/status:
  current stable/prerelease range:

Topology
  actual topology classification:
  workspace siblings:
  repository siblings:
  official adapters/plugins/presets:
  specification peers:
  community/experimental/alternatives:

Capability ownership
  required capability -> current owner -> candidate -> decision -> evidence:
  duplicate-owner resolution:
  exclusions:

Operations
  config/defaults/provenance:
  runtime/lifecycle/errors/recovery:
  security/secrets/permissions:
  data/migrations:
  build/package/deploy:
  upgrade/rollback:

Proof
  exact sources and status:
  executable checks:
  connected workflow:
  unresolved/blocked:
  freshness date:
```

## Stopping rules

Stop when all decision-changing capabilities have one owner, every selected
relationship has evidence, material compatibility/failure/operational risks have
a test or explicit unknown, plausible alternatives/exclusions are recorded, and
the verification plan can accept or reject the integration.

Also stop and report uncertainty when:

- identity or source cannot be established;
- installed artifact/source is unavailable;
- only mutable/current docs exist for an older installed version;
- an adapter is private/experimental and lacks observable contract tests;
- credentials/hardware/production authority are required;
- further siblings are incidental and cannot change the decision.

Do not stop merely after finding a familiar package, a working import, an official
example, or a long list. Do not continue until every organization repository has
been read.

## Failure signatures

| Signature | Method defect | Correction |
|---|---|---|
| Only the named package appears | ecosystem hypothesis skipped | inspect workspace/org/integration/export surfaces |
| Dozens of siblings recommended | topology confused with inclusion | capability owner and exclusion test |
| API combines old stable and beta | installed/current truth collapsed | versioned claim ledger |
| Familiar package replaces local wrapper | repository ownership ignored | inspect wrapper policy/tests/consumers |
| Research never ends | no materiality or stopping rule | restate decision and evidence gaps |
| Example copied but host differs | integration context generalized | version/renderer/runtime matrix |
| "Official" community adapter | relationship status unverified | canonical integration/maintainer evidence |
| Types accepted, behavior failed | structural typing treated as contract | executable connected workflow |
| Private API invented from memory | discovery lead treated as source | locate code/export or mark unresolved |
| Long report has no decision | information not mapped to capability | owner table, selection, proof |

## Deliberate exclusions

- Do not research every dependency in the lockfile.
- Do not assume monorepo literal topology or manufacture an ecosystem.
- Do not install every sibling, adapter, or UnJS package discovered.
- Do not equate same organization, maintainer, naming, or API resemblance with
  compatibility or official support.
- Do not copy current documentation into an older installed version.
- Do not call an inferred/private/experimental surface stable.
- Do not mutate production or publish merely to test an ecosystem decision.

## Sources and freshness

- Attached production CLI guidebook v1.1 and CLI audit, normative examples of
  capability-owner composition across Optique, LogTape, c12, defu, schema,
  prompts, and selective UnJS adapters; verified 2026-07-13.
- Retained uploaded codebases, observed monorepo, multi-package, duplicate
  archive, private/personal, generated, adapter, and stale-doc counterexamples;
  source registry verified 2026-07-17.
- Current pinned source records for Optique, LogTape, c12/defu/jiti, UnJS,
  Effect/Temporal, ClickHouse/Drizzle, Astro icons/fonts, Better Auth, Solid
  Primitives, and Okikio packages; verified 2026-07-17.

Use those records as examples of claim discipline. Recheck mutable official docs,
installed versions, and registry artifacts at the time of a new decision.
