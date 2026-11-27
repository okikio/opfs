# Releases, versioning, and recovery

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Authority and release state](#authority-and-release-state)
- [Semver is a compatibility decision](#semver-is-a-compatibility-decision)
- [Release notes and changelog generation](#release-notes-and-changelog-generation)
- [Preflight and immutable inputs](#preflight-and-immutable-inputs)
- [Build, attest, and publish](#build-attest-and-publish)
- [Multiple packages and registries](#multiple-packages-and-registries)
- [Post-publication verification](#post-publication-verification)
- [Partial failure, rollback, and repair](#partial-failure-rollback-and-repair)
- [Security and authorization](#security-and-authorization)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Executable verification](#executable-verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference for version changes, changelogs, tags, GitHub releases,
registry publication, provenance, release automation, prereleases, yanks, or a
failed/partial release. Planning or reviewing a release does not authorize a
publish, tag, push, registry change, deprecation, or deletion.

## Outcome

A release is a recoverable state transition from one immutable source revision
to one or more immutable consumer artifacts. Completion requires evidence that:

- compatibility was classified before choosing the version;
- one version/revision owns every artifact;
- the source tree, lockfiles, generated artifacts, package contents, and release
  notes were checked before publication;
- artifacts were built in a controlled environment and their digests/provenance
  retained;
- each registry/asset was verified by a clean consumer after publication;
- retries cannot publish different bytes under the same version;
- partial publication and post-release defects have an explicit response;
- credentials and publishing authority are narrow, auditable, and not present
  in artifacts.

Treat release creation, registry publication, and deployment as separate state
machines even if one workflow coordinates them.

## Authority and release state

Define the canonical tuple:

```text
release identity = package/product + semantic version + source revision
artifact identity = release identity + target + sha256/integrity
publication identity = artifact identity + registry/channel + timestamp/run
```

Choose one version source: a validated release input/tag, a package manifest, or
a release manifest. Other manifests are projections. Reject ambiguity rather
than selecting the highest value. A dirty checkout, untracked generator input,
floating dependency resolution, or uncommitted changelog means the source
revision does not explain the artifact.

Useful lifecycle states:

```text
planned -> prepared -> tagged/release-created -> built -> published-per-target
    -> post-publish-verified -> complete
                         \-> failed-partial -> repair/deprecate/supersede
```

Persist target-specific state. A GitHub release existing does not mean npm, JSR,
container, binary, documentation, or deployment succeeded. Never infer completion
from one green job when another target was skipped or conditionally false.

## Semver is a compatibility decision

Inventory every public contract, not only exported TypeScript names:

- runtime values, types, subpaths, conditions, bin names, exit codes, stdout;
- configuration keys/defaults/merge order and environment variables;
- persistence schemas, migrations, wire formats, events, cursors, URLs;
- required runtime/OS/architecture/peer/dependency versions;
- CSS/classes/assets/templates and plugin/adapter hooks;
- error classes/codes/retry behavior, performance/resource limits, and security
  policy where consumers rely on them.

Decision model:

| Change | Normal classification | Required evidence |
|---|---|---|
| Compatible bug fix/internal correction | patch | regression test plus unchanged public contract |
| Backward-compatible capability | minor | old consumer plus new behavior tests |
| Removed/renamed/stricter public behavior | major | migration guide and compatibility fixtures |
| Security response | impact-dependent | advisory, supported-line policy, disclosure plan |
| Prerelease | channel-specific | explicit identifier/sequence and upgrade semantics |

Zero-major projects often adopt special rules, but tools disagree about whether
`0.x` or `0.0.x` components behave as "major". Changelogen 0.6.2 documents its
own special handling. Encode project policy in tests/config and do not assume a
library's default is the product's contract.

A dependency update can be breaking when it changes emitted code, supported
engines, peer ranges, generated schemas, native ABI, or transitive types. A
performance "optimization" can be breaking when it changes ordering, memory
limits, precision, error timing, or concurrency. Run compatibility fixtures.

## Release notes and changelog generation

Commit history is evidence, not a complete product impact model. Generate a
candidate changelog, then review it against the actual public diff and migration
requirements. Notes should distinguish:

- user-facing additions, fixes, removals, and security changes;
- upgrade actions, version/runtime handoffs, and deprecations;
- known limitations and deliberately unchanged behavior;
- contributors and commit links when policy permits;
- artifact/checksum/install information when users need it.

Changelogen 0.6.2 can parse Conventional Commits, select `--from`/`--to`, infer
a bump, update a changelog/version, create commits/tags, publish npm packages,
create canaries, and synchronize GitHub releases. Its breadth increases the
authorization risk: preview/no-output generation is suitable for review, while
`--release`, `--push`, `--publish`, and GitHub release sync are mutations and
must be separately authorized.

```sh
# Candidate notes from an explicit immutable range; review only.
changelogen --from v1.2.2 --to 4e1c0f7 --no-output

# Do not run these merely to preview:
# changelogen --release --push
# changelogen --publish
```

Pin the tool version. Validate its c12-loaded config and repository field.
Treat author emails/tokens as sensitive. Generated notes do not define migration
policy; schemas, compatibility tests, and maintainers do.

## Preflight and immutable inputs

Before creating a tag or release:

1. confirm requested action and publication targets;
2. require the expected branch/revision and an intentional clean tree;
3. fetch tags/registry state to detect an existing version;
4. restore frozen/locked dependencies without changing the lockfile;
5. validate version syntax, monotonicity, tag prefix, prerelease/channel policy,
   manifest propagation, and changelog heading;
6. run scoped formatting (never broad Markdown formatting), lint, typecheck,
   unit/integration/compatibility/security tests;
7. run generated-drift checks;
8. build all source/generated packages from clean output directories;
9. inspect packed contents, exports, licenses, engine/peer/dependency metadata;
10. run clean consumers and representative executables;
11. create an artifact manifest with revision, versions, build command, inputs,
    target, size, digest, and expected publication name.

If the version already exists, download its published artifact and compare the
intended bytes/metadata. Most registries are immutable; never try to overwrite a
version. Decide whether this is a safe idempotent retry, a partial publication,
or a new patch/prerelease is required.

## Build, attest, and publish

Build from the exact commit/tag with pinned action/tool versions and least
privilege. Prefer short-lived workload identity/trusted publishing over long-lived
tokens. Separate jobs by target so a token for one registry cannot write another.

Minimum provenance record:

```json
{
  "name": "@scope/package",
  "version": "1.2.3",
  "revision": "4e1c0f7...",
  "target": "npm",
  "artifact": "package-1.2.3.tgz",
  "sha256": "...",
  "runtime": "deno 2.8.x / node 26",
  "lockDigest": "...",
  "buildCommand": "deno task build:npm",
  "workflowRun": "..."
}
```

Use ecosystem provenance/attestations/signatures where supported, but verify
what they prove. An attestation can bind an artifact to a workflow/repository;
it does not prove semver correctness, runtime behavior, dependency safety, or
that the user intended this release.

Create or publish immutable objects once. Retrying should reuse the retained
artifact, not rebuild it from a mutable branch. If a registry requires a build
inside its publish job, compare the rebuilt digest to the prepared artifact and
fail on mismatch.

The attached Undent workflows use a useful separation:

- the release workflow creates a GitHub release from main;
- the publish workflow reacts to a published release or an explicit existing
  tag and can retry JSR, npm, or both;
- concurrency does not cancel an in-progress publication;
- JSR and npm have separate jobs/permissions;
- npm can bootstrap with a token for first publication then use trusted
  publishing; JSR uses OIDC;
- release version is injected into generated artifacts from the validated tag.

The example still needs project-specific review. `--allow-dirty` for a manifest
projection must be constrained and explained, and published bytes/digests should
be retained if reproducibility is claimed.

## Multiple packages and registries

For a workspace, build an explicit release graph:

```text
package A@1.2.3
  -> package B@2.0.0 (runtime dependency)
  -> adapter C@0.7.0 (peer relationship)
```

Decide fixed/independent versioning, internal range rewriting, publish order,
cycle policy, unchanged-package behavior, canary naming, and failure recovery.
Verify packed manifests after workspace protocols/catalog references are
resolved. A topological publish order is not enough if a registry has propagation
delay; clean install after each dependency becomes available or use bounded
retry with exact versions.

For npm plus JSR or other multi-registry releases:

- generate both from the same release identity;
- record different expected transforms rather than demanding byte equality;
- verify public entrypoints and behavior separately;
- track status separately so one can be retried;
- do not advance `latest`/stable documentation until supported required targets
  are verified, unless policy explicitly allows partial availability.

Channels/tags (`latest`, `next`, canary) are mutable pointers. Record prior
values before changing them and define rollback. Do not attach a prerelease to
the stable channel by default.

## Post-publication verification

Publication success is only registry acceptance. From a new empty consumer:

- resolve exact version from the public registry;
- inspect metadata, provenance, deprecation/channel, tarball digest, and contents;
- install with supported package managers/runtimes;
- import every public entry, typecheck, and execute representative behavior;
- run CLI `--help`, `--version`, stable-output, failure, and cancellation paths;
- verify source maps/assets/native binaries where promised;
- compare package version/output to release/tag/changelog;
- verify GitHub release assets/checksums and documentation install snippets.

Test eventual consistency explicitly. A short registry delay is a blocked/pending
check, not a pass and not necessarily a defective artifact. Retry with a deadline,
then report exact target state.

## Partial failure, rollback, and repair

Published immutable artifacts generally cannot be rolled back by deletion and
reuse. Prepare target-specific actions before release:

| Failure | Safe response candidates |
|---|---|
| Artifact not yet published | fix/rebuild before immutable publication |
| One registry published, another failed | retain artifact; retry failed target only; report partial state |
| Bad package published | deprecate/yank if policy permits; publish fixed version; advisory/migration |
| Wrong channel pointer | restore prior pointer after verifying exact version |
| GitHub release only | edit/withdraw release per policy without inventing registry success |
| Compromised credential/artifact | stop pipeline, revoke, preserve evidence, advisory, superseding release |
| Deployment failed after library publication | roll back deployment separately; do not rewrite package history |

Record rollback authority and retention windows. Unpublish can break downstream
builds and is time-limited or restricted in many registries; treat it as an
exception, not the normal recovery mechanism. A tag that has been consumed
should not be force-moved. Prefer a corrected version and transparent notes.

## Security and authorization

- Use protected environments/approvals for production publication.
- Grant `contents`, `packages`, `id-token`, or registry scopes only to the job
  that needs them.
- Pin third-party actions and release tools to reviewed versions/revisions.
- Never expose tokens in command args, generated config, npm logs, provenance,
  changelogs, or package contents.
- Do not run package lifecycle scripts during verification unless required and
  explicitly sandboxed/reviewed.
- Preserve audit logs, artifact digests, source revision, approvals, and failed
  attempts.
- Verify repository/package identity before granting trusted publishing; a
  similarly named package or fork is not the target.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Tag, manifest, and CLI version differ | multiple version authorities | release-input propagation |
| Generated notes omit a breaking change | commit grammar used as impact model | public diff and compatibility fixtures |
| Re-run produces different tarball | rebuild from mutable/nondeterministic inputs | retained artifact and build provenance |
| npm succeeds, JSR missing | target state collapsed into one job/result | per-target ledger and retry |
| Clean install gets old behavior | mutable channel/cache or wrong registry | exact version/digest and registry metadata |
| Package exists but release job wants to republish | retry not idempotent | compare existing artifact and skip/repair |
| Provenance exists but package is broken | attestation mistaken for validation | consumer behavior and semver gates |
| Workspace consumer cannot resolve internal package | protocol/range not rewritten or order delay | packed manifest and registry state |
| Release cancelled midway | cancellation/concurrency policy unsafe | workflow concurrency and target states |
| Token appears in logs/artifact | secret passed through output/config | redaction, args/env, archive scan |

## Deliberate exclusions

- Do not publish, tag, push, deprecate, unpublish, or change channels during a
  review or dry run.
- Do not use a broad release tool command when the task only requires notes or
  a version proposal.
- Do not infer semver only from commit prefixes.
- Do not release from a dirty tree, mutable branch checkout, or unlocked graph.
- Do not rebuild an already approved artifact during a partial retry.
- Do not call a release complete until required post-publish consumers pass.
- Do not delete/yank history merely to make automation green.

## Executable verification

1. Validate exact revision/clean tree/locked dependency restore.
2. Generate candidate notes from explicit refs and compare them with public
   contract diffs and migration fixtures.
3. Run the complete source/generated/pack/consumer gate.
4. Build twice in clean isolated directories and compare artifact manifests.
5. Exercise a dry-run or staging registry when supported.
6. Simulate existing-version, one-target failure, registry delay, cancelled job,
   and post-publish defect; prove the state ledger selects a safe action.
7. Verify workflow permissions and ensure mutation steps require authorization.
8. After publication, install the exact public version and verify behavior.
9. Validate provenance/signatures/checksums independently from behavior.
10. Preserve a machine-readable release report including blocked and failed
    checks, not just a success boolean.

## Sources and freshness

- Attached `undent.zip`, observed `.github/workflows/release.yml`,
  `.github/workflows/publish.yml`, `.releaserc.json`, `scripts/build_npm.ts`, and
  release checklist; verified 2026-07-17.
- Changelogen 0.6.2 published README/declarations/manifest; source record
  `changelogen-0-6-2`, verified 2026-07-17.
- Attached production CLI guidebook v1.1, normative release gates, packaged
  executable lifecycle, completion/man artifacts, and rollback expectations;
  verified 2026-07-13.

Registry rules, trusted-publisher requirements, action versions, and tool CLI
options change. Recheck official registry documentation and the pinned tool's
generated help immediately before changing a production release workflow.
