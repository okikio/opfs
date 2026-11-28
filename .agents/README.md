# Use shared guidance in OPFS

Start with the [repository rules](../AGENTS.md), [programming model](../README.md),
[architecture](../docs/design.md) and [tooling](../docs/tooling.md). Use [START.md](START.md) to select a capability and
[GUIDANCE.md](GUIDANCE.md) to understand the roles of skills, guides, references, the playbook and the handbook.
This directory adopts the complete connected collection from [okikio/skills](https://github.com/okikio/skills).

## Bind the method to this repository

OPFS supplies a filesystem programming model for library consumers. Trace an operation through the existing
`client -> driver -> adapter -> FileSystemType -> bridge` ownership before changing it. Keep import safety and the
caller's resource lifetime explicit across the supported hosts.

| Project contract | Current owner |
| --- | --- |
| Architecture, ownership and import safety | [AGENTS.md](../AGENTS.md) and [docs/design.md](../docs/design.md) |
| Native Deno file lifetimes | [docs/host.md](../docs/host.md#deno-file-ownership) and `src/backend/deno/{driver,range,write,writable,sync}.ts` |
| Public entrypoints and package identity | `mod.ts`, `src/`, `deno.json`, `package.json` and `tests/package/exports.json` |
| Runtime and dependency versions | [mise.toml](../mise.toml) and `deno.lock` |
| Checks, test families and external prerequisites | [docs/tooling.md](../docs/tooling.md), `.mise/tasks/`, `tools/` and `tests/` |
| Installed npm consumer fixtures and declaration environments | [docs/package.md](../docs/package.md) through `mise run check:package` |
| Native declaration graph and ambient reference placement | `tools/npm/declarations.ts` and the installed native declaration fixtures |
| Release procedure | [docs/releasing.md](../docs/releasing.md) |
| Active work and publication authority | The current request, actual Git branch and revision, working changes and relevant PR |

Keep the root entrypoint import-safe in Window, Worker, Deno, Bun and Node contexts. Provider requirements belong to
their owning subpaths. Guidance examples do not select a backend, framework or deployment environment. The
project-specific architecture and commands above govern implementation.

Use `build-libraries` for public contracts, `build-devtools` for tooling and `deno-software` for Deno or JSR decisions.
Add the domain owner for the behavior being changed. Use the Rust data-layout guidance only when a Rust or layout
decision is in scope; it does not add a Rust or Wasm requirement to this TypeScript library.

## Choose a command for the changed contract

Run these commands from the repository root. Mise owns the pinned tools and native task prerequisites.

| Purpose | Existing command |
| --- | --- |
| Install the frozen dependency graph | `mise run prepare:deps` |
| Inspect discovered Deno test families | `mise run test:deno -- --list` |
| Run a focused portable test | `mise run test:node -- tests/byte-abort.test.ts` |
| Check source types in the appropriate serial runner | `mise run check:types` |
| Check formatting and lint | `mise run check:format` and `mise run check:lint` |
| Exercise real browsers | `mise run test:browser` |
| Build, pack and exercise a clean npm consumer | `mise run check:package` |
| Inspect source publication without uploading | `mise run check:jsr` |

Select the actual changed test file and repeat it on the required runtimes. Runtime tests use the repository's
separate type-checking contract. Follow `AGENTS.md` for compiler memory limits: run heavy type checks serially in CI
or an isolated runner when the workstation has shown memory spikes. Browser and provider lanes need their declared
prerequisites. Record actual passes, failures and unavailable hosts separately.

## Keep the collection reproducible

[source.json](source.json) records the upstream commit, copied paths, sizes and SHA-256 values. It covers `START.md`,
`GUIDANCE.md`, `LICENSE`, `guides/`, `references/`, `skills/` and `handbook/`. This local profile, provenance record and
the existing [validation programs](validation/README.md) belong to OPFS. Change reusable guidance in its upstream
owner, then refresh the connected collection and manifest from a verified commit. Compare the old manifest before
removing retired files and preserve local validation programs and evidence.

Run the collection's `deno task check`, `deno task validate`, `deno task test` and `deno task bundle` in an upstream
skills checkout. Those maintenance commands are not OPFS tasks. Check copied hashes and links, review this profile,
and exercise a fresh task through `AGENTS.md` and `START.md` after an update. Reference examples and their nested
configurations keep their upstream validation owner. Local `.agents/validation/` programs remain in OPFS checks.

The guidance is development material outside npm build and JSR publication inputs. Inspect the actual package
archives and dry-run output when those inputs change. Keep project observations and temporary evidence in their
existing owners, separate from the copied reusable methods.
