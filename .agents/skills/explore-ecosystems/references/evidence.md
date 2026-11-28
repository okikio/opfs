# Evidence, versions, and provenance

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Evidence strength is claim-specific](#evidence-strength-is-claim-specific)
- [Installed, source, published, and current truth](#installed-source-published-and-current-truth)
- [Claim ledger](#claim-ledger)
- [Source acquisition and integrity](#source-acquisition-and-integrity)
- [Proving relationships and support](#proving-relationships-and-support)
- [Negative evidence and contradictions](#negative-evidence-and-contradictions)
- [Executable evidence](#executable-evidence)
- [Freshness and change control](#freshness-and-change-control)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference for every ecosystem investigation and whenever a decision
depends on version-sensitive, experimental, private, generated, remote, negative,
or conflicting claims. It defines how to prevent a detailed skill or report from
becoming a detailed hallucination.

## Outcome

Every decision-changing statement has a source, exact identity/version where
relevant, status, freshness date, and verification level. Contradictions remain
visible until resolved. The report never combines facts from incompatible
versions or promotes inference to observed behavior.

## Evidence strength is claim-specific

Use the strongest evidence that actually proves the claim.

| Claim | Strong evidence | Common insufficient evidence |
|---|---|---|
| Repository resolves package version | lockfile/resolver output | manifest range, current website |
| Public export exists | exact published artifact/export map plus import | README example alone |
| Runtime behavior | source/tests and executable exact-version check | types or similar API |
| Adapter is official | canonical project integration index/maintainer ownership | same org/name/search result |
| Runtime/renderer support | peer/engine metadata plus CI/integration test | generic TypeScript compatibility |
| Configuration precedence | exact version implementation/tests/docs | one config example |
| Package is published | registry artifact and metadata | workspace directory |
| Feature absent | exhaustive relevant exports/source/artifact search | no README mention |
| Performance improvement | controlled raw experiment | anecdote/one fastest sample |
| Archive evolution | normalized content/revision diff | filenames such as old/new |
| Reproducible release | source/input/tool provenance plus matching rebuild | CI success/attestation alone |

Repository-local evidence is strongest for what this repository currently does.
Official current docs are strongest for current intended usage. Neither replaces
the other; write the interface.

## Installed, source, published, and current truth

Separate four views:

```text
declared truth   = manifest ranges/configuration intent
resolved truth   = lockfile/artifact actually selected
source truth     = code/tests at exact revision
published truth  = files/metadata consumers receive
current truth    = latest stable/prerelease docs and releases
```

They can disagree legitimately or reveal a defect. Example:

```text
repository range: ^3.3.0
resolved c12: 3.3.4
current research artifact: 4.0.0-beta.5

Decision: use 3.3.4 API/behavior for implementation; discuss beta only as a
future migration/status item. Never copy beta source-layer or optional-format
behavior into a stable 3.x claim without exact evidence.
```

Inspect patches, overrides, forks, vendored code, workspace aliases, prereleases,
generated clients, and platform-specific optional packages. The lock entry may
resolve a wrapper whose behavior differs from upstream. A package's docs branch
may track main rather than the installed release.

For artifacts, inspect the archive, not only repository source. Files can be
excluded, generated differently, or mapped through export conditions. The
Wikitext archive's documentation/export discrepancy is a useful negative case:
documentation can advertise an API not implemented/exported in the supplied
revision.

## Claim ledger

Use a structured record rather than a references list at the end.

```json
{
  "claim": "The package exports a browser-safe parser entrypoint",
  "identity": "package@1.2.3",
  "source": "registry tarball package.json + clean browser import",
  "sourceRevision": "sha256:...",
  "observedAt": "2026-07-17",
  "status": "executable",
  "scope": "ESM browser bundle only; filesystem helpers excluded",
  "decision": "use ./core in worker adapter",
  "unresolved": []
}
```

Allowed status vocabulary should be small and defined. This repository uses:

- `normative`: desired contract from a guide/policy, not implementation proof;
- `observed-source`: exact source/docs/artifact inspected;
- `executable`: behavior ran with recorded command/result;
- `experimental`: prerelease/research/unstable evidence;
- `counterexample`: evidence that disproves or limits a broad claim;
- `inferred`: reasoning from evidence, not directly observed;
- `unresolved`: identity/behavior/support not established.

One source can support several claims, but each claim must point to the relevant
path/section/export/test. A repository root URL does not prove package identity,
adapter status, configuration semantics, and host support simultaneously.

Record decision impact. This makes stale claims reviewable: if an upstream
version changes, only dependent decisions need re-evaluation.

## Source acquisition and integrity

For uploaded/local archives:

- record original artifact name, byte digest, extraction root, and archive
  integrity result;
- prevent path traversal/symlink escape during extraction;
- preserve original artifact; analyze a read-only/extracted copy;
- compare duplicate candidates by normalized relative paths/content hashes;
- record claim paths, not just archive name;
- do not redistribute source in deliverables unless authorized/licensed.

For registry packages:

- capture exact version, registry URL, integrity/digest, manifest, exports,
  files, license, and relevant declarations/source/tests;
- prefer registry tarball over mutable repository main for published behavior;
- verify package/repository ownership links; beware similarly named packages;
- do not execute lifecycle scripts merely to inspect content.

For Git/source:

- use an exact commit/tag and verify tag/revision relationship where material;
- record submodules/LFS/generated artifacts/patches;
- distinguish default branch, release tag, and installed source;
- preserve line/path references or local evidence extracts.

For web/docs:

- prefer versioned official docs, generated API docs, changelogs, and release
  notes; record URL/date/version;
- mutable `latest` pages require freshness recheck and cannot silently define
  an older installed version;
- search snippets/community posts are discovery leads; follow to primary source.

Do not expose credentials while acquiring private sources. Record access/blocker
status without copying private content into a public source ledger.

## Proving relationships and support

Relationship claims need separate evidence from feature claims.

To call a sibling/adapter official, find at least one canonical maintainer-owned
surface and preferably compatibility tests/release ownership. Same scope,
organization, contributor, or package keyword is insufficient.

To claim compatibility, record exact dimensions:

```text
package A version
  x adapter version
  x framework/renderer version
  x runtime/platform
  x configuration/feature
```

Types can prove structural compatibility at compile time. They do not prove SQL
dialect behavior, runtime globals, serialization, lifecycle, error propagation,
SSR/hydration, browser bundling, native ABI, or service protocol compatibility.
Use source/tests and executable integration.

Examples/starters prove that a combination was intended/tested at their own
revision. Resolve their lockfile and date before treating them as current.

## Negative evidence and contradictions

Absence is an expensive claim. Before saying a feature/export/adapter does not
exist, search:

- public export maps/root/subpaths/bin;
- source modules, generated files, types, tests, examples;
- workspace packages and separate official repositories;
- current and installed release branches/tags;
- integration/plugin indexes and deprecation/migration notes;
- registry artifacts for the exact version.

Phrase bounded conclusions: "No `stringify` export was found in the supplied
Wikitext revision's `mod.ts`, source modules, tests, or package config, despite
README language" is supportable. "Wikitext has never supported stringify" is
not proven.

Do not average contradictions away. Record:

| Claim | Source A | Source B | Resolution |
|---|---|---|---|
| Export exists | README | published export map lacks it | contract discrepancy; do not use |
| Archives are old/new | filenames | identical normalized hashes | no evolution evidence |
| Adapter supports host | types compile | integration fails | unsupported/unresolved runtime behavior |

Normative guides describe what software should do. Code proves what the inspected
revision does. A guidebook's detailed desired architecture cannot be presented
as already implemented without source/tests.

## Executable evidence

Prefer the smallest check that distinguishes the claim from plausible alternatives:

- clean import for public export/package contents;
- type matrix for declaration/resolver claims;
- config fixture for precedence/merge/provenance;
- generated SQL/protocol trace for dialect/driver behavior;
- SSR/client build for renderer integration;
- failure/cancellation/disposal test for lifecycle;
- clean pack/install for packaging;
- raw controlled benchmark for performance;
- check/write/check/hash for generation.

Record command, cwd/fixture, exact versions, environment, exit, stdout/stderr
summary, produced artifact/digest, and whether the result was observed or blocked.
A blocked registry/credential/hardware check stays blocked; it does not become
documented success.

A smoke test proves only its path. Pair with source/contract inspection for
unexercised options and failure modes. Do not use a mock to claim a real service,
driver, registry, or cross-platform workflow passed.

## Freshness and change control

Set freshness based on volatility:

- exact archived artifact/revision: stable for that identity;
- registry version: stable artifact, mutable deprecation/channel metadata;
- current docs/package index: recheck at decision time;
- prerelease/alpha: pin and recheck exports frequently;
- service API/pricing/quota/deployment support: recheck immediately;
- user memory/private source: unresolved until located.

When refreshing, do not overwrite old claim records invisibly. Record prior/new
version, changed claim, affected decisions, migration, and verification. Preserve
source digests and evaluation fixtures for released skill guidance.

Skill references should state version lines and source status near fragile
examples. Avoid exact API code for an unresolved/private surface; provide a
protocol/interface placeholder labelled local and require source inspection.

## Failure signatures

| Signature | Evidence defect | Next inspection |
|---|---|---|
| Detailed API is not in installed package | versions merged or invented | lock, tarball exports/source |
| Root GitHub URL cited for every claim | provenance too coarse | package/path/test-level records |
| README says yes, runtime says no | docs/artifact contradiction | published exports and executable test |
| Missing feature claimed after one search | negative evidence too weak | full public/workspace/integration surfaces |
| "Official" based on scope/name | relationship unproven | canonical index/maintainer/release evidence |
| Current docs applied to old lock | installed/current truth collapsed | versioned docs/tag source |
| Similar archives described as versions | identity names trusted | normalized hashes/diffs |
| Attestation treated as correctness | provenance scope misunderstood | behavior/semver/consumer gates |
| Mock result presented as integration | evidence level inflated | real connected check or blocked status |
| Private package gets plausible imports | memory promoted to API | consuming source/exports or unresolved |

## Deliberate exclusions

- Do not cite search result snippets as implementation evidence.
- Do not execute untrusted packages or lifecycle scripts to inspect metadata.
- Do not combine stable and prerelease capabilities into one API.
- Do not label inference, normative policy, mock behavior, or type compatibility
  as observed runtime behavior.
- Do not claim universal absence from a bounded search.
- Do not copy private source/credentials into public reports or skill bundles.
- Do not provide a long bibliography without claim-level mapping.

## Sources and freshness

- `evals/sources.json` in this repository, source identity/status/digest/claim
  path registry for all retained uploads and current primary sources; validated
  against 16 distinct uploaded artifacts on 2026-07-17.
- Two retained duplicate application archives and Wikitext
  documentation/export discrepancy, observed counterexamples to name- and
  README-based inference; verified 2026-07-17.
- Pinned registry source records for current deep package references, including
  exact integrities and explicit prerelease ranges; verified 2026-07-17.

Re-run source verification and exact-version inspection when the source registry,
installed graph, or upstream release changes.
