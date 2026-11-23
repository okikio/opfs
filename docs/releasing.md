# Publish a tested package release

`@okikio/opfs` publishes the same revision to two registries: JSR receives the TypeScript source, and npm receives the
ESM tarball that `tools/npm/pack.ts` builds with dnt. Sampo owns release intent, the version and `CHANGELOG.md`.
Publication is a separate, manual step that only runs for a commit whose main-push CI already passed.

```text
changeset in a PR ─► merge to main ─► Release: prepare ─► release/versions PR ─► merge
                                                                                   │
                   verify on registries ◄─ npm + JSR publish ◄─ Release: publish ◄─┘
                                                 (needs passing main CI on this exact commit)
```

## Write release notes that teach

Every consumer-visible change adds a changeset in `.sampo/changesets/` (`node_modules/.bin/sampo add`, or write it by
hand). It tells a consumer what changed, why it matters, and how to use or migrate it. Use a complete example for a
changed API. Explain a failure scenario, resource owner, or compatibility constraint when it affects adoption. Use
diagrams, tables, and before/after output when they make the change clearer. The explanatory quality of esbuild's
changelogs is the standard; a list of commit subjects is insufficient.

```markdown
---
npm/@okikio/opfs: patch
---

Stop pending source reads when shape inspection is cancelled. ...
```

Keep one story per consumer behavior. Breaking changes need explicit migration instructions. Performance claims need the
workload, runtime, input size, units, baseline, variability, and correctness evidence. Do not promise every
specification in a standards family because one profile passed.

For this pre-1.0 package, compatible repairs are patch releases; new capabilities and intentional programming-model
replacements use a minor increment with an explicit migration note. `mise run release:plan` previews the next version
and changelog; pull requests run it too.

## Prepare the version

A push to `main` that adds changesets starts the **Release** workflow's `prepare` job. It runs
`mise run release:version`: Sampo consumes the changesets into `package.json` and `CHANGELOG.md`, and
`tools/release/manifest.ts` copies the version into `deno.json`. The job pushes the result to `release/versions` and
opens a pull request. A pull request opened by the workflow token does not start CI by itself; dispatch **CI** on
`release/versions`, review the changelog, then merge.

## Publish

Dispatch **Release** on `main` with `operation: publish`. Three conditions gate both registry jobs:

- **Recorded evidence.** The latest CI run for a push to `main` on this exact commit must have succeeded
  (`tools/ci/evidence.ts release`). An older pass does not count when a newer run on the same commit failed.
- **This run's checks.** The full Quality workflow runs on the same commit; lanes whose exact inputs already passed skip
  their steps through the result cache.
- **No pending changesets.** The version must already be prepared and merged.

The npm job builds the tarball at the release version, checks that exact tarball from a clean consumer
(`tests/package/verify.ts`), and publishes it with provenance through npm trusted publishing. The JSR job runs
`deno publish`. Both authenticate with the workflow's OIDC token; no registry token is stored. Each job then installs
the published version in a fresh consumer (`tools/release/verify.ts`). A registry that already has the version is
skipped, so a partial failure can be retried with `target: npm` or `target: jsr` at the same commit. After both succeed,
the workflow tags the commit `v<version>` and creates a GitHub release from the changelog section.

`operation: validate` runs the evidence and Quality checks without publishing.

## JSR constraints

JSR publishes ESM TypeScript source and generates npm compatibility artifacts. Direct npm packages built here are a
separate distribution path; `@jsr/okikio__...` compatibility names are not the direct npm package names.

Before upload, `deno publish --dry-run` (`mise run check:jsr`) must pass without `--allow-slow-types` or `--no-check`.
Public exports need explicit, portable types. Exclude tests, benchmarks, downloaded suites, reports, caches, temporary
fixtures, and release credentials from the publish set.

[JSR limits](https://jsr.io/docs/quotas-and-limits) require each source file, total uncompressed package, and uploaded
gzip archive to be under 20 MB. [JSR publishing](https://jsr.io/docs/publishing-packages) supports GitHub OIDC for a
package linked to the correct repository. Registry versions are immutable: repair by publishing a new version, never by
overwriting an old one or force-moving a public tag.
