# Toolchain Ownership

A repository toolchain is a set of selected owners for formatting, linting, transforms, builds, tasks, tests, packages, generated artifacts, and release work. Treat those owners as architecture. Do not add a second tool for the same job only because it is familiar.

## Start from the repository

Before changing tooling, map the current owners:

| Concern | Evidence to inspect | Typical owner examples |
| --- | --- | --- |
| Runtime and dependency graph | `deno.json(c)`, `package.json`, lockfiles | Deno, npm/pnpm, Bun |
| Task execution | `mise.toml`, `.mise/tasks/`, manifest scripts | mise, Deno tasks, package scripts |
| Type checking | repository tasks and compiler config | Deno, TypeScript |
| Lint and format | repository tasks/config | Oxc, Deno, Biome, ESLint/Prettier |
| Transform and bundle | build config, package exports | Oxc, Unplugin, Vite, Rollup, tsdown |
| Browser tests | test config | Playwright |
| Package tests | imports and tasks | `node:test` + `@std/expect` for Deno-first portable packages, unless the project selects another runner |
| Benchmarks | benchmark files/tasks | Mitata when selected |
| Release | CI, release config, registry metadata | repository-selected release tooling |

Do not infer the owner from a dependency name alone. Verify the task that actually runs in development and CI.

## One owner per concern by default

A second tool is justified only when it owns a different capability or the current owner has a verified gap.

Good:

```text
Oxc
  lint + format + transform

Playwright
  real browser execution

Mitata
  cross-runtime benchmark harness
```

Potentially bad:

```text
Oxc + Babel + SWC
  all transforming the same source without an explicit reason
```

If two tools remain, document the exact division and add a test that prevents them from producing divergent output.

## Mise is the repository task entry point when selected

When a repository uses mise, prefer its tasks for canonical local and CI commands. Do not create a parallel root `scripts/` framework or duplicate the same workflow in package scripts unless a package consumer requires that script.

A good task graph makes the real gates discoverable:

```text
mise run fmt
mise run lint
mise run check
mise run test
mise run bench
mise run build
mise run verify
```

The names are examples, not requirements. Read the repository before invoking or creating tasks.

## Oxc is a coherent selected toolchain, not a universal dependency

When a repository has selected Oxc, reuse its parser/linter/formatter/transform capabilities where they satisfy the requirement. Before introducing Babel, ESLint, Prettier, or another compiler path, identify the concrete missing capability and the cost of a second configuration and AST pipeline.

Do not claim support from the Oxc project family unless the installed package and current repository configuration expose the exact feature needed. Version-sensitive behavior must be checked against current primary documentation and the lockfile.

## Unplugin is an integration mechanism

Unplugin packages provide adapters across build tools. The package name alone does not prove that every host behaves identically.

For an Unplugin-based feature, verify:

1. the exact host adapter used by the repository;
2. whether the transform runs in development, build, SSR/SSG, tests, or all of them;
3. generated module/type behavior;
4. tree shaking and production output;
5. watch/invalidation behavior when relevant;
6. framework-specific compiler behavior when the plugin emits components or framework source.

For example, an icon integration is not complete because the dev server renders an icon. Inspect the production bundle and SSR/SSG output when those are claimed surfaces.

## Deno and Node share source when the repository requires both

Do not create separate Deno and Node implementations merely to make tooling easy. Keep one source graph where practical and isolate real runtime-specific behavior behind explicit modules or adapters.

Validation-only shims belong in disposable validation infrastructure. They must not leak into package exports or change production imports.

## TypeScript and generated types are user-visible contracts

Tooling changes can alter emitted declarations, conditional exports, import paths, inferred generics, and generated modules without changing runtime tests. Inspect these outputs directly.

For public generic APIs, add compile fixtures that prove both accepted inference and expected type errors. A clean runtime test is not sufficient evidence for a public TypeScript contract.

## Generated artifacts need one authority

When code, schemas, Unicode tables, command manuals, route maps, or type files are generated:

```text
authoritative input
      |
      v
 deterministic generator
      |
      v
 generated artifact
      |
      v
 freshness check
```

Do not edit generated output by hand and then separately patch the generator. Change the authority, regenerate, inspect the diff, and verify reproducibility.

## CI must run the same owners

A local task and CI task with similar names are not proof of parity. Compare:

- runtime versions;
- lockfile mode;
- task entry point;
- environment variables and permissions;
- generated-artifact checks;
- browser/runtime matrix;
- package/build artifact inspection.

A required CI job must protect an identified failure domain. Examples:

- source or schema change: focused lint, typecheck, and directly affected tests;
- service/wire change: real request validation, auth, and published API contract;
- package export change: clean packed consumer and emitted declarations;
- stateful resource change: migration/transaction or bounded lifecycle proof;
- release/deployment change: immutable artifact and authorized read-only plan,
  followed by separately approved deployment verification.

Do not run every browser, database, benchmark, package, or deployment test for
an unrelated edit. Benchmarks without stable regression thresholds are optional
evidence, not routine correctness gates. Separate job permissions and approvals
when they protect real deployment risk, not to create more qualification tiers.

Avoid a local `npm test` path and a CI `deno task test` path when they exercise materially different source or configuration unless that difference is intentional and separately verified.

## Failure signatures

Treat these as toolchain defects until disproved:

- the editor and CI use different formatters;
- local tests pass because a global tool supplies missing behavior;
- a build plugin runs in dev but not SSR or production;
- a generated file changes on every run;
- a package ships files not present in the clean build;
- a tool upgrade silently changes declaration output;
- a second compiler is added without removing or isolating the first;
- runtime-specific shims enter published source;
- CI invokes a stale script instead of the repository task authority.

## Verification

For a material toolchain change:

1. inspect the owner and its consumers;
2. run the narrow owner-specific check;
3. run the repository canonical task that includes it;
4. inspect generated or built output;
5. run the real runtime or consumer path affected by the tool;
6. compare local and CI entry points;
7. report unavailable native gates instead of calling them passed.

A toolchain change is complete only when the selected owner is clear, duplicate ownership is intentional or removed, generated output is reproducible, and the repository's actual delivery path succeeds.
