# Deno command reference

Use this file to confirm command **intent**, not to guess version-sensitive flags. Always inspect `deno help <command>` or current official documentation for the repository's Deno version before editing scripts, permissions, or publishing instructions.

The repository task layer can intentionally wrap Deno commands. Read the task definition before replacing it with a direct command.

## Discover the project first

Start with runtime and task discovery:

```sh
deno --version
deno task
deno info
```

Then inspect:

```text
deno.json / deno.jsonc
package.json
workspace metadata
deno.lock
mise.toml and .mise/tasks/
CI workflows
package exports
import maps
JSR/npm publish configuration
```

The presence of Deno does not mean every task is Deno-only. Some repositories use Deno as the primary runtime while keeping Node/browser compatibility.

## Formatting

Typical commands:

```sh
deno fmt
deno fmt --check
```

Prefer repository tasks when they intentionally select file scopes or generated exclusions. Do not run repository-wide formatting for a focused functional patch if it would create unrelated mechanical churn.

## Linting

```sh
deno lint
```

Inspect configured rules and exclusions. A lint pass does not replace type checking or runtime tests.

## Type checking

```sh
deno check <entrypoint>
```

Check public entrypoints and runtime-specific subpaths that the package claims to support. For libraries with important generic inference, compile dedicated consumer fixtures as well. A source entrypoint type check may not exercise declaration/export inference from the consumer side.

## Testing

Deno can execute both Deno-native tests and Node-compatible `node:test` suites. For Deno-first portable package tests, this collection defaults to:

```ts
import { describe, it } from "node:test";
import { expect } from "@std/expect";
```

Run with the repository's Deno task or direct `deno test` as configured. Add runtime-specific tests for Deno APIs, browser workers, Node APIs, Bun APIs, OPFS/WebCodecs, or other capability-specific behavior.

Common command:

```sh
deno test
```

Permissions supplied to tests are part of the test contract. Avoid broad `-A` unless the repository intentionally uses it.

## Benchmarks

```sh
deno bench
```

Many Okikio repositories prefer Mitata for cross-runtime benchmark suites. Use the repository-selected benchmark owner. Benchmark correctness, workloads, baselines, and output interpretation matter more than which runner starts the process.

## Running programs

```sh
deno run [permissions] path/to/entry.ts
```

Permissions are application behavior. Reproduce the least privilege that the actual service/CLI uses. A command that works only after widening to `-A` has exposed a permissions/configuration problem, not a successful fix.

## Tasks

```sh
deno task
deno task <name>
```

Read the task definition before using the task result as evidence. A task named `check` may omit browser tests, generated-artifact freshness, packaging, or clean-consumer verification.

Tasks are useful as repository policy because CI, contributors, and agents can invoke the same named workflow. Avoid duplicating task logic in multiple shells unless another environment genuinely needs a different entrypoint.

## Dependency graph and metadata

Useful families include:

```sh
deno info <specifier>
deno outdated
deno add <package>
deno remove <package>
```

Confirm the intended manifest/protocol before mutating dependencies. A hybrid workspace can deliberately use `jsr:`, `npm:`, workspace dependencies, or package metadata in different places.

After dependency changes, verify lockfile updates and remove obsolete entries. Do not hand-wave a stale lockfile as harmless release cleanup.

## Documentation

Deno can surface generated documentation for TypeScript modules. When documentation output is part of the repository workflow, use the repository's current task/command rather than relying on a remembered syntax.

For public libraries, validate more than rendered docs: check public imports, schema/type exports, examples, TSDoc links, and declaration/inference behavior.

## Publishing to JSR

Relevant command family:

```sh
deno publish
```

Publishing syntax, provenance behavior, dry-run options, and package validation are version-sensitive. Check the current Deno documentation before changing release automation.

A publish dry run should be paired with package-content inspection and a clean consumer when practical. A successful dry run does not prove the published package works in Node or browser consumers.

## Compiling executables

Relevant command family:

```sh
deno compile
```

Compilation can produce large platform-specific binaries and can change permission/runtime assumptions. Test the exact binary artifact on the claimed target. Do not treat source execution as compiled-artifact verification.

## Bundling and generated output

Deno's available bundling/build surfaces have changed across versions. Never copy a historical `deno bundle` command into current automation without checking the repository's Deno version and current official support.

If the repository uses another selected build owner such as Oxc, tsdown, Vite, or dnt, use that path and validate generated output directly.

## Upgrade and cache behavior

Runtime upgrade, dependency cache, lockfile, and registry behavior are version-sensitive. Prefer explicit repository toolchain pins (for example mise) and reproducible lock state. Do not solve a dependency problem by globally upgrading the agent environment unless the task asks for a toolchain upgrade.

## Packaging and cross-ecosystem publication

A Deno-first project may also publish npm packages, browser bundles, container images, or compiled binaries. Each is a distinct artifact path. Validate:

```text
source checks
Deno runtime checks
translation/build step
artifact contents
clean consumer
published target when authorized
```

Do not infer npm correctness from JSR correctness or vice versa.

## Command evidence vocabulary

Report actual outcomes:

```text
passed   command ran and met its contract
failed   command ran and exposed a defect
blocked  command could not run in this environment
skipped  command was not required for the changed surface
```

Record the exact command, working directory, relevant runtime version, and any permissions or environment assumptions. Never turn `blocked` into `passed` because a nearby Node or TypeScript check succeeded.
