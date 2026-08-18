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
- Use mise as the repository command authority. GitHub Actions owns triggers, permissions, matrices, outputs, and
  secrets, then calls `mise run ...`.
- Testcontainers owns disposable provider fixtures. Do not restore fixed host ports, hand-written readiness polling, or
  Compose lifecycle scripts for S3/Azure tests.
- Benchmarks compare the native/provider baseline, project client when present, driver, adapter, facade with metrics
  disabled, and measured facade. Compare filesystem clients such as Mountpoint and BlobFuse only on operations their
  documented semantics support.
- TSDoc and comments use plain technical English. Teach options, examples, impact, reasoning, ownership, limits,
  cancellation, performance, and necessary background.
- Document important non-exported symbols when they own an invariant, lifecycle rule, serialization layout, or failure
  rule.
- Comments explain why a rule exists or what must remain true. Do not restate obvious syntax.
- Keep agent-only validation under `.agents/`. It must never become a production import or published artifact.
