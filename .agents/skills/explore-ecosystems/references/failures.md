# Ecosystem failure signatures and anti-hallucination recovery

## Contents

- [How to use this reference](#how-to-use-this-reference)
- [Identity and provenance failures](#identity-and-provenance-failures)
- [Topology and selection failures](#topology-and-selection-failures)
- [Version and API failures](#version-and-api-failures)
- [Integration and ownership failures](#integration-and-ownership-failures)
- [Runtime, data, and operational failures](#runtime-data-and-operational-failures)
- [Research-process failures](#research-process-failures)
- [Counterexamples that must remain in the model](#counterexamples-that-must-remain-in-the-model)
- [Recovery protocol](#recovery-protocol)
- [Verification](#verification)
- [Sources and freshness](#sources-and-freshness)

## How to use this reference

Use this table when research or implementation produces a contradiction,
surprising absence, incompatible behavior, or a response that sounds complete
but lacks exact evidence. A signature suggests the next discriminating evidence;
it is not itself a diagnosis.

Anti-hallucination rule:

```text
observe signature
  -> restate the exact bounded claim
  -> list plausible competing explanations
  -> inspect the source/check that distinguishes them
  -> lower status to inferred/unresolved until proven
  -> update selection/integration or stop
```

## Identity and provenance failures

| Signature | Plausible causes | Next discriminating evidence | Unsafe shortcut |
|---|---|---|---|
| Package name cannot be resolved | typo, private package, unpublished workspace, different registry | consuming imports/manifests/lock/local source | invent an npm/JSR API |
| Repository link and package owner differ | fork, transfer, malicious/similar name, stale metadata | registry provenance, canonical docs, release signer | trust name/README badge |
| Two archives called old/new look alike | duplicate exports or repackaging | normalized path/content hashes | narrate evolution from filenames |
| Binary has no source/version | editor download, cache, vendor artifact, malware | file type/digest, installer/config, provenance manifest | execute it for `--version` |
| Current docs have no version selector | mutable main/latest docs | installed tag source, tarball declarations/tests | apply latest to lock version |
| Registry integrity differs from retained artifact | repack, wrong registry, corruption | registry metadata/download/digest/source revision | ignore because version matches |
| Guidebook describes feature absent in code | normative target, partial implementation, stale code | exact source/tests/tasks | say repository already supports it |
| Source exists but published import fails | omitted file/export/build transform | packed artifact/export map/clean import | cite repository path as public API |

## Topology and selection failures

| Signature | Plausible causes | Next discriminating evidence | Unsafe shortcut |
|---|---|---|---|
| Core package appears too small | capability split into siblings/adapters or docs stale | workspace/packages/exports/integration index | invent methods on core |
| Many same-scope packages discovered | package family or incidental organization adjacency | capability/dependency/official relationship map | install all packages |
| Same maintainer or org | first-party sibling or unrelated project | canonical project docs/source edges | call it an official integration |
| Similar names/APIs across packages | alternative, fork, adapter, coincidence | ownership, dependency direction, spec/conformance | treat as drop-in compatible |
| Official example uses another library | supported recipe at one revision, illustrative only | example lock/CI/current integration docs | make it mandatory companion |
| One tool already owns the concern | candidate is alternative or migration target | existing wrapper/config/tests/consumers | stack duplicate owners |
| Agent researches every transitive package | materiality/stopping rule absent | decision-capability path | produce exhaustive org catalog |
| No siblings found | genuinely standalone or discovery incomplete | workspace/org/docs/registry bounded search | manufacture an ecosystem |

## Version and API failures

| Signature | Plausible causes | Next discriminating evidence | Unsafe shortcut |
|---|---|---|---|
| Type/method exists only in docs | beta/newer line or docs bug | exact installed declarations/source/export | copy current example |
| Stable and beta capabilities both appear | versions merged in notes | claim ledger by version | present a superset API |
| Types compile, runtime throws | host/global/module/dialect/lifecycle mismatch | exact runtime integration and emitted trace | call structural typing support |
| Root import works, subpath fails | export omitted/condition mismatch | packed export map and resolver trace | deep-import source path |
| CJS example fails in ESM package | module-system contract | package exports/type and target runtime | add `require` shim blindly |
| Config option ignored | wrong version/source layer/name or loader not active | exact config schema/implementation/effective provenance | assume default applied |
| Optional peer becomes required at runtime | feature path eagerly imported/build bundled | source graph and absence test | add every optional peer |
| Private adapter resembles Drizzle/Effect API | local design inferred from public analogue | actual source/export/tests | invent matching methods |

## Integration and ownership failures

| Signature | Plausible causes | Next discriminating evidence | Unsafe shortcut |
|---|---|---|---|
| Two tools both load config | duplicate authority or unbounded bridge | composition root/effective config provenance | merge outputs implicitly |
| Diagnostics appear twice | logger bridge plus inherited parent sink | category/sink ownership and recorder test | filter duplicate strings |
| JSON stdout has prefixes | diagnostics/result channels collapsed | sink routing/parent inheritance/subprocess bytes | write directly to console |
| Arrays duplicate after layering | generic default concatenation used for operation semantics | custom merge orientation and fixtures | dedupe after merge |
| Framework plugin builds but hydration fails | wrong renderer/SSR/client handoff | exact adapter peer matrix and hydration test | blame app code only |
| Generated config loses comments | value serializer used on authored syntax | AST/format-aware transform and unsupported-shape test | overwrite from parsed object |
| Package works only in workspace | hoist/alias/unpublished file/undeclared dep | packed clean consumer | add root dependency without ownership |
| Upgrade leaves old behavior | old adapter/config/cache/generated artifact still owns path | complete consumer/provenance/removal map | delete random cache |

## Runtime, data, and operational failures

| Signature | Plausible causes | Next discriminating evidence | Unsafe shortcut |
|---|---|---|---|
| Retry duplicates side effect | non-idempotent activity or missing idempotency key | persisted operation/attempt records | increase retries |
| Workflow restarts from beginning | ordinary Effect service mistaken for durable engine | workflow history/checkpoint/store contract | say Effect is automatically durable |
| Temporal workflow nondeterminism | I/O/time/random/library in workflow code | replay test and workflow/activity split | catch retry exception |
| ClickHouse projection differs | delivery gap, mutable aggregate, dedup/order assumption | source-of-truth reconciliation/query semantics | treat it as OLTP backup |
| Drizzle-like ClickHouse adapter emits wrong SQL | relational dialect inferred, AST/session incomplete | generated SQL + ClickHouse integration | rely on query-builder types |
| Auth plugin exists but schema/session fails | one-sided registration/migration/host cookie config | server/client/plugin/adapter matrix | only add client plugin |
| Shutdown loses logs/jobs | async sinks/workers not disposed or deadline too short | lifecycle trace and pending queue | call process exit |
| Offline/cache returns wrong template | cache key omits ref/subdir/integrity | provenance manifest and immutable acquisition | trust `--offline` result |
| Release succeeded in one registry only | per-target state collapsed | target ledger and exact artifact | rerun entire pipeline/rebuild |
| Benchmark microcase wins, users regress | protected workflow/measurement contract absent | E2E, memory, error, stress reports | advertise fastest number |

## Research-process failures

| Signature | Process defect | Correction |
|---|---|---|
| Answer lists package names and slogans | no capability/decision model | owner table, exact versions, failures, proof |
| Large reference has no sources/version | detail not grounded | claim-level provenance and freshness |
| Code example uses plausible unknown API | source status ignored | exact exports or labelled local interface |
| Same guide repeated in many skills | progressive disclosure/ownership failure | one canonical reference, targeted routing |
| Evals accept one keyword | grader shortcut | multi-part decision/behavior assertions |
| Prompt variants differ only by suffix | duplicate smoke cases | distinct interface/failure scenarios |
| Held-out case was visible to optimizer | data leakage | immutable split/export gate |
| Agent reads every reference | routing/selectivity failure | decision-specific required references |
| Blocked command reported passed | evidence status inflation | pass/fail/blocked/not-run report |
| Markdown diff is mostly wrapping | formatter violated reviewability | revert whitespace churn, scope formatting |

## Counterexamples that must remain in the model

### Standalone can be the correct topology

After workspace, canonical docs, export/dependency, integration, and organization
searches, a package may have no meaningful siblings. Record standalone. The
ecosystem hypothesis prevents premature stopping; it does not require a positive
ecosystem claim.

### Brand membership does not imply composition

UnJS packages can compose, but selecting c12 does not require Unbuild, unstorage,
or Citty. Citty can be an alternative to Optique even if other selected UnJS
tools use it internally.

### Minimal interoperability does not imply optional metadata

Standard Schema conformance can expose validation while completion choices,
JSON Schema, transformations, codecs, and errors remain implementation-specific.

### A guide is not implementation evidence

The detailed production CLI guidebook defines a normative architecture. A
retained CLI codebase may implement only part or contradict it. Inspect code and
tests before claiming compliance.

### Archive names do not prove change

Two retained application archives normalized to identical contents. Describe
one evidence body with duplicate provenance, not a migration history.

### Documentation can outrun exports

The retained Wikitext README/export source contains a contract discrepancy.
Bound claims to the inspected revision and do not fabricate the missing export.

### Types are not dialect or durability

A Drizzle-shaped query builder is not a correct ClickHouse dialect. Effect
services/Layers are not automatically a durable workflow history. Verify the
specialized runtime contract.

### Tooling is not collected evidence

The Wikitext archive contains stress runners for scenarios that were not all
collected. Report implemented tooling and collected artifacts separately.

## Recovery protocol

When a likely hallucination or contradiction is found:

1. stop propagation: remove the claim from recommendations/code until resolved;
2. state exact claim, version, and scope;
3. mark current status `inferred` or `unresolved`;
4. identify at least two plausible explanations;
5. inspect exact lock/artifact/export/source/test/official relationship evidence;
6. run the smallest behavior check that discriminates explanations;
7. update topology, capability owner, exclusion, and integration plan;
8. add a regression eval that requires decision behavior, not the package word;
9. report remaining uncertainty and next evidence; do not fill it with analogy.

If code was already written against an invented API, preserve user changes,
inspect the diff, replace it with an exact-version API or local interface plus
explicit unimplemented adapter, and run connected checks. Do not hide the error
behind `any`, casts, broad catches, or fake mocks.

If wrong data/schema/public release escaped, follow the system's recovery plan:
stop writes/publishing, preserve evidence, reconcile/forward-fix/deprecate, and
communicate exact affected versions. Do not overwrite immutable history.

## Verification

- Validate every selected package and API against exact installed/published
  exports/source.
- Check every official/sibling/adapter edge against canonical evidence.
- Search for stable/prerelease/private release channels in references and examples.
- Run negative tests: missing optional peer, wrong host, unavailable dependency,
  invalid config, cancellation, disposal, and rollback.
- Ensure evals require ownership, version/status, failure/exclusion, and
  executable proof—not one keyword.
- Verify optimizer training and held-out splits are isolated.
- Review Markdown diffs without formatting unrelated text.
- Report blocked external-model/service/platform checks honestly.

## Sources and freshness

- All retained uploaded artifacts and their source registry, including duplicate
  archive, normative-guide/implementation, Wikitext export, generated artifact,
  private adapter, and cross-host counterexamples; verified 2026-07-17.
- Exact-version current primary source records for the ecosystems covered by the
  deep skill suite; verified 2026-07-17.
- Existing repository evaluation schema and SkillOpt isolation contract,
  observed at the working revision on 2026-07-17.

Update signatures when new real failures appear. Do not add speculative failure
facts without exact source or executable evidence.
