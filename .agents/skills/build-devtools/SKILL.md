---
name: build-devtools
description: Design, implement, migrate, review, diagnose, benchmark, package, or release developer tooling. Use for repository toolchains, Mise tasks, Oxc, Unplugin-based build integrations, code generators, source-preserving transforms, package builds, generated artifacts, release/version automation, CI parity, benchmarks, repository hygiene, or developer-tool CLIs. Do not use for an application feature that merely invokes an existing tool without changing its tooling contract.
---

# Build developer tools

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



## Select the complete task

Read [applying standards](../../guides/applying-standards.md) before domain work.
Select companions by the contracts being changed, with one discovery pass,
plan, and verdict. For repository work, use the shared quality contract when installed
for naming, schemas, tests, documentation, validation, and completion. Apply
rules by purpose; test-runner imports and trivial private fixtures are not
public runtime APIs. If a companion is absent, use the bundled compact defaults
and inspect local instructions rather than inventing unavailable guidance.

Developer tooling is production infrastructure for the repository. A tool is not
complete because it runs once on one workstation. It must have an owner,
reproducible inputs, deterministic or intentionally variable outputs, failure
behavior, CI parity, and a removal/upgrade path.

the shared quality contract owns overall completion. `deno-software` owns Deno-specific
manifests/runtime contracts. `build-libraries` owns reusable programming models.
`build-clis` owns public command-language behavior. This skill owns toolchain,
generation, packaging, release, and development-workflow mechanics.

## Evidence preflight

Inventory:

- root and package manifests, lockfiles, tool-version files, Mise config/tasks,
  CI workflows, editor config, and generated-file policy;
- selected compiler/linter/formatter/bundler/test/benchmark owners;
- Oxc/Biome/TypeScript/esbuild/Vite/Rollup/Unplugin or other exact integrations;
- source generators, templates, schemas, registries, Unicode/spec datasets, and
  codegen outputs;
- package exports, declaration/build output, runtime conditions, tarball/JSR
  contents, and clean-consumer checks;
- versioning, changelog, publish steps, registries, provenance, tags, rollback,
  and partial-release handling;
- caches, downloaded binaries, generated directories, temporary workspaces, and
  ignored files;
- cold setup, normal developer loop, CI, offline/proxy behavior where claimed,
  and uninstall/removal behavior.

If a repository already selected a tool owner, inspect that owner before adding
another tool that overlaps the same responsibility.

## Core rules

1. **One owner per tooling concern.** Do not casually introduce a second parser,
   formatter, linter, bundler, package manager, task runner, or release owner.
   Add a second owner only for a documented capability gap and define the seam.
2. **Reuse selected ecosystems deliberately.** When Oxc owns JavaScript/
   TypeScript parsing/linting/transforms, use its actual current packages and
   APIs rather than bringing Babel in for convenience. When Unplugin owns
   cross-bundler integration, verify the concrete Vite/Rollup/Webpack/Rspack
   adapter, virtual modules, HMR/SSR behavior, and generated types.
3. **Mise is repository task/tool authority only when selected.** Pin tools and
   keep task semantics in `.mise/tasks/`/configuration as the repository
   defines. Do not add a parallel `scripts/` framework just because an agent
   prefers it.
4. **Generators have explicit ownership.** Separate generated-only files,
   human-owned files, and mixed-ownership regions. Mixed files require bounded,
   source-preserving edits or generated markers. Never reformat an entire
   human-authored document to change one generated block.
5. **Generation is deterministic when the inputs are.** Record source version,
   schema/spec revision, generator version, locale/time effects, sorting, line
   endings, and output normalization. Provide check and write modes.
6. **Packaging proves the consumer contract.** Inspect built ESM, declarations,
   exports, conditions, side effects, optional dependencies, and actual package
   contents. Test from a clean consumer/runtime, not from workspace links only.
7. **Releases originate from an immutable revision.** Version, build, test,
   provenance/checksums, publication, tags, and release metadata must agree.
   Define what happens when one registry succeeds and another fails.
8. **Performance work protects real workflows.** Use Mitata where the repository
   selected it, but benchmark representative operations, warm/cold behavior,
   correctness, variance, memory/resource use, and regressions. Do not optimize a
   microbenchmark that makes the developer workflow slower or less correct.
9. **Keep functional and mechanical changes separate.** Tooling changes can
   trigger huge formatter/import/generated diffs. Restrict formatting to files
   the change intentionally owns and inspect the diff.
10. **Document important internal machinery.** Generator state, AST/source
    mapping, cache keys, lock behavior, release ordering, package-condition
    selection, and benchmark fixture construction often contain critical
    invariants.

## Failure review

Test or inspect for:

- local success caused by an undeclared global binary;
- lockfile/config ownership split across two package managers;
- generated output depending on filesystem order, clock, locale, or network;
- source-preserving transform rewriting comments/formatting outside its region;
- workspace-linked package passing while packed consumer fails;
- export condition selecting the wrong runtime build;
- package accidentally shipping tests, secrets, `.agents/`, or caches;
- release version/tag/artifact disagreement;
- one registry published while another failed;
- stale cache hiding a generator/build defect;
- benchmark result without correctness or representative workload;
- tool upgrade that changes generated output without a reviewed migration.

## Verification ladder

1. config/schema/static checks;
2. generator check/write idempotence;
3. focused tool/runtime tests;
4. clean build and declaration/output inspection;
5. package dry-run/content inspection;
6. clean consumer in claimed runtimes;
7. cold setup and CI-parity workflow;
8. release dry-run and rollback/partial-publish simulation where applicable;
9. representative benchmark protocol for performance claims.

## Reference routing

- [toolchains.md](references/toolchains.md): ownership of compiler/linter/
  formatter/bundler/task/package-manager configuration and parity.
- [mise-aube.md](references/mise-aube.md): detailed Mise and Aube configuration,
  tasks, lockfiles, workspaces, security, lifecycle build jails, CI, migration,
  and rollback.
- [generated-artifacts.md](references/generated-artifacts.md): generated versus
  authored ownership, check/write modes, deterministic output, provenance,
  source-preserving edits, and drift.
- [packaging.md](references/packaging.md): cross-runtime builds, exports,
  conditions, package contents, consumers, and lifecycle.
- [releases.md](references/releases.md): versions, immutable revisions,
  provenance, multi-registry publication, rollback, and recovery.
- [performance.md](references/performance.md): experiment protocol,
  statistical gates, correctness oracles, and protected workflows.
- [hygiene.md](references/hygiene.md): source/caches/binaries, secrets,
  generated artifacts, worktrees, and review checks.

For an unfamiliar or private tool, establish exact identity and current source
before writing configuration. Never borrow APIs from a similarly named project.

## Completion gate

Developer-tool work is complete only when the repository can reproduce it from a
clean state using declared tools, CI exercises the same contract, generated and
packaged output has been inspected, changed workflows fail clearly, and any
release or performance claim has the corresponding executable evidence. Report
unavailable native tools/runtimes as blocked, not passed.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Procedures](../../handbook/procedures/README.md), [Engineering and CI](../../handbook/engineering/README.md), [Task prompts](../../handbook/tasks/README.md).

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.
