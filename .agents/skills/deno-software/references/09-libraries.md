# Deno libraries, private packages, JSR, npm, and publication

## Contents

- Distribution models
- JSR package contract
- Private Deno workspace packages
- Public API design
- JSR versus npm for authors
- Dual-publication contract
- Publication inclusion
- `deno publish` workflow
- Workspace publication
- Interdependent package release
- Private npm publication
- npm package validation
- Semver and breaking changes
- Clean-consumer fixtures
- Publication review checklist

Publishing begins with deciding who consumes the package and through which
registry. Do not conflate a workspace package, a private package, a JSR package,
and an npm package.

## Distribution models

| Model                        | Metadata                                    | Publication command             | Consumer form                         |
| ---------------------------- | ------------------------------------------- | ------------------------------- | ------------------------------------- |
| Workspace-local Deno package | member `deno.json(c)` with `publish: false` | none                            | bare workspace package name           |
| Public JSR package           | `deno.json(c)` name/version/exports         | `deno publish`                  | `jsr:@scope/name` or configured alias |
| Private npm package          | `package.json` plus registry config         | npm-compatible publish workflow | npm package through `.npmrc`          |
| Public npm package           | `package.json` and generated/runtime files  | npm-compatible publish workflow | npm package                           |
| Dual JSR/npm package         | separate explicit contracts                 | both workflows                  | both registries                       |

JSR is not a private package registry in the same sense as a private npm
registry. For organization-private distribution, use workspace-local packages, a
private npm registry, or another explicitly supported private repository
mechanism.

## JSR package contract

A publishable Deno package needs:

```jsonc
{
  "name": "@acme/schema",
  "version": "1.4.0",
  "exports": {
    ".": "./src/mod.ts",
    "./user": "./src/user.ts"
  },
  "publish": {
    "exclude": [
      "test/",
      "examples/",
      "**/*.test.ts"
    ]
  }
}
```

The public API is the export map, not the repository directory structure. Export
only supported entrypoints.

## Private Deno workspace packages

For a member used only inside the monorepo:

```jsonc
{
  "name": "@acme/internal-codegen",
  "publish": false,
  "exports": "./src/mod.ts"
}
```

`publish: false` is the Deno/JSR opt-out.

Do not rely on `package.json.private` for a Deno member. That field protects npm
publication and is not read as a Deno publish exclusion.

Package.json-only members are not candidates for `deno publish`, because that
command targets JSR packages.

## Public API design

Before exposing a module, define:

- package purpose;
- supported runtime environments;
- stable import paths;
- runtime permissions and side effects;
- data schemas and error contracts;
- compatibility policy;
- whether APIs are synchronous, asynchronous, streaming, or cancellable;
- resource ownership and disposal.

Prefer a small semantic export map. Do not publish internal directory mirrors.

For data-bearing public contracts, define Zod v4 schemas/codecs as the source of
truth where runtime validation is needed and infer TypeScript types.

## JSR versus npm for authors

Publish to JSR when:

- TypeScript source is the canonical artifact;
- consumers are Deno or modern ESM runtimes;
- the package can be documented and type-checked directly from source;
- JSR's npm compatibility output is enough for npm consumers;
- there is no need for npm-specific install scripts, conditional artifact
  selection, or native packaging.

Publish to npm when:

- the primary ecosystem is Node/npm;
- consumers require package.json conditional exports;
- generated JavaScript/declaration artifacts are necessary;
- peer dependencies and framework package conventions are central;
- lifecycle scripts, native addons, platform binaries, or npm tooling are part
  of the product.

Dual-publish only when there is a real consumer need. It creates two release
contracts, two inclusion policies, and potential version drift.

## Dual-publication contract

A robust dual package usually separates:

```text
Deno / JSR
  source TypeScript entrypoints
  deno.json exports
  JSR publish include/exclude
  Deno-native documentation and examples

npm
  generated JavaScript and declarations, or verified source distribution
  package.json exports and conditions
  peer/optional dependencies
  files whitelist
  npm publish config
```

Require one release version source or an automated synchronization check.

Test each registry artifact independently. A source tree passing Deno tests does
not prove the packed npm tarball works.

## Publication inclusion

Deno publish observes repository ignore behavior unless publication config
explicitly includes or excludes paths.

Prefer an allowlist-like `publish.include` for security-sensitive packages:

```jsonc
{
  "publish": {
    "include": [
      "src/",
      "README.md",
      "LICENSE",
      "deno.jsonc"
    ]
  }
}
```

Use `exclude` when the package shape is broad but well controlled.

Never publish:

- `.env` files or credentials;
- internal fixtures containing customer data;
- large caches or generated diagnostics;
- unpublished design documents;
- local registry configuration;
- private keys or signing material;
- unnecessary tests and benchmarks if package size matters.

## `deno publish` workflow

Run at least:

```bash
deno fmt --check
deno lint
deno check
deno test
deno doc --lint ./src/mod.ts
deno publish --dry-run
deno publish --check=all --dry-run
```

Use `--check=all` when remote module diagnostics matter. Do not use
`--allow-dirty` as a routine release shortcut.

In CI, provenance is enabled by default in supported GitHub Actions publication
flows unless explicitly disabled. Preserve it unless there is a documented
reason not to.

Before the real publish:

- confirm the version does not already exist;
- review dry-run file inventory and diagnostics;
- verify repository state and tag policy;
- verify scope/package ownership and authentication;
- check changelog and migration notes;
- confirm all workspace packages intended for publication are versioned;
- confirm all internal packages have `publish: false`.

## Workspace publication

A workspace publish can consider every Deno member with `name` and `exports`.
This is convenient and dangerous.

Audit the candidate set before release:

```text
member:
name:
version:
exports:
publish true/false:
dependencies on sibling packages:
release order:
```

Deno rewrites workspace references to registry references when publishing. Still
test the result from a clean consumer fixture.

## Interdependent package release

For related packages:

1. determine whether versions are fixed or independent;
2. detect dependency cycles;
3. update dependency ranges intentionally;
4. dry-run all candidates;
5. publish dependencies before dependents when required;
6. install the published packages into a clean fixture;
7. exercise every documented export path;
8. verify source maps/docs/types as consumed, not merely as authored.

## Private npm publication

Private npm packages are governed by package.json and registry policy.

Example:

```json
{
  "name": "@acme/internal-sdk",
  "version": "2.3.0",
  "private": false,
  "publishConfig": {
    "registry": "https://registry.example.com/",
    "access": "restricted"
  },
  "files": ["dist", "README.md", "LICENSE"],
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  }
}
```

A root application or non-publishable npm package should use `private: true`. Do
not flip it to false without an explicit publication requirement.

Authentication belongs in `.npmrc` or CI secret configuration, never committed
inline in package metadata.

## npm package validation

Before npm publication:

- run the actual build;
- run `deno pack --dry-run` when the Deno project owns the npm package;
- create the tarball with `deno pack`, then inspect its exact contents;
- use the npm package manager's pack command when package.json-first tooling
  owns the npm artifact;
- install the tarball into a clean Node consumer;
- install or consume it with Deno when Deno compatibility is promised;
- test all `exports` conditions and subpaths;
- verify declaration paths;
- verify ESM/CommonJS behavior claimed by the package;
- verify peer dependency warnings;
- test supported runtime versions and platforms.

## Semver and breaking changes

Treat these as breaking unless the documented contract says otherwise:

- removing or renaming an export;
- making a formerly public deep path inaccessible;
- changing schema validation behavior;
- changing error classes/codes consumers inspect;
- adding required runtime permissions;
- introducing module-import side effects;
- dropping Deno/Node/runtime versions;
- changing ESM/CommonJS or conditional exports;
- changing peer dependency ranges incompatibly;
- moving from source distribution to generated artifacts or vice versa;
- changing resource ownership or cancellation semantics.

## Clean-consumer fixtures

Maintain small fixtures for supported consumers:

```text
fixtures/
  deno-jsr-consumer/
  deno-npm-consumer/
  node-esm-consumer/
  bundler-consumer/
```

Fixtures should install the packed or published artifact rather than importing
the repository source directly.

## Publication review checklist

- [ ] Registry and audience are explicit.
- [ ] Deno `exports` expose only supported modules.
- [ ] npm `exports` match actual packaged artifacts.
- [ ] Internal Deno members use `publish: false`.
- [ ] npm-private packages use `private: true`.
- [ ] Dry-run/pack inventory was reviewed.
- [ ] No secrets or private data are included.
- [ ] Public schemas, docs, and examples are current.
- [ ] Runtime permissions and side effects are documented.
- [ ] All supported consumers were tested from clean fixtures.
- [ ] Workspace references resolve after publication.
- [ ] Versioning and changelog match the compatibility impact.
