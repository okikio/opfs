# TypeScript and Deno rules

## Runtime and module model

Assume Deno v2, strict TypeScript, ESM, and explicit file extensions unless the repository says otherwise.

Keep the same deterministic TypeScript implementation across Deno, Node, Bun, browsers, and workers where the capability overlaps. Runtime-specific adapters and tests may use runtime-specific APIs behind explicit modules. Do not fork the domain model merely to satisfy one toolchain.

Keep modules tree-shakeable and import-safe. Do not connect providers, configure logging, read environment variables, start workers, or acquire unrelated live resources during module evaluation.

Prefer JavaScript-native TypeScript. Use types to make runtime contracts precise without hiding the JavaScript model behind unnecessary ceremony.

## Runtime coupling is a review signal

Treat direct Node/Deno globals and static runtime-module imports in shared
code as portability smells: `Deno.*`, ambient `process`/`Buffer`/`global`, and
`node:*` or equivalent bare builtin imports can couple module resolution,
permissions, types or import-time work to a host. Count the concrete sites, then
trace their owner and actual consumers before declaring a defect. Inspect
existing `utils/` and focused package exports first; an env, file, process or
encoding utility may already preserve the required contract. Prefer that owner
or a native Web operation to duplicating host detection throughout domain code.

Keep intentional host APIs in explicit runtime adapters or executable roots.
Test-runner imports such as `node:test` are not portable production imports.
Guarded lazy lookup at that adapter is different from unguarded shared-code
access. Optional chaining an undeclared global, adding ambient types, or moving
`node:*` into a dynamic import does not by itself prove browser-safe resolution.
Verify public import graphs and isolated runtime types, then execute each
claimed consumer. A supported Node `process.getBuiltinModule` can avoid static
resolution where present; verify its version and capability instead of assuming
it exists in every runtime.

## Readable flow before abstraction

Code should tell one understandable story from top to bottom.

Keep a local callback inline when it is small and obvious in context. Extract a substantial nested operation when it owns an invariant, lifecycle, failure path, or independently meaningful concept. Prefer a named module-level function to a large function hidden inside another function.

Do not extract helpers merely to shorten a function. A function earns its own name when the name explains a real operation or contract.

Prefer early returns when a branch can finish the work directly. Avoid mutable placeholder results that only exist to be returned later.

## Apply the convention to its actual role

Namespace imports are useful for coherent runtime operation families, not a
blanket import style. Keep direct imports for test runners/assertions, schemas,
and types when they communicate the role. Document non-obvious test helpers and
invariants; trivial private fixtures do not require public API TSDoc. A runtime
schema owns validated serialized data, not every ephemeral object or live handle.
Preserve an explicit repository requirement and explain any material conflict.

## Naming

Use context before adding words.

Prefer one-word operation names inside coherent namespaces:

```ts
import * as codec from "@media/codec";
import * as storage from "@media/storage";

const kind = codec.kind(value);
const root = await storage.getRoot();
```

Use two or three words only when the shorter name would be ambiguous. Treat longer names as a signal to review the module or ownership model.

Use:

- `camelCase` for functions, variables, parameters, methods, properties, and project-owned TypeScript/JSON fields;
- `PascalCase` for classes, interfaces, type aliases, schemas, and other named type-level contracts;
- `UPPER_SNAKE_CASE` for true constants when that style helps fixed shared values.

Do not apply `snake_case` to project-owned records merely because they are data. Preserve snake case or another spelling only when an external protocol, provider, database, or durable format defines it, then map explicitly into the project model if the internal contract differs.

Prefer exact domain nouns and verbs. Avoid project-owned `Manager`, `Helper`, `Handler`, `Processor`, `Data`, `Item`, `Thing`, and vague `run()` or `execute()` operations when a concrete name is available.

Use `get` for addressable retrieval. Use `read` for actual reading or sequential consumption.

## Schemas, data types, and behavior interfaces

Schemas own data shape. Behavior contracts own operations.

For project-owned data:

```ts
export const SourceSchema = z.strictObject({
  kind: z.literal("url"),
  url: z.url(),
});

export type SourceType = z.output<typeof SourceSchema>;
```

Rules:

- every Zod schema constant ends in `Schema`;
- project-owned data types normally end in `Type`;
- infer the data type from the schema instead of maintaining a duplicate interface;
- behavior interfaces use the concrete noun without `Type`, for example `Writer`, `Task<Result>`, or `FileHandle`;
- public or reusable Zod object fields carry TSDoc at the schema declaration when their meaning, unit, default, allowed values, ownership, or effect is not obvious;
- do not create a mirror interface only to hold field documentation; the schema remains the data-shape and field-documentation source;
- strict project-owned object schemas are the default unless unknown fields are an explicit compatibility feature.

Document an authoring field where the field is declared:

```ts
export const DownloadSchema = z.strictObject({
  /**
   * Maximum number of HTTP requests that may be active for this download.
   *
   * `1` keeps requests serial. Higher values can improve range-download
   * throughput but also increase remote load and local write pressure.
   *
   * @default 4
   * @example 8
   */
  concurrency: z.int().min(1).max(64).default(4),
});
```

For repository-owned default/config objects, use the schema input type as a compile-time check when it improves editor documentation and drift detection:

```ts
const defaults = {
  concurrency: 4,
} satisfies z.input<typeof DownloadSchema>;
```

Do not make ordinary callers add `satisfies` to use a public authoring helper. `defineConfig(...)` and similar APIs should provide schema-derived contextual typing themselves.

Use direct imports for schemas and types because their role suffix already supplies context:

```ts
import { SourceSchema, type SourceType } from "@media/source";
```

Use namespace imports for coherent runtime operations when they improve the call site.

Use Standard Schema when a generic integration needs validator interoperability. Keep Zod-specific inspection inside code that deliberately depends on Zod. Standard JSON Schema is a separate interface for JSON Schema representations and conversion.

## Public API design

Any type referenced by a public signature must itself be part of the intentional public contract.

Prefer discriminated unions for real runtime states and variants. Prefer named types when the name captures a domain concept that callers need to reason about.

Do not preserve obsolete aliases or compatibility exports by default. If a replacement is authorized, update all current callers and remove the old symbol after the migration is complete.

Avoid `any`. Prefer `unknown` plus explicit validation or narrowing at external inputs.

Prefer constant objects plus derived types over TypeScript `enum` when the runtime object is useful and both forms model the same concept.

## Formatting

Follow the repository formatter and local configuration. Use the indentation and width selected by the repository config, keep opening braces on the declaration line, use explicit file extensions, and use `import type` for type-only imports. Prefer direct schema/type imports and coherent namespace imports for short operation families. Do not impose a new import grouping scheme over the repository formatter.

Use the repository formatter for changed code. Do not let a functional change trigger repository-wide formatting churn.

Prefer compact call sites and flat short structures:

```ts
await capture({ route, context, writer, signal });
const range = { start, end };
const kinds = ["video", "audio", "subtitle"] as const;
```

Expand objects, arrays, signatures, and calls when the extra vertical structure exposes meaningful groups, comments, long expressions, or a public contract.

Keep functional and formatting-only changes separate. Inspect the diff and revert unrelated import sorting, whitespace, line endings, generated files, or formatter changes.

## Class and lookup patterns

Prefer JavaScript-native TypeScript. Avoid `public` when the default visibility already communicates the contract. Prefer `#private` for true runtime-private class state when the target runtimes support it. Use `protected` only when inheritance genuinely requires it.

Prefer object spread for simple immutable clone/merge operations. Use `Object.assign()` when mutating an existing target is intentional and clearer. For small static string-key membership tables, a frozen prototype-free object can be clearer than a `Set`; use the representation that best fits the access pattern rather than applying this mechanically. For dense byte-indexed classification tables, `Uint8Array` can be appropriate when measurement or parser design justifies it.

## External inputs and validation

Keep provider or protocol names exact while data is still provider data. Normalize only at the explicit conversion into a project contract.

Validate untrusted or externally authored data before it becomes trusted project state. This includes configuration, CLI/environment input, network responses, persistence, IPC, file formats, and plugin data.

Do not turn runtime capability checks into complicated structural schema refinements. A schema can validate `codec: "avc"`; a runtime probe decides whether the current device can encode AVC.

## Documentation bar

Every exported symbol needs useful TSDoc unless it is a direct documented re-export. Important internal functions, schemas, types, fields, constants, regular expressions, parser tables, state machines, scanners, resource factories, retry/lease/cache state, and private helpers also need documentation when they own non-obvious behavior.

For a reusable non-trivial API, normally include:

- the problem and role in the larger flow;
- important options and concrete effects;
- one realistic common-path example;
- one edge or configuration example when it teaches a material rule;
- ownership, cancellation, cleanup, limits, performance, and expected failure behavior where relevant.

Do not add an essay to trivial glue. The documentation depth should match the semantic depth of the symbol. Give `@example` blocks descriptive names when the local documentation tooling supports them and the label improves navigation.

When code uses non-obvious parser recovery, bitwise or binary logic, offset math, regular expressions, concurrency coordination, source normalization, or a measured optimization, document the invariant and the physical cost or failure it protects against.

## Verification

After relevant TypeScript changes, run the repository's canonical checks. In a Deno-first repository this normally includes formatting, lint, strict type checking, tests, and documentation checks when configured. Run `deno doc --lint` when the repository exposes or requires that gate.

When the project claims multiple runtimes, type checking alone is not enough. Run representative behavior in each required runtime when the host provides it, and state exactly what remains unverified when it does not.
