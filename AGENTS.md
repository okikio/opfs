# Repository implementation rules

- Treat `@okikio/opfs` as a library programming model, not as an application runtime.
- Keep the root entrypoint import-safe in Window, Worker, Deno, Bun, and Node contexts.
- Put concrete storage integrations under `src/adapter/` and expose them through explicit public subpaths.
- Put reverse ecosystem interfaces under `src/driver/`.
- Prefer one-word file and folder names. Use more words only when the precise concept requires them.
- All Zod schema constants end in `Schema`.
- Project-owned data types normally end in `Type`.
- Prefer direct schema and type exports. Use namespace imports only when they improve short operation call sites.
- Prefer `get`, `create`, `open`, `save`, `inspect`, `plan`, `convert`, `read`, `write`, `close`, `remove`, `copy`, and `move` over vague verbs.
- Avoid `generate`, `execute`, `handle`, `process`, `manager`, `helper`, `common`, `shared`, and `misc` unless an external protocol requires the word.
- Keep Deno, Bun, Node, browsers, and Workers on the same core TypeScript source. Runtime-specific adapters can use runtime-specific APIs behind explicit subpaths.
- Prefer Web APIs and existing standard-library capabilities before custom infrastructure.
- Adapters never configure logging, read environment variables, or acquire unrelated global resources at import time.
- The caller owns injected database, collection, storage, and filesystem resources unless an adapter option explicitly transfers ownership.
- TSDoc and comments use plain technical English. They teach options, examples, impact, reasoning, ownership, limits, failure behavior, and necessary background.
- Document public schemas, types, properties, functions, classes, and adapter contracts. Document internal symbols when their invariant, lifecycle, or failure behavior is not obvious.
- Comments explain why a rule exists or what must remain true. Do not restate obvious syntax.
