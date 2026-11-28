# Mise and Aube toolchain architecture

## Contents

- Status and ownership
- Mise configuration and trust
- Mise tools, backends, and lockfiles
- Mise tasks and freshness
- Mise environments and secrets
- Aube package-manager model
- Existing lockfiles and migration
- Aube workspaces, catalogs, and deploys
- Dependency builds and the jail
- Runtime and Mise integration
- CI, offline, and proxy operation
- Adoption and rollback
- Failure signatures
- Verification
- Sources and freshness

## Status and ownership

Mise and Aube are complementary tools maintained in the jdx ecosystem. They do
not own the same state.

| Concern | Mise owner | Aube owner | Repository owner that remains authoritative |
|---|---|---|---|
| developer tool versions | `[tools]`, backends, `mise.lock` | may consume a Node runtime policy | runtime/package manifests when another tool already owns them |
| shell environment | `[env]`, environment overlays, activation | npm-compatible environment during scripts | secret manager and deployment platform |
| repository tasks | `[tasks]` or file tasks | `package.json` scripts through `aube run`/`aubr` | one canonical task graph selected by the repository |
| JS dependency graph | no | package manifest, supported lockfile, store, linker | `package.json` and the selected lockfile |
| dependency lifecycle scripts | no | explicit build approval and optional jail | reviewed policy in workspace config |
| workspace selection | Mise task graph and monorepo roots | package graph filters and catalogs | workspace manifests and package declarations |
| publication payload | may invoke/check tasks | pack, publish, deploy | package export/files policy and release workflow |

Do not create Mise tasks that secretly differ from package scripts or Deno tasks.
A Mise task can be the canonical owner or a thin adapter, but the choice must be
visible in help, CI, and documentation.

Do not introduce Aube merely because it can read an existing lockfile. First
classify the current package-manager owner, CI/runtime constraints, lifecycle
scripts, native dependencies, linker assumptions, workspace filters, Corepack or
`packageManager` policy, and rollback requirement.

## Mise configuration and trust

Mise configuration is hierarchical. A nearer `mise.toml` can override values
from a parent, user, or system scope. Environment-specific configuration and
idiomatic version files add more inputs. Before editing, inspect the resolved
configuration, not one file in isolation:

```sh
mise config ls
mise config get
mise ls --current
mise doctor
```

Record which file owns each tool, environment value, setting, and task. In a
monorepo, state whether subprojects inherit root tools and whether the root is
marked as the monorepo root.

Set a minimum Mise version when configuration uses newer semantics:

```toml
min_version = { hard = "2026.7.0", soft = "2026.6.0" }
```

Choose the real compatibility requirement rather than copying this version.

Mise requires trust before executing configuration in an untrusted project.
Treat this as a code-execution trust transition: configuration can install tools, render
templates, load environment values, and run tasks. Do not globally trust an
arbitrary checkout merely to make automation green. CI should install from the
reviewed revision and use an explicit trust policy.

Idiomatic version files such as `.node-version`, `.python-version`, `.nvmrc`,
`rust-toolchain.toml`, and `package.json` can preserve interoperability with
other tools. Current Mise disables general idiomatic-file discovery by default;
enable only the required tool names. Decide whether an idiomatic file or
`mise.toml` owns each version. Two active owners can resolve differently.

## Mise tools, backends, and lockfiles

Example:

```toml
[tools]
deno = "2.9"
node = "24"
"aqua:astral-sh/uv" = "0.8"
aube = "1.27"

[settings]
lockfile = true
```

Mise supports core tools and multiple backends. Current registry policy prefers
direct, security-aware backends such as Aqua or GitHub for many standalone
tools. A registry shorthand can change backend over time; use an explicit
backend when that identity is part of the reproducibility or security contract.
Language-package backends such as npm/pipx/gem can bind the installed tool to
whatever language runtime was active. Make that dependency explicit.

Custom plugin URLs are executable supply-chain inputs. Pin a Git reference where
supported, verify the plugin type, and review hook behavior. Do not treat an asdf
or vfox plugin as equivalent to a signed standalone release solely because both
install a command with the same name.

`mise.lock` can pin resolved URLs and checksums. Current Mise can also record
verified provenance for supported backends. Run lock generation on every target
platform needed by CI or release, because cross-platform entries may be derived
from metadata without downloading and verifying that platform artifact.

```sh
mise lock
mise install --locked
mise ls --current
```

A loose declaration such as `node = "24"` is not reproducible by itself. If the
project promises identical versions, commit and enforce the lockfile. If it
intentionally follows latest compatible releases, state that update policy and
test upgrades rather than claiming a pin.

## Mise tasks and freshness

Tasks can live in `mise.toml` or executable files under configured task
directories. For repository commands, prefer **small executable shell file
tasks** when no explicit multi-command dependency graph is needed. A file task
under `.mise/tasks/` can use an extensionless filename and Bash shebang (but should generally prefer `.sh` extensions for clarity):

```bash
#!/usr/bin/env bash
set -euo pipefail
exec deno test services/accounts
```

The repository's selected command is illustrative. A task normally picks one
real tool or focused project CLI; it does not implement the operation, parse a
new command language, or dispatch another bespoke task graph. When order or
parallel dependencies matter, declare them through Mise's own task model.
Keep substantial reusable TypeScript logic in the owning package or a
project-owned CLI. Do not grow `.mise/lib/` or a parallel `scripts/` tree into
another application/runtime merely because Mise calls it. Keep a TS/MJS (prefer TS files over MJS, but generally stick to `.sh` files)
file only when its selected host requires it.

File tasks retain language-aware editor support and can work for non-Mise
users. Their `#MISE` or `# [MISE]` directives are syntax: a formatter that
changes them may silently remove task metadata.

```toml
[tasks.check]
description = "Run the repository quality gate"
depends = ["generate:check"]
run = [
  { task = "lint" },
  { tasks = ["typecheck", "test"] },
]

[tasks."generate:check"]
run = "deno run --allow-read tools/generate.ts --check"
sources = ["schemas/**/*.ts", "tools/generate.ts"]
outputs = ["generated/manifest.json"]
tools.deno = "2.9"
```

Important task properties include:

- `run`, `run_windows`, `file`, and `shell` for execution;
- `depends`, `depends_post`, and `wait_for` for graph order;
- structured task references with arguments and environment overrides;
- `tools`, `env`, `dir`, and `usage` for an execution scope;
- `sources` and `outputs` for freshness and watch behavior;
- `timeout`, `confirm`, `hide`, `quiet`, `silent`, `raw`, and `interactive` for
  control and output behavior.

`depends` can run concurrently. Do not put order-dependent mutations in sibling
dependencies. `confirm` protects the task's own run body, not dependencies that
execute first. Put authorization before side effects, or represent the guarded
action as an explicit task call after confirmation.

`sources`/`outputs` use freshness rules, not semantic content equality. Generated
artifact checks still need deterministic check mode and a content comparison.
Glob breadth affects scan time; exclusions and downstream invalidation must be
tested. An automatically tracked output stamp proves the task ran, not that a
declared artifact exists or is valid.

`raw` and `interactive` alter I/O scheduling. Prefer `interactive` for exclusive
terminal ownership. Raw output can break parallel presentation and bypass
redaction. Stable machine-readable output should normally come from the called
tool, not Mise's progress UI.

Before adding a permanent script or test launcher, trace `mise -> leaf command`
and the same command in CI. Name the actual user-facing operation and specific
failure it protects. The presence of a `scripts/` directory, package script,
Python driver, or imported `.mise/lib/` module is not proof that a second owner
is required. Remove redundant layers after all consumers move.

## Mise environments and secrets

Mise can construct environment variables from config, dotenv files, templates,
paths, and environment-specific overlays. Classify values as public defaults,
developer-local values, or secrets. Do not commit credentials because Mise can
load them.

Use redaction declarations for task output, then verify the CI system also masks
the values. Mise redaction is line-oriented and does not apply to raw task I/O.
Secrets can still leak through child tools, command arguments, debug logs,
artifacts, or structured output.

Activation mutates the interactive shell. `mise exec -- command` or task-local
tools often produce a clearer CI environment than relying on shell startup files.
Shims do not provide every activation feature. Test the selected mode in clean
shells on supported platforms.

## Aube package-manager model

Aube is a versioned Node.js package manager, not a generic task helper. As of the
2026-07-17 source review, the public npm package is `@endevco/aube` and the
current release is 1.27.0. Commands include `aube`, `aubr` (`aube run`), and
`aubx` (`aube dlx`). Verify the current release before pinning.

Aube uses an isolated `node_modules` layout by default, a content-addressed
global store, and `node_modules/.aube/` for its virtual store. Only declared
dependencies should be relied on; a hoisted linker can hide undeclared phantom
dependencies. Test packages under the selected linker.

Routine commands check install freshness before running:

```sh
aubr build
aube test
aube exec vitest
aubx cowsay hello
```

This auto-install behavior is a contract, not always an advantage. In hermetic
CI, long-lived development processes, offline operation, or commands that must
never mutate the dependency tree, choose the documented frozen/no-install or
verification policy deliberately. `aubeNoAutoInstall` and
`verifyDepsBeforeRun` change behavior; inspect the current settings reference
before using them.

## Existing lockfiles and migration

Aube can read and update supported pnpm, npm, Yarn, and Bun lockfiles in place.
That enables a reversible trial without a lockfile conversion. It does not prove
that resolution, peer behavior, patches, lifecycle scripts, linker layout, and
platform filtering match the current package manager.

Safe adoption order:

1. pin and install Aube without deleting the existing package manager;
2. run an install using the existing committed lockfile;
3. compare lockfile diff and resolved graph;
4. test scripts, binaries, native builds, patches, peers, workspace filters,
   package packing, deployment, and clean consumers;
5. keep the old command working during the trial;
6. convert to `aube-lock.yaml` only as a separate explicit migration;
7. remove the old lockfile only after the new owner passes CI and rollback is
   documented.

Never keep two writable lockfiles for one dependency graph. During coexistence,
one committed lockfile remains authoritative and both tools must operate on it.

CI should use frozen behavior and fail on manifest/lock drift. Docker builds
should separate the dependency layer without assuming that a later `aubr`
command may rewrite the lockfile or contact the registry.

## Aube workspaces, catalogs, and deploys

Aube discovers workspaces from `aube-workspace.yaml` and can consume an existing
`pnpm-workspace.yaml`. The file is an ownership handoff for package globs,
catalogs, lifecycle-build policy, and several settings.

```yaml
packages:
  - "packages/*"
  - "apps/*"

catalog:
  zod: ^4.0.0

catalogs:
  test:
    vitest: ^3.0.0
```

Workspace protocol declarations remain in each consumer manifest. Publishing
or deploy flows rewrite them to concrete versions. Verify the packed manifest,
not only the source declaration.

Filters can address exact names, globs, paths, dependency/dependent graphs, Git
changes, and exclusions. Validate a filter with a dry list before running a
mutation or publication. Recursive execution must respect dependency order,
failure propagation, concurrency, and output clarity.

`aube deploy` creates a deployable package tree and installs its dependencies.
Its file selection is tied to pack semantics unless `deployAllFiles` is chosen.
Do not use `deployAllFiles` to compensate silently for an incorrect package
payload; determine whether the missing file belongs in publication, deployment
only, runtime generation, or an external artifact.

Catalog modes change how `aube add` writes manifest ranges. A strict catalog can
prevent drift, but named catalogs are not automatically selected. Verify every
workspace consumer and the resulting lockfile.

## Dependency builds and the jail

Aube does not run dependency lifecycle scripts unless they are approved. Root
project scripts are a separate policy. Current approval data uses `allowBuilds`;
legacy pnpm/Bun allow and deny inputs can also affect the result. Review the
resolved policy rather than assuming one key is the only owner.

```yaml
allowBuilds:
  esbuild: true
  sharp: true
  unreviewed-native-package: false

jailBuilds: true
jailBuildPermissions:
  sharp:
    env: [SHARP_DIST_BASE_URL]
    write: ["~/.cache/sharp"]
```

Build approval answers whether a script may run. The jail limits what an
approved script can access. As of this review, jail behavior is platform
dependent, `jailBuilds` is not yet the default, and Windows isolation differs
from Linux/macOS. Grant the narrowest package-specific permissions and test the
actual native build. Do not use a broad exclusion merely to make install pass.

Security checks, minimum release age, trust policy, registry authentication,
proxies, certificates, offline caches, and advisory behavior are connected.
Treat registry tokens and custom CAs as secrets; do not embed them in shared
workspace files or diagnostic output.

## Runtime and Mise integration

Aube can use project runtime declarations and can delegate runtime installation
to Mise. Mise can also install Aube itself. Avoid an infinite or ambiguous owner
loop:

```text
Mise installs the pinned Aube executable
  -> Aube validates project packageManager/devEngines policy
  -> one selected owner installs Node
  -> Aube resolves and links JS dependencies
  -> Mise or package scripts invoke canonical tasks
```

Choose whether Node is installed by Mise or Aube and set fallback behavior. An
air-gapped CI environment should error rather than download an unexpected
runtime. Aube's package-manager version switching and Mise's tool pin must agree;
otherwise the first Aube process can re-exec another version.

## CI, offline, and proxy operation

Verify at least:

- clean install with empty project store and cache;
- warm install with the expected store reuse;
- frozen install with no manifest or lockfile mutation;
- offline install from a deliberately prepared cache/store;
- authenticated registry and scoped registry behavior;
- HTTP(S) proxy and custom CA behavior if supported;
- all target OS/architecture/libc optional dependencies;
- approved native builds under the actual jail policy;
- workspace filters and recursive task failure;
- packed and deployed clean consumers;
- uninstall/rollback to the prior package manager.

Do not quote benchmark numbers from another machine as a project result. Protect
correctness, install security, disk use, cold and warm behavior, and routine
script latency as separate metrics.

## Adoption and rollback

Use a staged decision:

1. inventory versions, config scopes, manifests, lockfiles, scripts, workspaces,
   registries, native builds, CI, editors, and deployment;
2. assign one owner per concern;
3. pin Mise/Aube and record supported platforms;
4. add a read-only or existing-lockfile trial;
5. compare graphs, artifacts, and real workflows;
6. enable stricter security/frozen policies explicitly;
7. migrate task or lock ownership separately;
8. retain a rollback command until a clean clone and release pass;
9. remove redundant wrappers and stale configuration only after reachability
   searches and CI verification.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| local task passes but CI fails | different config scope, shell activation, tool version, working directory, or auto-install policy | `mise config ls`, task trace, clean CI shell, Aube frozen logs |
| lockfile changes on routine test | auto-install found manifest drift or two writers own the graph | Aube state, package manifest diff, lock owner, `verifyDepsBeforeRun` policy |
| package works only with hoisting | undeclared dependency or peer/linker assumption | isolated linker, `aube why`, manifest and peer declarations |
| native package is present but unusable | build script was unapproved, jailed without required permission, or incompatible platform artifact selected | ignored/approved builds, jail diagnostics, package build output |
| secrets appear in task output | raw I/O or child tool bypassed Mise redaction | task output mode, CI masking, process arguments and diagnostic sink |
| task skips despite invalid output | timestamp freshness or auto stamp was treated as semantic validation | declared outputs, generator check mode, artifact validator |
| subproject resolves wrong runtime | hierarchical config or idiomatic file introduced a second owner | resolved Mise config and version-source inventory |
| Aube re-execs unexpectedly | `packageManager`/`devEngines` pin disagrees with Mise-installed Aube | package manager version policy and runtime installer setting |
| deploy lacks runtime file | pack selection excludes it or file belongs to another artifact owner | `aube pack`/deploy contents and package `files`/ignore rules |
| offline claim fails | cache/store was not fully prepared or tool/runtime installer still needs network | cold trace, registry requests, Mise/Aube download policy |

## Verification

Run commands appropriate to the selected ownership; do not copy all commands
blindly:

```sh
mise doctor
mise config ls
mise ls --current
mise tasks
mise run check
mise lock
mise install --locked

aube install
aube list --depth 0
aube why <package>
aube ignored-builds
aube pack
```

Then perform clean-clone, frozen, offline, native-build, workspace-filter,
package-consumer, deploy, and rollback scenarios. Record exact versions,
platform, lockfile before/after digest, store/cache state, commands, exit codes,
and artifact contents.

## Sources and freshness

- Mise configuration, tools/backends, lockfile/provenance, tasks, environment,
  and security documentation at https://mise.jdx.dev/, verified 2026-07-17.
- Aube getting-started, configuration, workspaces, lifecycle scripts, security,
  and settings documentation at https://aube.jdx.dev/, verified 2026-07-17.
- `@endevco/aube` npm metadata, version 1.27.0 observed 2026-07-17.

Both tools evolve quickly. Recheck exact option names, defaults, backend policy,
lockfile support, jail behavior, and installed versions before applying this
manual. Examples illustrate current ownership and failure contracts; the
repository's installed version and generated help remain authoritative.
