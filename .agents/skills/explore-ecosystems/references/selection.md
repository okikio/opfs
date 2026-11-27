# Capability ownership and ecosystem selection

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Select capabilities before packages](#select-capabilities-before-packages)
- [Owner, companion, adapter, and alternative](#owner-companion-adapter-and-alternative)
- [Decision model](#decision-model)
- [Version, maturity, and portability](#version-maturity-and-portability)
- [Operational and supply-chain cost](#operational-and-supply-chain-cost)
- [Migration and reversibility](#migration-and-reversibility)
- [Worked ecosystem selections](#worked-ecosystem-selections)
- [Exclusion records](#exclusion-records)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Verification](#verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference after identity/topology evidence exists and before adding,
removing, replacing, or recommending ecosystem components. It is required when
several sibling packages look useful, two tools overlap, or the implementation
already has an owner for the concern.

## Outcome

Choose the smallest coherent set of exact components that covers required
capabilities with one canonical owner per concern, explicit adapter APIs,
understood operations, and executable proof. Record plausible exclusions so
future agents do not rediscover and install them reflexively.

## Select capabilities before packages

Start with observable needs:

```text
Need: typed command grammar, generated help/completion/man
Need: stable stdout results and structured diagnostics
Need: authored/project/user config with provenance and array policy
Need: package build, registry artifact, clean consumer
```

Then map ownership:

| Capability | Current owner | Candidate | Gap/overlap | Decision evidence |
|---|---|---|---|---|
| command grammar | hand parser | Optique | replacement | grammar/help/completion tests |
| output transport | LogTape | another logger | duplicate | keep LogTape |
| config discovery/layers | c12 | c12 | none | retain |
| config merge algebra | generic defu | custom c12 merger | partial | explicit arrays/provenance tests |
| package build | dnt | unbuild | target-dependent | Deno-to-Node output contract |

Do not let package availability redefine the task. A sibling may have excellent
capabilities that are unnecessary here.

## Owner, companion, adapter, and alternative

Use these roles consistently:

- **Owner:** canonical source of behavior/policy for one concern.
- **Companion:** owns a different required concern and composes through a documented
  interface.
- **Adapter:** translates between owners/hosts without becoming an independent
  policy source.
- **Alternative:** could own the same concern instead; normally choose one.
- **Optional extension:** adds a non-required feature behind an explicit enable,
  capability check, lifecycle, and fallback.
- **Source/generator:** produces another selected node; needs provenance.
- **Incidental dependency:** implementation detail, not application architecture.

Examples:

- Optique and LogTape are companions; `@optique/logtape` is their adapter.
- Optique and Citty are command-grammar alternatives for most applications.
- Zod can own application schemas while Standard Schema is an interoperability
  contract. Standard Schema does not replace optional Zod metadata automatically.
- c12 owns layer loading; defu/custom merger implements merge mechanics. Neither
  should apply application defaults a second time after final validation.
- PostgreSQL and ClickHouse can be transactional owner plus analytical projection,
  provided delivery/reconciliation is explicit. They are not interchangeable.
- Astro and Solid can be page-rendering owner plus interactive-island owner;
  renderer-specific packages remain in their host.

If two selected nodes both configure/log/cache/migrate/persist the same concern,
write an ordering/authority rule or remove one. Bridges should not create a
third configuration source.

## Decision model

Score only after hard constraints pass. A weighted score cannot compensate for
wrong runtime, incompatible license, absent required capability, or unverified
identity.

### Hard gates

1. Exact identity/source and selected version are established.
2. Required capability is actually present in that version/artifact.
3. Runtime, framework/renderer, driver/dialect, platform, and license fit.
4. Security/data/deployment constraints can be met.
5. The component does not create an unresolved second authority.
6. Integration/failure/rollback can be verified.

### Comparative dimensions

| Dimension | Questions |
|---|---|
| Capability fit | Does it cover the full required behavior and failures? |
| Existing fit | Does it compose with current owners/wrappers/conventions? |
| Maturity | Stable, prerelease, experimental; release/maintenance evidence? |
| Portability | Runtime/platform/renderer/bundler/service coupling? |
| Operational cost | service, storage, binaries, credentials, observability, recovery? |
| Supply chain | dependency graph, install scripts, integrity, update owner? |
| Migration | data/config/API/public compatibility and rollback? |
| Verification | Can real behavior be tested locally/CI/staging? |
| Context cost | Will instructions/reference loading be proportionate? |

Write decisive evidence beside each score. Avoid false precision such as 8.3/10
when unknown behavior dominates.

### Inclusion rule

Include when a required capability has no adequate owner, identity and
relationship are verified, compatibility/operations are acceptable, integration
is testable, and ownership stays coherent. Retain an existing adequate owner
unless replacement has material benefit that exceeds migration/risk.

## Version, maturity, and portability

Select an exact version line, not a timeless package name. Record installed,
target, latest stable, and relevant prerelease separately. Do not use beta docs
for stable code.

For prerelease/experimental packages:

- pin exact version/integrity;
- isolate behind a local interface/adapter;
- avoid making its data format or API an irreversible public contract;
- add export and behavior fixtures that fail on upgrade;
- define removal/fallback and upgrade owner;
- report status near examples.

Portability claims require host matrices. A library that uses Web APIs may still
depend on Node package resolution or filesystem. A typed ORM adapter may still
emit unsupported SQL. A framework plugin may support Vite but not the selected
SSR adapter. Test exact combinations.

## Operational and supply-chain cost

Selection includes lifecycle, not only code ergonomics:

- additional service/account/region/quota/cost and availability;
- schema/migration/backup/restore/reconciliation;
- secrets, permissions, network hosts, filesystem and subprocesses;
- binary/native install and supported targets;
- logging/metrics/tracing/diagnostics and redaction;
- retries/timeouts/cancellation/backpressure/disposal;
- update/deprecation/security response and maintainer capacity;
- build/package size, startup/memory/performance;
- license/notices and transitive/lifecycle-script exposure.

Prefer existing ecosystem components when they reduce duplicated policy, but
do not add a dependency for a trivial stable operation. A new abstraction that
only renames an upstream API increases ownership without isolation value.

## Migration and reversibility

Separate adoption phases:

1. prove in isolated fixture/spike;
2. introduce local adapter/adapter and compatibility tests;
3. dual-read/compare only when data migration requires it and authority is clear;
4. move one capability owner at a time;
5. verify connected consumers/deployment;
6. remove compatibility path after proven cutover;
7. retain rollback data/config/artifacts for the declared window.

Avoid dual-write authority by default. If both systems must run, name the primary,
replication direction, idempotency, failure/reconciliation, and cutover condition.
For package-manager or lockfile trials, keep one authoritative lock until a
separate cutover.

## Worked ecosystem selections

### Production CLI

Required: typed structural grammar, source-aware config, stable output transport,
schema validation, package build.

Selection:

- Optique packages needed for grammar/runner/help/completion/man and exact schema
  integration;
- LogTape core plus only needed pretty/file/redaction/testing sinks/adapters;
- c12 for project/user/package/environment/extends layers; custom merger using
  defu only where defaults semantics match, with explicit array operations;
- Zod as application schema; Standard Schema only at library interoperability;
- dnt for a Deno-source Node artifact when its transform matches, or unbuild for
  a Node library build. Do not layer both over the same output without purpose.

Exclusions: Citty as duplicate grammar owner; `@logtape/config` when c12/application
schema already owns config; every UnJS utility not on the capability path; remote
presets by default when installed versioned packages are safer.

### Durable work

Required: resumable orchestration, durable state, external side effects, recovery.

Choose among local workflow runtime, `@effect/workflow` experimental line, and
Temporal based on durability authority and deployment. Effect services/Layers
provide typed capability composition but do not by themselves persist workflow
history. `@effect/workflow` is alpha/version-sensitive and must be pinned/isolated.
Temporal introduces a service, deterministic workflow constraints, workers,
activities, versioning, and operations. Do not select both durable engines as
co-equal owners.

### Data and ORM

Required: transactional state plus analytics. Keep PostgreSQL/Drizzle as OLTP
schema/query/migration owner and ClickHouse as projection. A custom Drizzle-like
ClickHouse adapter must be derived from actual driver/dialect/session/query
contracts and ClickHouse semantics; never infer compatibility from API shape.
Exclude a generic SQL adapter that claims no ClickHouse dialect support.

## Exclusion records

For every plausible sibling/alternative record:

```text
Candidate: @logtape/config
Relationship: first-party package
Capability: logging configuration
Decision: exclude
Reason: application config is already owned by c12 + Zod; adding it would create
        two config authorities. Reconsider only if LogTape-specific dynamic
        configuration cannot be expressed through the composition root.
Evidence/version: official LogTape docs, selected package versions, repository config
```

Good reasons: duplicate ownership, no required capability, wrong host/dialect,
unsupported peer/version, experimental maturity, excessive operations/security
cost, license, absent failure/rollback, or existing owner is adequate. "Not
popular" or "did not appear in first search" is not sufficient.

## Failure signatures

| Signature | Selection error | Correction |
|---|---|---|
| Every sibling installed | topology mistaken for selection | required owner/exclusion table |
| Two configs/loggers/ORMs | alternatives stacked | one authority plus adapter/migration |
| Tool chosen for brand consistency | capability fit missing | hard gates and behavior proof |
| Beta API leaks into public contract | maturity/reversibility ignored | pin, isolate, fixture, fallback |
| Types fit but integration fails | portability reduced to types | exact host matrix and behavior |
| New wrapper adds no policy | abstraction without ownership value | use upstream or define a real owned interface |
| Migration needs indefinite dual write | cutover/authority absent | primary, reconciliation, stop condition |
| Alternative score looks precise but evidence missing | false numeric confidence | hard gates/unknowns first |
| Existing mature wrapper discarded | repository ownership ignored | compare policy and migration benefit |
| Selected package cannot be tested | verification gate skipped | spike or keep unresolved/exclude |

## Deliberate exclusions

- Do not maximize package count or ecosystem purity.
- Do not replace an adequate owner for novelty or a nicer isolated API.
- Do not stack alternatives without explicit bounded migration.
- Do not adopt prerelease/private surfaces without pinning, isolation, and exit.
- Do not let a generic score override hard compatibility/security/data gates.
- Do not select a service/library whose required workflow cannot be verified.
- Do not omit exclusion reasoning; absence invites future hallucinated inclusion.

## Verification

1. Validate identity/version/relationship claims against exact source/artifact.
2. Build capability ownership table and assert no unexplained duplicate owners.
3. Run a minimal exact-version spike for required success and failure behavior.
4. Test runtime/renderer/dialect/platform/package/build matrix.
5. Exercise security/lifecycle/disposal/recovery and package/deployment effects.
6. Compare retained baseline/existing owner against candidate behavior and cost.
7. Prove rollback/cutover on a fixture for data/config/public migrations.
8. Review exclusions with triggers for reconsideration.
9. Report blocked checks and experimental/inferred claims without promoting them.

## Sources and freshness

- Attached production CLI guidebook v1.1 and CLI audit, normative owner/adaptor
  decision model and selective ecosystem package map; verified 2026-07-13.
- Current official/pinned Optique, LogTape, c12/defu/UnJS, Effect/Temporal,
  ClickHouse/Drizzle and framework ecosystem records; verified 2026-07-17.
- Retained uploaded implementations, observed existing wrappers, service modules,
  custom adapters, runtime constraints, and counterexamples; verified 2026-07-17.

Re-evaluate selected versions, package status, service operations, and existing
repository ownership at implementation time.
