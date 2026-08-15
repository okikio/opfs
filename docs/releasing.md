Release process
===============

`@okikio/opfs` publishes one Git release to JSR and npm. Git history decides the version. `deno.json` owns the authored package graph and public exports. semantic-release does not commit generated version files back to `main`.

Conventional commits
--------------------

Commits merged to `main` use Conventional Commits 1.0.0. Release-relevant examples are:

```text
fix: correct a public behavior                 -> patch
feat: add a compatible capability              -> minor
feat!: replace a public contract                -> major

BREAKING CHANGE: describe the consumer impact  -> major
```

`build`, `chore`, `ci`, `docs`, `refactor`, `style`, and `test` are valid types. They do not cause a release unless the analyzed commit carries a breaking change. Pull requests should normally squash to one conventional commit so `main` remains a clear release input.

The checked-in `0.0.1` is development metadata, not the first public release decision. semantic-release does not support selecting `0.0.1` as the initial stable version. With no earlier release tag, the normal first release on `main` is `1.0.0`. If the project is not ready for a stable `1.0.0`, configure a prerelease branch before enabling the release workflow. Registry commands receive the semantic-release version through `--set-version`, so they do not publish the development placeholder.

Dependency graph
----------------

Dependency changes are not complete until both package-manager views are reproducible. After changing `deno.json` or
`package.json`, update the Deno lockfile intentionally with:

```sh
deno install --frozen=false
pnpm install
```

Review and commit both `deno.lock` and `pnpm-lock.yaml`. CI uses `deno ci`, which deliberately rejects a missing or stale Deno
lockfile instead of resolving an unseen dependency graph during the build.


Release flow
------------

```text
push to main
    |
    v
CI
    |  frozen dependencies, format, lint, docs, types,
    |  runtime tests, browser matrix, stress, package dry-runs
    v
Release workflow
    |
    +-- verify main still equals the tested CI SHA
    +-- semantic-release reads commits since opfs@<version>
    +-- semantic-release creates the Git tag and GitHub Release
    |
    `-- only when a new tag appeared:
          workflow_dispatch Publish Registries
                         |
                         +----> JSR
                         `----> npm
```

The registry workflow is dispatched explicitly instead of relying on the GitHub `release` event. A release created with the repository `GITHUB_TOKEN` does not normally trigger another workflow from that release event. GitHub does allow `workflow_dispatch` events created with `GITHUB_TOKEN`, so the release workflow can start the separate publisher without a long-lived release PAT.

A rerun on a commit that already has an `opfs@<version>` tag does not dispatch another automatic publication. Manual registry retries remain available through `Publish Registries` and require the existing immutable tag.

semantic-release owns only version analysis, tag creation, release notes, and the GitHub Release. It does not publish either registry and it does not create a release commit.

npm packaging
-------------

JSR consumes the authored TypeScript package directly. npm receives generated JavaScript and declaration files.

`.mise/tasks/npm` runs `deno pack --no-deno-shim --set-version`. Deno derives the npm graph and exports from the same `deno.json` used by JSR. Drizzle needs one npm-only correction: it is an optional integration, so the task removes `drizzle-orm` from generated normal dependencies and writes it as an optional peer before the final `npm pack`.

The generated tarball is then installed into a clean consumer. The verifier checks exports and declarations, Node/Deno/Bun imports when those runtimes are present, browser bundling, and the optional Drizzle subpath after the peer is installed.

Registry setup
--------------

Before the first release:

1. Create `@okikio/opfs` on JSR and link it to `okikio/opfs` for GitHub OIDC publication.
2. Bootstrap the first npm publication with a granular/automation token in `NPM_TOKEN` when trusted publisher settings are not yet available for the package.
3. After npm has the package, configure trusted publishing for `.github/workflows/publish.yml`.
4. Remove `NPM_TOKEN` when the bootstrap fallback is no longer wanted.

The publisher uses GitHub OIDC for JSR and for normal npm trusted publication. npm is upgraded to a current npm 11 release in the publish job before trusted publishing.

Partial failure
---------------

If one registry succeeds and the other fails, do not create another version. Run `Publish Registries` manually with the same existing `opfs@<version>` tag and select only the failed registry.

Local release checks
--------------------

A Deno-capable machine can run:

```sh
mise install
mise run check
mise run test
mise run bench
deno task release:check
```

The GitHub release and registry workflows use mise for their Node, Deno, and Bun toolchain too. Release-only policy remains in
GitHub Actions: OIDC permissions, immutable tag resolution, semantic-release, registry authentication, and the final publish
commands are deployment concerns rather than reusable repository tasks.

`deno task release:check` performs package dry-runs. It does not upload a release.
