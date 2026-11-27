# Cross-runtime packaging

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Outcome](#outcome)
- [Start from consumers](#start-from-consumers)
- [Authority and artifact graph](#authority-and-artifact-graph)
- [Exports and entrypoints](#exports-and-entrypoints)
- [Build strategies](#build-strategies)
- [Types, source maps, and runtime semantics](#types-source-maps-and-runtime-semantics)
- [Package contents and assets](#package-contents-and-assets)
- [Executables and platform artifacts](#executables-and-platform-artifacts)
- [Clean-consumer matrix](#clean-consumer-matrix)
- [Failure signatures](#failure-signatures)
- [Deliberate exclusions](#deliberate-exclusions)
- [Executable verification](#executable-verification)
- [Sources and freshness](#sources-and-freshness)

## When to load this reference

Load this reference for npm/JSR publication, Deno-to-Node builds, library export
changes, workspace publication, binaries, templates, generated declaration
files, or bugs that appear only after packing/installing. It is also required
when source tests pass but consumers report missing modules, assets, types,
executables, or incompatible runtime behavior.

## Outcome

Create an artifact whose public contract is explicit and proven outside the
source workspace. A complete package decision covers:

- the authoritative source and version;
- every public root/subpath/condition and its runtime/type target;
- which files are bundled, transpiled file-to-file, copied, or generated;
- dependency externalization and runtime requirements;
- assets, licenses, notices, source maps, and executable permissions;
- supported runtimes, module systems, platforms, and package managers;
- the actual archive contents and unpacked size;
- installation, import, behavior, upgrade, and removal in clean consumers.

"The build passed" is not a packaging result. The package archive, registry
metadata, loader, and consumer form a connected contract.

## Start from consumers

Inventory intended consumers before selecting a builder.

| Consumer | Questions that change the artifact |
|---|---|
| Deno/JSR | Are source TypeScript and `jsr:` dependencies valid? Are exports declared in `deno.json`? |
| Node ESM | Do export conditions reach ESM files and declarations? What Node version is supported? |
| Node CommonJS | Is CJS truly required? Are dual-package state and default/named interop tested? |
| Bundler/browser | Are Node built-ins absent/conditional? Are side effects and browser assets correct? |
| Worker/edge | Are dynamic code loading, filesystem, sockets, and Node compatibility excluded or adapted? |
| CLI user | Does `bin` point to a published executable with a shebang and correct mode? |
| Framework adapter | Are peer dependencies and renderer/runtime versions compatible? |
| Type-only consumer | Do resolution modes find the same public graph as runtime resolution? |

Do not promise a runtime because the language transpiles. Search public source
for `Deno.*`, `node:` imports, native dependencies, dynamic `require`, filesystem
layout assumptions, environment reads, subprocesses, and bundler transforms.
Separate portable core from host adapters when the capability split is real.

## Authority and artifact graph

Prefer one authoritative implementation and generate only the distributions
that differ mechanically. Record the graph:

```text
source modules + public export inventory + version
  -> source-runtime package (for example JSR)
  -> Node package build
      -> ESM/CJS runtime files
      -> declarations and maps
      -> copied license/readme/changelog/assets
      -> package.json generated from explicit policy
  -> packed archives
  -> registry publications
```

One source does not mean one artifact can serve every host. It means behavioral
changes are authored once and transformation stages are deterministic. Each
artifact still needs independent verification.

Define one version source for a release: exact tag, validated release input, or
manifest. Propagate it into all generated manifests and `--version` output. Do
not read `latest` from a registry while building a release. Reject a mismatch
between tag, source manifest, generated package, and release notes before
publication.

Workspace ownership matters. Identify the nearest package manifest, workspace
root, catalog/override policy, internal dependency protocol, and publish order.
Internal packages may need concrete published versions in their packed manifests;
verify the archive rather than assuming the package manager rewrites them.

## Exports and entrypoints

Build the public export inventory before writing a build config.

```text
.
./unicode
./browser
./package.json       # only if intentionally public
./styles.css         # asset contract, if applicable
bin: tool
```

For every entry state:

- supported import spelling;
- runtime conditions (`import`, `require`, `browser`, `node`, `default`, or a
  project-specific condition);
- declaration target and resolution modes tested;
- source and output file;
- side effects and initialization behavior;
- required peers, assets, permissions, and platform restrictions;
- whether deep imports outside the map are deliberately blocked.

Example ESM-only package surface:

```json
{
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs"
    },
    "./unicode": {
      "types": "./dist/unicode.d.mts",
      "import": "./dist/unicode.mjs"
    }
  },
  "files": ["dist", "license", "readme.md"],
  "sideEffects": false,
  "engines": { "node": ">=20" }
}
```

This is a pattern, not a manifest to copy blindly. Export condition ordering,
extension, and declaration choices must match actual emitted files. Keep legacy
`main`, `module`, and `types` only when supported consumers need them and ensure
they agree with `exports`. `sideEffects: false` is a correctness assertion: do
not use it if importing a module registers behavior, CSS, polyfills, or globals.

Do not export an undocumented implementation file accidentally. Conversely,
documentation is not proof of an export. The attached Wikitext archive is a
counterexample: a README may mention a public capability that the root export
and implementation do not supply. Compare docs, export map, source entrypoint,
generated output, and packed archive.

## Build strategies

Select a builder by output semantics.

### Direct/source publication

Use source publication when the registry/runtime accepts the source graph and
the public code is already portable. Verify versioned dependencies, export maps,
publish includes/excludes, documentation examples, and registry dry-run. Source
publication does not remove the need for consumer tests.

### Deno-to-Node with dnt

`@deno/dnt` can transform a Deno source graph into a Node npm package, generate
entrypoint exports, rewrite dependencies, create declarations, add shims, and
run Node-oriented checks. The attached Undent `scripts/build_npm.ts` shows:

- explicit root and `./unicode` export entrypoints;
- clearing ignored output before building;
- no Deno shim because public source uses no Deno globals;
- both source and output typechecking;
- exclusion of Deno-native test dependencies from the Node graph, with Deno
  tests remaining authoritative and Node package behavior tested separately;
- generated package metadata, `sideEffects: false`, Node engine policy, and
  post-build copying of license/readme/changelog;
- release-version validation with semantic-version parsing.

An excluded test is a documented coverage transfer, not a free omission. State
which equivalent consumer/behavior check covers the generated artifact.

### unbuild and mkdist

Unbuild 3.6.1 supports inferred or explicit entries, Rollup-based bundles,
TypeScript declarations, multiple configs, sourcemaps, dependency checks,
development stubs, and `mkdist` file-to-file output. Choose intentionally:

- bundle when a compact runtime unit is desired and dependency edges are
  understood;
- `mkdist` when preserving module/subpath structure and per-file tree shaking
  matters;
- multiple configs only when they produce separately named/tested artifacts;
- `--stub` for local development, never as a release artifact.

```ts
import { defineBuildConfig } from "unbuild";

export default defineBuildConfig({
  entries: [
    "./src/index",
    { builder: "mkdist", input: "./src/runtime", outDir: "./dist/runtime" },
  ],
  outDir: "dist",
  declaration: "compatible",
  sourcemap: true,
});
```

At 3.6.1, unbuild's Rollup path, mkdist path, declaration modes, externals, and
hooks have different semantics. Inspect the pinned type declarations/config
resolution before using an option. Its README also marks `obuild` as an
experimental successor; do not migrate release infrastructure for speed alone.

## Types, source maps, and runtime semantics

Test declarations as a consumer under every supported resolver, not only by
typechecking source. Include NodeNext/Node16/bundler modes where promised.
Confirm:

- declarations reference published paths only;
- `.d.mts`, `.d.cts`, and `.d.ts` agree with runtime conditions;
- type-only exports are reachable and runtime exports are not phantom types;
- declaration maps/source maps point to included sources or intentionally
  omit sources;
- CJS default/named interop matches runtime behavior;
- generated code preserves error causes, URL/path behavior, Unicode, async
  cancellation, and other public semantics.

Bundling can duplicate singleton state or hide peer dependencies. Externalizing
everything can leave a consumer without a required runtime dependency. Classify
each dependency as bundled, runtime dependency, optional dependency, peer, or
development-only and test absence/presence behavior. Native packages require
platform/architecture/libc/ABI coverage and lifecycle-script policy.

## Package contents and assets

Use an allowlist (`files` or registry equivalent) and inspect the pack result.
Expected content often includes runtime output, declarations, maps if promised,
license/notices, README, changelog, templates, schemas, WASM/native assets, CSS,
and executable files. Reject:

- source secrets, `.env`, tokens, caches, databases, benchmark corpora, coverage,
  editor binaries, internal fixtures, release credentials, and unrelated docs;
- missing runtime-loaded templates, migrations, workers, WASM, native binaries,
  fonts, CSS, or schema files;
- absolute build paths and nondeterministic timestamps where reproducibility is
  claimed;
- output retained from a previous build.

Generate in a fresh directory. Record a sorted package-content manifest with
path, size, mode where relevant, and digest for release artifacts. Inspect both
compressed archive and unpacked installed form. Licenses of bundled/vendored
dependencies may require notices even when those packages are not visible as
runtime dependencies.

## Executables and platform artifacts

For npm `bin`, verify the target is included, starts with a portable shebang,
has executable permission in the tarball, resolves runtime dependencies, and
does not import a development stub. Run `--help`, `--version`, an error path,
stable stdout, cancellation, and install/uninstall through the packed artifact.

For `deno compile`, Node SEA, or native launchers, record runtime/tool version,
compile flags, embedded assets, environment assumptions, target triples, signing,
and checksums. Cross-compilation success does not prove target execution. Run on
each supported OS/architecture or narrow the support claim. A standalone binary
changes update, vulnerability, license, certificate, and removal responsibilities.

## Clean-consumer matrix

Create consumers outside the workspace with no link protocol, source alias,
root `node_modules`, or repository TypeScript configuration. Install the exact
tarball or registry version.

| Axis | Minimum proof |
|---|---|
| Runtime | each promised Deno/Node/browser/worker version line |
| Module | ESM and CJS only if each is promised |
| Resolver | relevant TypeScript and runtime resolution modes |
| Entry | every root/subpath/bin/asset import |
| Package manager | supported managers or one explicit authority |
| Lifecycle | fresh install, upgrade from previous supported version, uninstall |
| Behavior | representative public call and representative error |
| Host | framework/bundler adapter build when exported |

Example packed npm check:

```sh
npm pack --json
mkdir -p "$TMPDIR/package-consumer"
cd "$TMPDIR/package-consumer"
npm init -y
npm install /absolute/path/to/package-1.2.3.tgz
node --input-type=module -e 'import("package").then(m => console.log(Object.keys(m)))'
npm uninstall package
```

Use the repository's chosen package-manager adapter when testing manager-neutral
tooling, but preserve the consumer lockfile and exact commands as evidence.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Source tests pass, import fails after install | export target or file omitted | packed manifest and clean consumer |
| Types resolve but runtime fails | declaration/runtime graph mismatch | export conditions and emitted extensions |
| Runtime works, types fail under NodeNext | wrong declaration extension/path | resolver trace in clean TS consumer |
| One subpath contains stale code | output directory not cleared or unowned entry | clean build and output manifest |
| Package works only in monorepo | workspace alias/hoist/undeclared dependency | isolated install with empty cache |
| Browser bundle imports `node:` | host composition root leaked into public core | public graph and conditional export |
| CJS and ESM have different singleton state | dual package instantiated twice | conditional export design and tests |
| CLI installs but cannot execute | missing bin, shebang, mode, or runtime dependency | tar metadata and installed bin link |
| Registry packages have different behavior | independent generation/version drift | source/version authority and archive diff |
| Native install passes one runner only | missing platform/ABI coverage | artifact matrix and lifecycle logs |

## Deliberate exclusions

- Do not generate CommonJS merely because a builder supports it.
- Do not include source/tests/config by default to mask a missing runtime file.
- Do not bundle peers or native dependencies without an explicit ownership and
  license decision.
- Do not claim browser/edge support based only on types.
- Do not test through workspace symlinks as package verification.
- Do not publish first and inspect the package later; dry-run/pack locally and
  preserve the exact inspected artifact.
- Do not retain obsolete legacy fields or deep imports unless a measured
  compatibility commitment requires them.

## Executable verification

1. Build twice from separate clean directories and compare normalized manifests
   and artifact hashes.
2. Run registry dry-run/package pack and compare contents to an allowlist.
3. Assert version agreement across tag/input, source manifest, output manifests,
   executable `--version`, changelog, and archive name.
4. Import every public entry at runtime and typecheck it in clean consumers.
5. Execute representative behavior and error paths, not only `Object.keys`.
6. Test declared runtime/module/platform matrix and deliberate unsupported cases.
7. Scan archive for secrets, absolute paths, caches, internal fixtures, and
   unexpected executable/binary files.
8. Test install, upgrade, and uninstall without workspace links.
9. For dual registries, install each artifact and compare public behavior while
   respecting intended runtime differences.
10. Re-run from the exact release commit/tag with frozen dependencies.

## Sources and freshness

- Attached `undent.zip`, observed `scripts/build_npm.ts`, `deno.json`, CI and
  publish workflows; verified 2026-07-17.
- Attached `wikitext.zip`, observed export/documentation discrepancy used as a
  counterexample; verified 2026-07-17.
- Unbuild 3.6.1 published README, declarations, and package manifest; source
  record `unbuild-3-6-1`, verified 2026-07-17.
- Pkg-types 2.3.1 published declarations/implementation for package discovery,
  normalization, exports, workspaces, and cache behavior; source record
  `pkg-types-2-3-1`, verified 2026-07-17.
- Attached production CLI guidebook v1.1, normative package layout, Deno/Node,
  executable, and packed-consumer requirements; verified 2026-07-13.

Inspect the installed builder and package-manager versions before copying config.
The examples above are decision patterns, not evidence that a future version
emits the same filenames or supports the same options.
