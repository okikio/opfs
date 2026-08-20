# Release process

## Purpose

The repository has one command authority: mise. GitHub Actions decides when a release/publish operation should run and
supplies GitHub-specific permissions, refs, secrets, and outputs. The actual project commands live under `.mise/tasks/`.

```text
GitHub Actions
      |
 jdx/mise-action
      |
   mise task
      |
Deno / Node / Bun / npm / semantic-release
```

## Conventional commits

Commits merged to `main` use Conventional Commits.

```text
fix: ...       patch
feat: ...      minor
feat!: ...     major

BREAKING CHANGE: ...
```

Commit validation runs through:

```sh
BASE_SHA=... HEAD_SHA=... mise run commits
```

The mise task pins the commitlint CLI package used by CI. Workflow YAML does not own a second commitlint command.

## Quality before release

The normal release evidence includes:

```sh
mise run quality
mise run test-deno
mise run test-node
mise run test-bun
mise run test-browser
mise run test-providers
mise run verify-npm
```

CI also runs benchmark smoke jobs so gross performance/runtime regressions are visible before a semantic release can
run.

The quality task includes strict checks, lint, documentation lint, formatting, stress, coverage, and package dry-runs.

## Lockfiles

Dependency changes are incomplete until both package-manager views are reproducible.

After dependency/import changes, regenerate with the canonical managers:

```sh
deno install --frozen=false
pnpm install
```

Review and commit `deno.lock` and `pnpm-lock.yaml`. Do not hand-edit integrity/resolution data merely because one
validation host cannot access the registry.

## Semantic release

The release workflow starts only after the successful `CI` workflow for `main`.

It checks out the tested commit, verifies that the checked-out `main` commit still equals the CI commit, then runs:

```sh
mise run release
```

The mise task invokes pinned semantic-release tooling. semantic-release determines the version from Git history, creates
the Git tag, and creates the GitHub release according to repository configuration.

The repository uses tags shaped as:

```text
opfs@1.2.3
```

## Registry publication uses the immutable tag

The publish workflow receives an existing release tag. It never publishes arbitrary `main` state.

```text
release workflow
   |
created opfs@X.Y.Z
   |
dispatch publish.yml(tag=opfs@X.Y.Z)
   |
checkout exact tag
   |
JSR and/or npm
```

A partial registry failure can be retried against the same immutable tag by selecting one target.

## JSR

JSR publication runs:

```sh
RELEASE_VERSION=X.Y.Z mise run publish-jsr
```

The task performs a frozen Deno install, a JSR dry-run, then the actual publish with the release version supplied
explicitly.

## npm

npm publication runs:

```sh
RELEASE_VERSION=X.Y.Z mise run publish-npm
```

The task:

1. resolves bootstrap token versus trusted-publishing mode;
2. runs `mise run verify-npm`;
3. builds the npm package from the Deno package graph;
4. verifies the tarball from Node/Deno/Bun consumers;
5. publishes the exact generated tarball with provenance.

`drizzle-orm` remains an optional peer in the generated npm package rather than being converted into a mandatory runtime
dependency.

## Bootstrap versus trusted npm publishing

The publish workflow can choose:

```text
auto
trusted
token
```

`auto` checks whether `@okikio/opfs` already exists on npm through `mise run npm-exists`.

- first publication: token mode;
- later publications: trusted mode when configured.

The workflow owns secret selection. The npm publish command still lives in the mise task.

## Package verification

`mise run verify-npm` builds a test-version tarball and executes the package consumer verifier. The verifier must
exercise the published package, not source-tree relative imports.

A release is not accepted because `npm pack` returned success. The generated manifest, exports, optional peers, and
runtime consumer entrypoints must also be checked.

## Version metadata

The checked-in development version is not the release decision. The immutable Git tag and semantic-release result define
the published version. Packaging receives that version explicitly instead of committing generated version edits back to
`main`.

## Recovery rules

If GitHub release creation succeeds but one registry publish fails:

1. do not create a replacement tag;
2. do not rebuild from a newer `main` commit;
3. re-run `Publish Registries` with the same immutable tag;
4. select only the failed registry when appropriate.

If validation fails before release creation, fix the source and produce a new commit. Do not weaken a quality task
solely to make the release workflow progress.

## Trusted npm publishing

The publish job installs `npm:npm@11.18.0` through mise. npm trusted publishing requires npm CLI 11.5.1 or later and
Node 22.14.0 or later. The explicit npm pin prevents the release path from depending on the bundled npm version of the
selected Node release.

## Schema-derived public types

Zod remains the runtime validation source of truth, but JSR fast-type extraction must not infer Zod's internal generic graph from exported schemas. `scripts/schema.ts` compiles the supported Zod v4 definitions into `src/_schema_types.ts`; public schemas expose explicit `z.ZodType<Output, Input>` contracts and public data aliases point at the generated structural types.

Run `mise run schema` after changing a compiled schema. `mise run schema-check`, the canonical `check` task, JSR publication, and npm verification reject stale generated contracts. The project-local compiler intentionally throws for unknown Zod definition kinds instead of emitting `any`.

## Registry artifacts

JSR publishes the original TypeScript graph with `deno publish`. npm is a separate derived artifact built by `scripts/npm.ts` with dnt. The dnt build derives its entry points from `deno.json`, emits ESM plus declarations, maps `@okikio/undent` to its normal npm package, retains `drizzle-orm` as an optional peer, and rejects any generated `@jsr/*` npm dependency.

The immutable `opfs@<version>` Git tag remains the release-version authority for both registry jobs. semantic-release still creates that tag and GitHub Release; the packaging migration does not introduce a second version owner.
