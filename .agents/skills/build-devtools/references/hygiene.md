# Repository hygiene and retained artifacts

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Classify before changing](#classify-before-changing)
- [Dirty worktree protocol](#dirty-worktree-protocol)
- [Caches and build outputs](#caches-and-build-outputs)
- [Binaries and vendored dependencies](#binaries-and-vendored-dependencies)
- [Generated and archived material](#generated-and-archived-material)
- [Secrets, personal data, and databases](#secrets-personal-data-and-databases)
- [Workspace and task integrity](#workspace-and-task-integrity)
- [Reviewability and Markdown](#reviewability-and-markdown)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Executable verification](#executable-verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference for repository cleanup, large-file review, cache/vendor/build
classification, generated outputs, accidental binaries, archive creation, dirty
worktrees, secret scanning, missing tasks, or "remove cruft" requests. A review
or diagnosis authorizes inspection, not deletion.

## Outcome

Leave a repository whose tracked and distributed contents have explicit owners,
reproducible acquisition/build/update paths, appropriate licensing/integrity,
and no accidental local state. Preserve user work and review history. Report
unknowns instead of deleting files based on name or size.

Hygiene is not a small repository at any cost. Fixtures, corpora, snapshots,
generated tables, native binaries, and vendored code can be intentional. The
goal is explained ownership and safe lifecycle.

## Classify before changing

For every suspicious path classify:

| Class | Evidence | Normal action |
|---|---|---|
| Authored source/docs | imports, manifest, history, instructions | preserve; normal review |
| Generated committed source | generator/header/task, consumer | preserve; add drift/update contract |
| Ignored build output | build task and clean reproduction | remove from deliverable; rebuild as needed |
| Cache/download | cache owner and invalidation key | ignore/remove locally; never package |
| Fixture/corpus/snapshot | named tests and update policy | preserve if needed; size/license review |
| Vendored dependency | upstream revision, license, patches | preserve only with vendor policy |
| Release artifact | release identity/digest/retention | store in release system, not casually in Git |
| Local tool binary | editor/tool installer, platform-specific | ignore/remove from artifact unless vendoring intentional |
| Secret/personal/runtime data | content/schema/location | stop exposure; remediate according to policy |
| Unknown | insufficient evidence | quarantine/report; do not delete |

Inspect repository instructions, Git status/history, ignore rules, manifests,
imports, task references, workflows, package `files`, Docker contexts, deployment
config, and release scripts. Use content/magic, size, mode, and digest—not only
extension. A file named `data.db` may be a required test fixture or leaked
production-like state; a file named `tool` may be source or an 84 MB executable.

Before calling two archives different versions, compare normalized relative
paths and hashes. Two retained application archives with different names contained
identical source content despite different archive identities; inventing an
evolution story would be a provenance error.

## Dirty worktree protocol

1. Record `git status --short`, branch/revision, staged/unstaged/untracked paths.
2. Read diffs for files in scope and distinguish user changes from the requested
   work where possible.
3. Identify commands that can mutate broadly: formatters, generators, installers,
   package managers, migrations, build tools, and cleanup scripts.
4. Scope commands to owned paths or use isolated copies/worktrees for destructive
   observations.
5. Never overwrite a modified generated file before determining whether the
   input/generator or output was intentionally edited.
6. After each mutation, recheck status and attribute new changes.

Do not stash, reset, checkout, clean, or delete user changes without explicit
authorization. `git clean`, recursive deletion, builder `--force-clean`, and
package-manager prune commands can remove untracked work. Prefer listing/dry-run
and targeted paths. If clean-state evidence is required, copy/archive tracked
files or use an authorized temporary worktree rather than normalizing the user's
tree.

## Caches and build outputs

Common local-only candidates include:

- `node_modules`, Deno/npm/pnpm/Aube caches and global stores;
- framework/build directories, coverage, temporary declarations/maps;
- `.DS_Store`, editor state, preview screenshots, local logs;
- temporary SQLite/ClickHouse/Postgres volumes and test run artifacts;
- compiled binaries downloaded by editors/tool managers;
- benchmark scratch reports not selected for the permanent study record.

Classify by owner/invalidation. A cache key should include every input that makes
entries valid: platform/architecture, runtime/tool version, lock digest, build
flags, source digest, and sometimes environment. A cache restore is an
optimization, never authority. CI must be able to rebuild with empty caches and
must not publish cache contents accidentally.

Ignore rules should be specific enough not to hide authored source. Test them:

```sh
git check-ignore -v path/to/suspect
git ls-files --error-unmatch path/to/suspect
```

Review Docker/package/archive contexts separately from Git tracking. A Gitignored
secret or cache can still enter an image when `.dockerignore` is wrong, or a ZIP
when the archive command takes the filesystem rather than tracked files. Prefer
`git archive` or an explicit staging manifest for source deliverables.

## Binaries and vendored dependencies

Intentional binary/vendored material needs:

- exact upstream project/version/revision and download URL;
- cryptographic digest/signature and verification procedure;
- license, notices, source-offer obligations, and security owner;
- platform/architecture/libc/runtime matrix;
- update, vulnerability response, rollback, and end-of-life policy;
- reason package-manager/system acquisition is insufficient;
- tests that load/execute the shipped artifact on supported targets.

Do not commit a downloaded tool merely to make one editor or sandbox work. Use
Mise/Aube/runtime setup or a documented bootstrap with integrity. If offline or
supply-chain constraints justify vendoring, store a manifest and scripts rather
than an unexplained binary. Never execute an unverified binary during inspection.

Git LFS can store large tracked objects but does not supply provenance, license,
platform coverage, or reproducible update policy. Submodules preserve a Git
revision but still need trust, availability, recursive checkout, and packaging
rules. Vendored generated code may require both upstream and generator identity.

## Generated and archived material

Every committed generated file must name or be mapped to:

- source inputs and their version/digest;
- generator command/tool version;
- check/write policy;
- semantic and consumer verification;
- whether formatting is owned by the generator;
- update and review procedure.

Archive/package creation should begin from an explicit manifest or tracked
revision, not `zip -r .`. Exclude `.git`, caches, `node_modules`, credentials,
local databases, test temp, editor binaries, prior archives, SkillOpt run data,
and internal evidence unless intentionally part of the deliverable. Verify ZIP
integrity and list its contents/large files before handoff.

Generated experiment artifacts are evidence only if tied to source/harness and
the protocol. Retain raw samples used by conclusions; remove unowned exploratory
scratch. Do not delete a rejected-candidate report that prevents repeated work.

## Secrets, personal data, and databases

Stop and scope remediation when discovering credentials or sensitive data.

- Do not print full values while diagnosing; report path, key name, and bounded
  fingerprint when useful.
- Determine whether it is tracked, committed in history, packaged, published,
  or only local.
- Rotate/revoke exposed credentials through authorized systems; deleting the
  file alone is not remediation.
- Preserve evidence needed for incident response without duplicating secrets.
- Add `.env.example` with names and safe placeholders, not real values.
- Treat database files, request traces, benchmark corpora, screenshots, and logs
  as potentially personal/confidential even if no key pattern matches.

History rewriting and remote deletion are destructive, coordinated actions;
never infer authorization from a cleanup request. A secret scanner pass lowers
risk but does not prove absence. Review generator/release logs and artifact
contents too.

## Workspace and task integrity

Hygiene includes connected contracts:

- workspace globs resolve to intended packages and exclude output/evidence;
- each package has one dependency/version owner and compatible lock graph;
- scripts/tasks referenced by README, CI, prepack, release, or editor config
  exist and use current options;
- permission lists cover actual imports/files/hosts/subprocesses without blanket
  access;
- package export/files maps contain required assets and exclude internals;
- generated files have producers; generators have consumers;
- duplicate dependency versions are either intentional compatibility requirements
  or candidates for alignment;
- dead config is proven unused across local, CI, package, container, deploy,
  docs, and developer environments before removal.

Use clean-clone setup and a complete lifecycle (`install -> check -> build ->
pack -> consumer`) to find undeclared local dependencies. An unused search hit is
not proof a file is dead when a framework, manifest, dynamic loader, or release
workflow discovers it conventionally.

## Reviewability and Markdown

Do not run repository-wide Markdown formatting during code, generator, cleanup,
or skill-document work unless the user explicitly requests it. Wrapping, table
alignment, list normalization, heading changes, and code-fence formatting hide
substantive documentation edits and can damage marker directives.

Scope code formatting by extension/path or configure Markdown exclusions. After
editing:

- inspect Markdown `git diff --stat`/`--numstat` and `git diff -w`;
- review every changed Markdown hunk;
- confirm generated markers/code fences are balanced;
- check links without rewriting prose;
- ensure no unrelated newline/wrapping-only churn.

Do not normalize line endings repository-wide. Preserve an authored file's
style unless the task owns that migration and reviewers can isolate it.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| ZIP unexpectedly huge | cache, binary, database, nested archive | sorted archive size listing |
| Clean clone cannot build | untracked input/global tool/cache | task/input and toolchain inventory |
| Deleted file returns after build | generated output treated as cruft | producer/consumer ownership |
| Gitignored file appears in container/package | separate context/include rules | Docker/package/archive manifest |
| Binary works only on one host | platform artifact committed without matrix | file identity and target policy |
| Cleanup destroys user work | destructive command in dirty tree | status/dry-run/authorization protocol |
| Markdown diff dwarfs logic change | broad formatter or generator scope | `git diff -w` and task configuration |
| Two "versions" have identical hashes | names mistaken for content evolution | normalized archive comparison |
| Secret deleted but still usable | no rotation/history/publication response | credential and incident state |
| Dead task removal breaks release | connected workflow not searched/tested | CI/prepack/release/editor consumers |

## Deliberate exclusions

- Do not delete unknown, untracked, generated, or large files based only on a
  pattern match.
- Do not execute unknown binaries to identify them.
- Do not run `git clean`, resets, stashes, broad formatters, package upgrades,
  or lockfile regeneration as routine hygiene.
- Do not move large files to LFS and call provenance solved.
- Do not include uploaded evidence/codebases in a public artifact unless the
  user explicitly requests redistribution and licensing permits it.
- Do not rewrite history or rotate credentials without the required authority.
- Do not confuse a clean Git status with a reproducible repository.

## Executable verification

1. Capture status/revision and a sorted inventory of tracked, untracked,
   ignored, executable, binary, and large files.
2. Map generated/vendor/build/cache candidates to producers and consumers.
3. Validate ignore rules plus package/Docker/archive include rules.
4. Run secret and license/provenance review with redacted reporting.
5. Execute setup/check/build/pack/consumer from a clean isolated copy with empty
   relevant caches.
6. Verify generated drift and vendor digests without mutation.
7. Create the deliverable from an explicit manifest/tracked revision; list and
   integrity-test it; assert forbidden paths and oversized surprises are absent.
8. Inspect all Markdown changes and compare whitespace-insensitive stats; do not
   format Markdown.
9. Recheck worktree status and attribute each resulting path.
10. Report preserved unknowns and blocked remediation rather than presenting
    partial cleanup as complete.

## Sources and freshness

- All retained uploaded archives, observed repository roots, manifests, ignore
  files, workflows, fixtures, generated outputs, binaries, and duplicate archive
  identity during the July 2026 evidence audit.
- Attached `undent.zip`, observed generator/build/release ownership and ignored
  npm output; verified 2026-07-17.
- Attached `wikitext.zip`, observed retained experimental artifacts and explicit
  incomplete-matrix reporting; verified 2026-07-17.
- Attached production CLI guidebook v1.1, normative least-privilege tooling,
  packed artifact, cache/state path, install/uninstall, and release checks;
  verified 2026-07-13.

Re-evaluate repository-specific ignore, retention, licensing, and incident rules
at the current revision. Generic cache lists are discovery hints, not deletion
authorization.
