# Repository implementation rules

Read `README.md` and `docs/design.md` before changing architecture or public APIs.

- Treat `@okikio/opfs` as a library programming model, not as an application runtime.
- Keep the root entrypoint import-safe in Window, Worker, Deno, Bun, and Node contexts.
- Use the storage path literally: `client -> driver -> adapter -> FileSystemType -> bridge`.
- A client owns a wire protocol when one exists. It does not own OPFS semantics.
- A driver owns backend-native storage mechanics, requirements, limits, optimization policy, physical metrics, and
  resources that it explicitly acquires.
- An adapter translates one driver into the small canonical OPFS primitive contract. It does not reimplement provider
  mechanics.
- A bridge starts from `FileSystemType` and implements a real ecosystem contract. Do not call direction metadata or a
  nominal wrapper a bridge.
- Put direction/support metadata under `src/integration/`. Definitions remain import-safe and require no global
  registry.
- Do not preserve obsolete layer names or compatibility entrypoints. Update every current consumer, test, export,
  document, and benchmark when a public contract changes.
- Prefer one-word file and folder names. Use two or three words only when the precise concept requires them.
- All Zod schema constants end in `Schema`.
- Project-owned data types normally end in `Type`.
- Prefer direct schema and type exports. Use namespace imports only when they improve short coherent operation call
  sites.
- Prefer `get`, `create`, `open`, `save`, `inspect`, `plan`, `read`, `write`, `close`, `remove`, `copy`, and `move` over
  vague verbs.
- Avoid `generate`, `execute`, `handle`, `process`, `manager`, `helper`, `common`, `shared`, and `misc` unless an
  external protocol requires the word.
- Keep Deno, Bun, Node, browsers, and Workers on the same core TypeScript source. Runtime-specific drivers stay behind
  explicit subpaths.
- Prefer Web APIs and `@std/*` before custom infrastructure when they provide the required semantics.
- Importing a module must not connect to a provider, read credentials, configure logging, start workers, or perform
  unrelated global work.
- The caller owns injected databases, collections, clients, stores, mounts, and filesystems unless an explicit option
  transfers ownership.
- Every behavior-changing optimization must be independently disableable and visible through inspection.
- Keep provider hard limits, implementation safety limits, user policy, and dynamic probe results distinct. Do not
  collapse them into one unexplained number.
- `plan()` is deterministic preflight. It must not perform provider I/O. A probe is a separate explicit operation.
- Partitioning belongs to the driver that owns the physical layout. The driver must describe visibility, part limits,
  cleanup, and whether the layout changes observable behavior.
- Use `node:test` with `describe` and `it`; use `@std/expect` for expectations. Playwright owns real browser environment
  tests.
- Use mise as the repository command authority: `mise run <family>:<kind>`. Task files live in `.mise/tasks/` and their
  programs in `tools/`. GitHub Actions owns triggers, permissions, matrices, outputs, and secrets, then calls the same
  mise tasks. Tests and benchmarks are discovered from file names; do not list files in manifests or workflows. See
  `docs/tooling.md`.
- Run Deno runtime tests with `--no-check`; `mise run test:deno` already supplies it. Type checking is a separate gate.
- Do not run `deno check`, aggregate quality/release gates, or compiler-cost benchmarks on a workstation where checking
  has caused memory spikes. Run those gates serially in CI or an isolated runner with a memory budget. Do not run type
  checking beside local tests or benchmarks, and do not count runtime-only passes as type validation.
- Testcontainers owns disposable provider fixtures. Do not restore fixed host ports, hand-written readiness polling, or
  Compose lifecycle scripts for S3/Azure tests.
- Adopt upstream runtime and WPT cases with immutable commits, original case identities, licenses/notices, copied-byte
  hashes, adaptations and explicit capability exclusions. Native Web IDL expectations do not automatically apply to a
  structural filesystem facade.
- Retain raw executable snapshots as inert data; do not execute upstream setup or format its original bytes. Keep
  adapted harnesses in the normal checks and compare behavioral output rather than incidental messages.
- Separate upstream regression coverage, native browser conformance and performance observations. Investigate supported
  case failures rather than silently excluding them or generating expectations from candidate output.
- Benchmarks compare the native/provider baseline, project client when present, driver, adapter, facade with metrics
  disabled, and measured facade. Compare filesystem clients such as Mountpoint and BlobFuse only on operations their
  documented semantics support.
- TSDoc and comments use plain technical English. Teach options, examples, impact, reasoning, ownership, limits,
  cancellation, performance, and necessary background.
- Document important non-exported symbols when they own an invariant, lifecycle rule, serialization layout, or failure
  rule.
- Comments explain why a rule exists or what must remain true. Do not restate obvious syntax.
- Keep agent-only validation under `.agents/`. It must never become a production import or published artifact.

## Release notes

Use Sampo changesets in `.sampo/changesets/` to record release intent (`node_modules/.bin/sampo add`). Each entry
teaches the consumer what changed, why it matters, the affected scenario, and any migration. Show complete runnable
examples for new or changed APIs. Use before/after output, tables, or diagrams when they explain semantics, resource
ownership, or a workflow. Follow the explanatory quality of esbuild changelogs; do not reduce release notes to commit
subjects. Group by consumer behavior. State supported standards and limitations precisely, and attach workload, runtime,
units, and evidence to any performance claim. Verify examples against the exact release artifacts.

Deno owns the source implementation. Sampo owns release intent, versions and changelog rendering.
`mise run release -- --operation version` writes the version and copies it into `deno.json`; `mise run check:versions`
rejects mismatched metadata before packing or publishing. Keep local release receipts under ignored `.tmp/`.

## Readability and ownership

At the start of work, identify the intended reader, their task, and the relevant customer, user, and system flow. Use
concrete actions and consistent terms. Explain necessary technical names before relying on them, while keeping API,
command, and data identifiers exact.

Before finishing, check that another person can understand the result, follow its instructions, recognize success or
failure, locate the responsible code, and maintain or share it without the chat. Preserve reasons, limits, and
verification evidence. Fix essential explanation gaps as part of the work; readability is a condition of completion.
