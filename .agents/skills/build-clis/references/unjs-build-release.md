# UnJS build, release, content, and project-operation packages

## Contents

- Selection and ownership
- Versioned capability map
- unbuild package builds
- nypm package-manager operations
- Magicast source-preserving edits
- giget template acquisition
- changelogen release planning
- automd bounded generated regions
- rc9 user configuration
- std-env environment signals
- Integration sequences
- Failure signatures
- Verification
- Sources and freshness

## Selection and ownership

These packages solve different parts of a project operation. Do not collapse them
into one generic “UnJS tooling” abstraction.

| Need | Package owner | Keep outside the package |
|---|---|---|
| Build a publishable JS/TS library | unbuild | export policy, runtime support promise, release acceptance |
| Detect and invoke the repository package manager | nypm | authorization, operation plan, cancellation, manifest ownership |
| Edit static-ish JS/TS configuration while preserving nearby style | Magicast | semantic validation, consent, atomic write and rollback |
| Acquire a template or repository archive | giget | source trust, pinning, destination authority, post-extract verification |
| Derive changelog and semver intent from commits | changelogen | release approval, version authority, publication credentials |
| Regenerate owned Markdown regions | automd | human-authored prose and broad formatting |
| Read or write XDG user preferences | rc9 | project config discovery, secrets, application schema |
| Detect runtime/CI/TTY/agent hints | std-env | security policy, per-stream terminal state, repository ownership |

The exact APIs below were checked against published package declarations for the
versions named in each section. Inspect the target lockfile before copying them
into a repository with another version.

## Versioned capability map

| Package | Verified version | Public surface used here | Important version line |
|---|---:|---|---|
| unbuild | 3.6.1 | `defineBuildConfig`, Rollup/mkdist entries, declarations, stubs | README identifies obuild as an experimental successor; do not migrate by name alone |
| nypm | 0.6.8 | detection, install/add/remove/dedupe/run/dlx, command builders, `dry` | Current manager union includes npm, yarn, pnpm, bun, Deno, Aube, and nub |
| changelogen | 0.6.2 | config, git diff parsing, Markdown generation, semver decision, GitHub release helpers | Release/publish CLI paths mutate Git, manifests, tags, and registries |
| automd | 0.4.3 | `transform`, `automd`, `defineGenerator`, config resolution | Generated blocks are marker-owned; this is not a Markdown formatter |
| giget | 3.3.0 | `downloadTemplate`, providers, registry provider, offline/cache modes | Glob-string `ignore` depends on Node `path.matchesGlob` support |
| magicast | 0.5.3 | `loadFile`, `writeFile`, `parseModule`, `generateCode`, `builders` | Static-ish syntax only; helpers are experimental and may move |
| rc9 | 3.0.1 | parse/read/write/update plus XDG user-config variants | `readUser`/`writeUser`/`updateUser` are deprecated |
| std-env | 4.2.0 | runtime/provider/agent detection and environment flags | Many exported constants are evaluated once at module initialization |

## unbuild package builds

unbuild owns transformation into a package distribution. It does not decide
which entrypoints are public or whether the packed package works in every stated
runtime.

```ts
// build.config.ts -- unbuild 3.6.1
import { defineBuildConfig } from "unbuild"

export default defineBuildConfig({
  entries: [
    "./src/index",
    {
      builder: "mkdist",
      input: "./src/runtime/",
      outDir: "./dist/runtime",
    },
  ],
  outDir: "dist",
  declaration: "compatible",
  sourcemap: true,
  rollup: {
    emitCJS: false,
  },
})
```

`declaration: "compatible"` emits the compatibility declaration set described
by 3.6.1; `"node16"`, `true`, `false`, and auto-detection have different output
contracts. Match `package.json` `exports`, `main`, `module`, and `types` to files
that the build actually emits.

Use builder entries deliberately:

- Rollup bundles entry graphs and can emit declarations.
- mkdist preserves a file-oriented source structure while transpiling.
- copy moves reviewed assets.
- untyped generates schema/default/documentation artifacts.

`unbuild --stub` is a development convenience powered by jiti. Never publish a
stubbed `dist`; run a clean non-stub build before packing. Watch mode is marked
experimental in 3.6.1.

Verification must cross the package API:

```sh
rm -rf dist
npx unbuild
npm pack --dry-run
```

Then install the real tarball in clean ESM and, if promised, CommonJS consumers.
Test every export condition, declaration path, subpath, asset, side effect, and
runtime. A successful source test does not prove the packed graph.

## nypm package-manager operations

nypm translates one operation into the selected package manager. Keep detection,
planning, authorization, execution, and verification separate.

```ts
// nypm 0.6.8
import {
  addDependency,
  detectPackageManager,
  type PackageManager,
} from "nypm"

export async function planAdd(
  cwd: string,
  names: readonly string[],
): Promise<{ manager: PackageManager; command: string; args: string[] }> {
  const manager = await detectPackageManager(cwd, {
    includeParentDirs: false,
  })
  if (!manager) throw new Error("Package manager ownership is unresolved")

  const result = await addDependency([...names], {
    cwd,
    packageManager: manager,
    dry: true,
  })
  if (!result.exec) throw new Error("nypm did not produce an executable plan")
  return { manager, ...result.exec }
}
```

Display the exact plan through the CLI result channel, obtain the required
authority, then call the same operation without `dry`. Re-read the manifest and
lockfile afterward. Use `workspace` only after resolving which workspace owns the
dependency.

The 0.6.8 API also exports `installDependencies`, `addDevDependency`,
`removeDependency`, `dedupeDependencies`, `runScript`, `dlx`, and command-string
builders. Important constraints:

- detection checks `packageManager`, `devEngines.packageManager`, then known
  files/lockfiles; it does not decide which manifest should own a dependency;
- `includeParentDirs` can cross a package API, so default it deliberately;
- `dedupeDependencies({ recreateLockfile: true })` may replace a lockfile;
- the published README states Bun and Deno dedupe may remove the lockfile and
  reinstall all dependencies;
- `dlx` downloads and executes code;
- the public operation options do not expose an `AbortSignal` in 0.6.8. If hard
  cancellation is required, own the subprocess handoff rather than claiming
  nypm propagates the root signal.

## Magicast source-preserving edits

Use Magicast when the owned input is static-ish JavaScript or TypeScript and a
targeted AST edit preserves more human structure than serializing a new file.

```ts
// magicast 0.5.3
import { generateCode, loadFile } from "magicast"

const module = await loadFile<{ default: { integrations?: string[] } }>(
  "project.config.ts",
)
module.exports.default.integrations ??= []
module.exports.default.integrations.push("telemetry")

const preview = generateCode(module).code
// Validate preview, show a diff, and write atomically only after authorization.
```

For an authorized direct write, 0.5.3 exports `writeFile(module, filename)`. The
core/browser-safe subpath exposes parsing/generation without filesystem helpers:

```ts
import { generateCode, parseModule } from "magicast/core"

const module = parseModule("export default defineConfig({})")
const options = module.exports.default.$type === "function-call"
  ? module.exports.default.$args[0]
  : module.exports.default
options.features = ["audit"]
const output = generateCode(module).code
```

Do not invent `createNode`: the published 0.5.3 README mentions it in one import
example, but the 0.5.3 declaration export list does not contain it. Use verified
`builders`, or stop and inspect the installed declarations. Treat
`magicast/helpers` as experimental; its README says helpers may move.

Magicast cannot safely represent every dynamic program. Computed exports,
conditional mutation, spread-heavy structures, generated code, or unfamiliar
callee shapes require a refusal/manual path. Catch parse/shape failures, preserve
the original, and provide a concrete manual edit. Semantic validation after
generation is still mandatory.

## giget template acquisition

Download into a fresh staging directory, not the final project directory.

```ts
// giget 3.3.0
import { downloadTemplate } from "giget"

const result = await downloadTemplate(
  "gh:acme/service-template#6f1c2f5",
  {
    cwd: stagingRoot,
    dir: "candidate",
    registry: false,
    install: false,
    force: false,
    preferOffline: true,
    ignore: ["pnpm-lock.yaml", "package-lock.json"],
  },
)
```

Pin a tag or commit for reproducible scaffolding. Registry slugs and default
branches are discovery conveniences, not immutable identities. Record the
normalized `source`, resolved version/ref, archive checksum when available, and
template license.

Security and authority rules:

- `forceClean` recursively removes the destination and is destructive;
- `force` permits extraction into an existing directory and can overwrite;
- `install` delegates dependency installation to nypm and executes package
  manager behavior after extraction;
- `auth`/`GIGET_AUTH` is a secret; redact it and do not place it in a result;
- a custom `TemplateProvider` or registry controls tar URL and headers; allowlist
  protocols/hosts and bound size/time;
- inspect extracted paths, symlinks, scripts, hooks, binary files, and manifests
  before merging into the target;
- string-glob `ignore` requires the Node versions documented by 3.3.0; use the
  callback form or verify runtime support elsewhere.

Offline mode means “use cached content only”, not “prove cached content is the
expected release”. Bind cache entries to the pinned source identity and checksum.

## changelogen release planning

Use the programmatic read/generate APIs to produce a reviewable release plan
before any version, commit, tag, push, GitHub release, or registry mutation.

```ts
// changelogen 0.6.2
import {
  determineSemverChange,
  generateMarkDown,
  getGitDiff,
  loadChangelogConfig,
  parseCommits,
} from "changelogen"

const config = await loadChangelogConfig(cwd, {
  from: "v1.4.0",
  to: "HEAD",
  output: false,
})
const raw = await getGitDiff(config.from, config.to, cwd)
const commits = parseCommits(raw, config)
const markdown = await generateMarkDown(commits, config)
const bump = determineSemverChange(commits, config)
```

Review commit classification, breaking changes, scope mapping, excluded authors,
repository links, prerelease policy, and zero-major semantics. Generated release
notes are evidence to review, not release truth.

CLI concerns are materially different:

- plain `changelogen` can generate/output notes;
- `--bump` updates version and changelog state;
- `--release` can create a commit and tag;
- `--push` publishes Git changes;
- `--publish` publishes to npm;
- GitHub release sync can create or update remote releases.

Do not combine these under one implicit “release” confirmation. Require clean
worktree/preflight evidence, explicit targets and versions, credential checks,
package verification, then separate authorization for irreversible external
steps. Never log provider tokens from config or environment.

## automd bounded generated regions

automd owns only explicit marker regions:

```md
<!-- automd:package-list scope="public" -->
generated content
<!-- /automd -->
```

Preview one document without writing it:

```ts
// automd 0.4.3
import { transform } from "automd"

const result = await transform(source, {
  dir: repositoryRoot,
})
if (result.hasIssues) throw new Error("automd reported generator issues")
const preview = result.contents
```

For repository-owned generation, `automd({ input, output, ignore, generators })`
returns per-file results and an optional `unwatch`. `defineGenerator` registers a
named generator with a `generate(context)` function. Keep custom generator input
schemas explicit and deterministic.

Never run automd as permission to rewrap, reorder, or reformat surrounding human
prose. Verify that bytes outside marker ranges are unchanged. Remote fetch
generators introduce network, pinning, trust, and reproducibility requirements.
Watch mode needs an explicit shutdown owner.

## rc9 user configuration

Use rc9 for small user-scoped RC preferences, not as a replacement for c12
project configuration.

```ts
// rc9 3.0.1
import { readUserConfig, updateUserConfig } from "rc9"

type UserPreferences = {
  color?: "auto" | "always" | "never"
}

const current = readUserConfig<UserPreferences>({ name: ".projectrc" })
const updated = updateUserConfig<UserPreferences>(
  { ...current, color: "never" },
  { name: ".projectrc" },
)
```

`readUserConfig` and related methods use `$XDG_CONFIG_HOME` or
`$HOME/.config`. The older `readUser`/`writeUser`/`updateUser` names are
deprecated in 3.0.1.

rc9 uses dotted-key flatten/unflatten behavior by default and destr-like native
value conversion. `count=123` becomes a number; quote a value when the domain
requires a string. Conflicting `x=` and `x.y=` keys require deliberate handling;
`flat: true` disables unflattening. Validate the result with the application
schema. Do not store long-lived secrets merely because the path is user-scoped,
and do not assume rc9 writes are atomic or permission-hardened without verifying
the implementation and filesystem result.

## std-env environment signals

std-env provides portable hints:

```ts
// std-env 4.2.0
import {
  hasTTY,
  isCI,
  isMinimal,
  providerInfo,
  runtime,
} from "std-env"

const environment = { runtime, isCI, isMinimal, hasTTY, providerInfo }
```

Use `runtime === "node"` for strict Node detection. In Node-compatible Deno or
Bun, `isNode` can also be true. `hasTTY` describes stdout; prompts still need
stdin and stderr checks. `isMinimal` is a composite hint affected by CI, test,
TTY, and `MINIMAL`; it is not user consent.

Most exported flags are snapshots evaluated during module initialization.
`detectProvider()` and `detectAgent()` rerun those specific detections, but do
not mutate all exported constants. Never use runtime/provider/agent detection as
an authorization or security trust transition.

## Integration sequences

### Reviewable dependency installation

```text
Optique parses semantic dependency/workspace terms
  -> repository evidence selects the owning manifest
  -> nypm detects the package manager
  -> nypm dry mode produces exact command and args
  -> LogTape result channel presents the plan
  -> authorization permits apply
  -> manifest and lockfile are re-read and checked
```

### Safe scaffold

```text
pinned giget source -> fresh staging directory -> archive/source record
  -> inspect paths, manifests, scripts, licenses, and generated files
  -> Magicast previews bounded config edits if needed
  -> nypm dry plan -> authorized dependency install
  -> repository checks and packed/build artifact verification
  -> merge reviewed files into target
```

### Release

```text
clean source -> unbuild clean build -> pack/install consumer tests
  -> changelogen read-only plan -> reviewed version and notes
  -> authorized manifest/changelog update -> repeat build and tests
  -> separate commit/tag/push/publish authorization
  -> registry/install verification and release record
```

## Failure signatures

| Signature | Likely cause | Required correction |
|---|---|---|
| package works from source but import fails after publish | unbuild output and export map disagree | inspect tarball and clean consumer resolution |
| linked development works but package contains jiti stubs | `unbuild --stub` was packed | clean non-stub build before pack |
| dependency added to wrong workspace | nypm manager detection was mistaken for manifest ownership | resolve workspace owner before apply |
| cancellation leaves package manager running | nypm API has no signal in the pinned surface | own a cancellable subprocess handoff |
| config edit drops comments or throws on access | Magicast input is outside supported static-ish shape | preserve original and use manual/specialized AST path |
| scaffold deletes existing project | `forceClean` used without destination authority | stage in new directory and prohibit implicit deletion |
| cached template is stale or malicious | offline cache not bound to source digest | pin and verify source/checksum |
| generated changelog chooses wrong bump | commit convention/scope/zero-major policy mismatch | review parsed commits and explicit version |
| Markdown diff rewrites prose | automd run escaped marker ownership | assert bytes outside markers unchanged |
| RC token changes type | rc9 native parsing converted an unquoted value | quote and validate domain string |
| prompt runs in CI | `hasTTY` or `isMinimal` treated as complete interaction policy | inspect stdin/stdout/stderr and explicit noninteractive mode |

## Verification

1. Pin package versions and inspect their declarations in the target lockfile.
2. Run nypm mutation APIs in `dry` mode and snapshot exact manager/command/args.
3. Run Magicast and automd against adversarial fixtures; assert unowned bytes are
   unchanged and invalid shapes fail without writes.
4. Download giget templates into isolated temporary directories; test pinned,
   offline, private, invalid archive, symlink, traversal, overwrite, and size
   cases.
5. Build with unbuild, inspect the tarball, install it in clean consumers, and
   execute every public export/runtime promise.
6. Generate changelog/version plans from fixed Git histories before testing any
   mutation command in an isolated remote/registry.
7. Test rc9 with XDG overrides, dotted-key collisions, quoted/native values,
   permissions, interrupted writes, and corrupted files.
8. Test std-env under Node, Deno compatibility, CI, no-TTY, and per-stream
   redirection; do not snapshot only one developer shell.

## Sources and freshness

Primary sources inspected 2026-07-17:

- published npm package declarations and READMEs for unbuild 3.6.1, nypm 0.6.8,
  changelogen 0.6.2, automd 0.4.3, giget 3.3.0, magicast 0.5.3, rc9 3.0.1,
  and std-env 4.2.0;
- official repositories under <https://github.com/unjs>;
- Historical CLI manifests and lockfile, reviewed 2026-07-17 and represented
  here by anonymized examples. A lockfile entry does not prove active use.

The npm tarball URLs and integrity values are recorded in `evals/sources.json`.
Recheck installed declarations before using a different version. In particular,
unbuild internals, Magicast helpers, changelogen release behavior, giget provider
and runtime options, and std-env provider lists are version-sensitive.
