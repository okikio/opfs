# Repository implementation rules

- Preserve the copied `utils/` programming model unless a deliberate refactor is requested.
- Put concrete media capabilities in `packages/media/<capability>`.
- Prefer one-word names. Use two or three words only when needed for clarity.
- All Zod schema constants end in `Schema`.
- Project-owned data types normally end in `Type`.
- Prefer direct schema and type exports. Use namespace imports only when they improve short operation call sites.
- Prefer `get`, `create`, `open`, `save`, `inspect`, `plan`, `convert`, `download`, `select`, `write`, `close`, `pause`, `resume`, and `cancel` over vague verbs.
- Avoid `generate`, `execute`, `handle`, `process`, `manager`, `helper`, `common`, `shared`, and `misc` unless an external protocol requires the word.
- Use `node:test` with `describe` and `it`; use `@std/expect` for expectations.
- Keep Deno and Node on the same TypeScript source. Do not create runtime-specific source forks.
- Prefer Web APIs and `@std/*`; use the existing utilities when their stronger programming model is required.
- Use LogTape categories in reusable packages. Applications own LogTape configuration.
- Use `@okikio/observables` for observation, not as authority for cancellation or terminal results.
- TSDoc and comments use plain Simplified Technical English and teach options, examples, impact, reasoning, ownership, limits, and necessary background.
- Do not add a root `scripts/` directory. Put repository tasks under `.mise/tasks/`.
