# General engineering rules

Use the current cross-project standard in [`base.md`](base.md) as the authority for naming, schemas, documentation, testing, ownership, compatibility, and delivery. This reference explains the general engineering decisions that apply when no language- or domain-specific reference is more precise.

## Start from the repository

Inspect the current repository before changing it. Map the relevant entrypoints, exports, imports, schemas, public types, runtime paths, tests, documentation, generated artifacts, and installed toolchain first.

Do not infer architecture from a single file. Trace the requested behavior from its public entrypoint through the dependencies that actually own it. Include error paths, cancellation, cleanup, retries, persistence, and generated output when they affect the result.

When documentation and code disagree, distinguish the intended contract from verified behavior. Do not silently convert an old implementation detail into a current requirement.

## Name the exact concept

Use surrounding context to keep names short. Prefer one concrete word. Add a second or third word only when the shorter name would be ambiguous.

Project-owned runtime operations should use concrete verbs such as `get`, `create`, `open`, `save`, `inspect`, `plan`, `convert`, `write`, `close`, `pause`, `resume`, and `cancel`.

Use `get` for addressable retrieval. Use `read` when the operation actually consumes or reads a byte stream, file, cursor, archive, socket, or another sequential source.

Avoid vague project-owned nouns and verbs such as `manager`, `helper`, `common`, `shared`, `misc`, `process`, `handle`, or `execute` when a more exact concept exists. External APIs and protocols can keep their exact terminology.

Do not introduce generic architecture words where a specific term communicates the real relationship. Name the exact API entrypoint, ownership handoff, validation stage, transaction scope, publication commit point, renderer handoff, version line, or other concrete concept.

## Keep data contracts explicit

Project-owned TypeScript and JSON fields normally use `camelCase`. Preserve external field naming while data still mirrors an external API, protocol, persisted format, or compatibility contract. Convert once at the explicit handoff when the project intentionally owns a different shape.

Do not invent a second internal record solely to change letter casing. Introduce a separate shape only when the semantics, ownership, validation stage, or lifecycle are actually different.

For Zod-owned data:

```ts
export const SourceSchema = z.strictObject({
  kind: z.literal("url"),
  url: z.url().describe("HTTP or HTTPS resource inspected by the caller."),
});

export type SourceType = z.output<typeof SourceSchema>;
```

Every project-owned Zod schema constant ends in `Schema`. Project-owned schema-derived data normally ends in `Type`. Behavior interfaces and classes use the concrete domain noun without a `Type` suffix.

Put important field documentation on the schema that owns the authoring contract. Do not maintain a duplicate handwritten interface merely to carry comments.

Use Standard Schema when a reusable integration should accept multiple validator libraries. Do not confuse Standard Schema with JSON Schema or with the project's own authoring schema.

## Put code in the layer that owns the concept

Use the repository's established dependency direction.

```text
utils/
  generic programming models and execution mechanics

packages/
  concrete domain and product capabilities

registry/
  declarative definitions and catalogs

clis/ and apps/
  executable composition and product policy
```

Do not create `common/`, `shared/`, `misc/`, `helpers/`, or a generic `utils/` dumping ground inside a concrete package. Use the precise capability name.

Use underscore-prefixed support entries only when an auto-discovered tree requires a verified non-discoverable entry. An underscore is not the normal marker for "secondary" modules.

Public entrypoints must be intentional. Keep runtime-specific adapters or integrations on explicit subpaths when importing them from the root would make unrelated runtimes evaluate incompatible code.

## Prefer JavaScript-native TypeScript

Use TypeScript to describe JavaScript rather than replace it with extra ceremony.

Prefer runtime values plus derived types over TypeScript-only representations when both express the contract clearly. For example, prefer a constant object or schema over `enum` when the runtime value is itself useful.

Do not add `public` by default. Use JavaScript private fields when true private state is required and the supported runtimes permit them. Use inheritance-specific syntax only when inheritance is the real design.

Public inference is part of the API. Reusable generic APIs should have compile fixtures for the inference that callers depend on, including expected type errors where they protect a contract.

## Make ownership and lifetime visible

Acquisition, cancellation, terminal results, and cleanup are separate concerns.

- Use `AbortSignal` to request cancellation.
- Use explicit disposal to release resources.
- Treat injected resources as borrowed unless an option explicitly transfers ownership.
- Unwind resources acquired before a later acquisition fails.
- Do not let a cleanup fault erase the primary operation fault.
- Keep observations separate from authority for cancellation, terminal results, or durable state.

A `ctx` parameter is appropriate when one typed execution context clearly owns the operation lifetime. It must not become an ambient bag of unrelated services.

Any operation whose memory, queue, retry count, concurrency, request count, result size, or retained state can grow needs an explicit limit or a documented reason why it cannot grow without limit.

## Explain the hard parts

Documentation is part of the implementation contract. Public symbols need useful TSDoc, and important internal symbols need the same treatment when they own behavior a reader cannot safely infer from the name and syntax alone.

Common documentation targets include:

- parser tables and parser state;
- regular expressions with non-obvious semantics;
- leases, generations, caches, queues, and retry rules;
- resource factories and cleanup paths;
- transaction and publication invariants;
- binary layouts, offsets, and encodings;
- deliberate performance structures;
- benchmark workloads and fixtures whose shape affects interpretation.

Explain what the symbol means here, why it exists, its important options, ownership, cancellation, limits, failures, and a concrete example when the API is reusable. Build the reader's mental model progressively. Do not assume they already understand the rest of the repository.

Local comments should preserve a rule or explain reasoning. Do not narrate obvious syntax.

## Optimize only with a named cost

Prefer plain, cheap, inspectable structures until evidence justifies something more complex.

A deliberate optimization should identify:

1. the concrete runtime cost it reduces;
2. the target workload where that cost matters;
3. the measured or well-supported magnitude;
4. the semantic tradeoff, if any;
5. how to disable it when it can change observable behavior.

Benchmark representative workloads. Preserve benchmark fixtures and configuration when changing them would make comparisons misleading.

## Reuse the repository's selected owners

Before adding a dependency or second tool path, inspect what the repository already selected for the concern. Reuse it when it directly supports the requirement.

Examples include LogTape for diagnostics, Optique for CLI grammar, Oxc for selected compiler/lint/format work, Unplugin for selected build-tool integrations, Mise for development tasks, Playwright for browser behavior, and Mitata for cross-runtime benchmarks.

These tools are not universal requirements. They are owners only where the repository has selected them.

## Validate the behavior you claim

For Deno-first TypeScript packages, the default in this collection is `node:test` with `@std/expect`. The same source should run in Deno and Node when the package claims both. Runtime-specific suites remain necessary for behavior that only exists in browsers, workers, Deno, Bun, Node, databases, containers, or other concrete environments.

A type-only green check is not enough for runtime behavior. Run the relevant formatter, lint, strict type checks, tests, builds, runtime smoke tests, output inspection, public consumer/type fixtures, and user flows.

Keep functional changes separate from unrelated formatting, import sorting, line-ending normalization, or generated-file churn. Inspect the final diff and revert incidental changes.

When delivering an archive, validate the exact archive: create it, extract it into a clean directory, compare files and hashes, recreate only allowed validation-side infrastructure, and rerun the available checks against the extracted artifact.

Report every native gate that ran, every result, and every gate that the execution environment prevented. Do not convert an unavailable runtime into a passed check.

## Replace obsolete behavior completely

Do not preserve obsolete compatibility unless the current task explicitly requires it.

A replacement updates all current consumers, tests, exports, documentation, configuration, generated artifacts, persisted data, and user flows that depend on the old behavior. Remove the obsolete path only after those current consumers have moved.
