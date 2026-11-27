# Defaults and provenance across Optique, c12, defu, and Zod

Load this reference when defaults feel duplicated, an omitted CLI option masks
configuration, help cannot describe runtime behavior, or `config explain` must
show why a value won.

## Contents

1. [The three representations](#the-three-representations)
2. [Default kinds and owners](#default-kinds-and-owners)
3. [`@optique/zod` is an adapter](#optiquezod-is-an-adapter)
4. [Zod v4 default semantics](#zod-v4-default-semantics)
5. [The complete resolution pipeline](#the-complete-resolution-pipeline)
6. [A field descriptor pattern](#a-field-descriptor-pattern)
7. [A provenance envelope](#a-provenance-envelope)
8. [Merge and provenance algorithm](#merge-and-provenance-algorithm)
9. [Arrays, objects, and union branches](#arrays-objects-and-union-branches)
10. [Evidence limits](#evidence-limits)
11. [Implementation sequence](#implementation-sequence)
12. [Required tests](#required-tests)

## The three representations

Do not use one schema as all three of these objects:

| Representation | Meaning | May contain defaults? |
|---|---|---|
| Authored input | File syntax, shorthands, array operations, aliases | No executable defaults |
| Sparse patch | Facts contributed by one source | No |
| Complete runtime config | Final executable values after precedence | Yes |

The key invariant is:

```text
absence in a source patch means “this source made no decision”
```

Turning absence into a value before precedence resolution manufactures a
decision and can make a lower source unreachable.

## Default kinds and owners

The word “default” describes different behavior. Name the kind in code review.

| Kind | Owner | Materializes during parse? | Participates in provenance? |
|---|---|---:|---:|
| Help/documentation default | Optique term metadata | No | No |
| Parser-local fallback | Optique `withDefault()` or equivalent | Yes | Only when parser is sole owner |
| Deferred handler fallback | Optique `deferredValue()` | When invoked | Yes, as a distinct deferred source |
| Derived source | Source adapter | Yes, as a low-priority patch | Yes |
| Runtime default | Complete Zod schema | After source merge | Yes, as `runtime-default` |
| Recovery value | Zod `.catch()` | After validation error | Yes, as recovery, never ordinary default |

Use this decision table:

| Question | Mechanism |
|---|---|
| Should help/man describe the value while omission stays absent? | Help-only metadata |
| Is Optique the only possible owner of the setting? | Parser-local default may be valid |
| Does evaluation require a prompt, secret store, or handler resource? | `deferredValue()` |
| Is it computed deterministically from already resolved context? | Derived source |
| Is it the final fallback for executable configuration? | Zod `.default()` or `.prefault()` |
| Should invalid user input silently become a fallback? | Usually reject; do not use `.catch()` casually |

## `@optique/zod` is an adapter

`@optique/zod` lets an Optique value parser use a Zod schema for one parsed
value. It can improve diagnostics, transformations, and metadata. It does not
make the Zod schema the owner of multi-source precedence.

```ts
import { option } from "@optique/core/primitives";
import { optional } from "@optique/core/modifiers";
import { zod } from "@optique/zod";
import * as z from "zod";

const endpointValueSchema = z.url();

const endpointTerm = optional(option(
	"--endpoint",
	zod(endpointValueSchema, { placeholder: "https://example.com" }),
));
```

The placeholder documents or supports parsing machinery. It is not an entered
value, a config fallback, or provenance. Parsing no `--endpoint` must still
produce absence.

Avoid putting a runtime default in the scalar adapter:

```ts
// Wrong for a source-bearing option: omission becomes a CLI contribution.
zod(z.url().default("https://api.example.test"));
```

Instead, share a non-defaulted leaf schema and apply the default only in the
complete object:

```ts
const endpointSchema = z.url();

const CliPatchSchema = z.object({
	endpoint: endpointSchema.optional(),
});

const RuntimeConfigSchema = z.object({
	endpoint: endpointSchema.default("https://api.example.test"),
});
```

For a finite vocabulary, prefer an Optique `choice()` built from the schema’s
options when the installed version supports it. That lets Optique generate
choices and suggestions directly. Use the Zod adapter for scalar validation or
transformations that Optique should perform at token parse time.

## Zod v4 default semantics

Zod v4 `.default(value)` returns the default when input is `undefined`; the
default must already satisfy the schema’s output type. It can short-circuit
transforms. `.prefault(value)` supplies an input value and then runs the normal
parse pipeline.

```ts
const normalizedDirectory = z.string()
	.trim()
	.transform((value) => value.replace(/\/$/, ""));

const direct = normalizedDirectory.default("./dist");
const parsed = normalizedDirectory.prefault(" ./dist/ ");

direct.parse(undefined); // "./dist"; default is already output-shaped
parsed.parse(undefined); // "./dist"; fallback passes through trim + transform
```

Choose by shape, not preference:

| Fallback is shaped like | Use |
|---|---|
| Final output after transforms | `.default()` |
| Raw input that must be normalized/refined | `.prefault()` |
| Invalid-input recovery policy | `.catch()`, with explicit provenance and tests |

Nested defaults require deliberate object construction. If the outer object is
optional and absent, an inner default may never run unless the outer schema
receives an input object:

```ts
const LoggingSchema = z.object({
	level: z.enum(["debug", "info", "warn", "error"]).default("info"),
	format: z.enum(["pretty", "json"]).default("pretty"),
});

const RuntimeConfigSchema = z.object({
	// The empty input object activates the inner field defaults.
	logging: LoggingSchema.prefault({}),
});
```

Test the exact composed schema. Zod object composition can change where
refinements and transformations live; do not infer behavior from a leaf schema.

## The complete resolution pipeline

```text
tokens ──Optique──> sparse CLI patch ─┐
environment adapter ─> sparse patch ─┼─> app merger ─> complete Zod parse
c12 resolved config ─> sparse patch ─┤                  │
derived source ───────> sparse patch ─┘                  ├─> runtime config
runtime default metadata ────────────────────────────────└─> provenance
```

Recommended precedence:

```text
explicit CLI > environment > resolved project config > derived > runtime default
```

The public merge API may list inputs highest-to-lowest for readability. A
pairwise merger that evaluates append/prepend operations must usually walk
lowest-to-highest internally:

```ts
export function mergeConfigInputs<T>(
	...highestToLowest: readonly (T | null | undefined)[]
): T {
	let resolved = {} as T;
	for (const layer of highestToLowest.toReversed()) {
		if (layer == null) continue;
		resolved = mergePair(layer, resolved);
	}
	return resolveStandaloneOperations(resolved);
}
```

The c12 `merger` and the application merger are separate. The c12 merger must
preserve loader control fields long enough for `extends`, environment branches,
and config factories to resolve. Strict patch validation belongs after c12 has
finished producing application data.

## A field descriptor pattern

Repeated literals drift. For important source-bearing fields, store shared
facts without pretending all libraries consume the same object:

```ts
const timeoutField = {
	cli: "--timeout",
	env: "APP_TIMEOUT",
	configPath: ["network", "timeoutSeconds"] as const,
	description: "Abort an HTTP request after this many seconds.",
	documentedDefault: 30,
	valueSchema: z.number().int().positive(),
} as const;

const CliPatchSchema = z.object({
	timeoutSeconds: timeoutField.valueSchema.optional(),
});

const RuntimeConfigSchema = z.object({
	timeoutSeconds: timeoutField.valueSchema.default(
		timeoutField.documentedDefault,
	),
});
```

Adapters may derive their parser term, env key, authoring field, help text, and
runtime default from this descriptor. Keep adapter construction explicit so a
library upgrade cannot silently change all interfaces.

## A provenance envelope

Return the usable config and its explanation together:

```ts
type SourceKind =
	| "cli"
	| "environment"
	| "config"
	| "derived"
	| "runtime-default"
	| "recovery";

interface Contribution {
	readonly source: SourceKind;
	readonly sourceId: string;
	readonly path: readonly (string | number)[];
	readonly operation: "set" | "append" | "prepend" | "replace" | "default";
	readonly explicit: boolean;
	readonly redactedValue: unknown;
}

interface FieldDecision {
	readonly winner: Contribution;
	readonly shadowed: readonly Contribution[];
}

interface ResolvedConfigEnvelope<T> {
	readonly schemaVersion: 1;
	readonly value: T;
	readonly decisions: Readonly<Record<string, FieldDecision>>;
	readonly sources: readonly {
		readonly sourceId: string;
		readonly kind: SourceKind;
		readonly location?: string;
	}[];
}
```

The machine envelope is versioned. Human `config explain` output is a rendering
of it, not a second resolver. Redact structured contributions before formatting
or passing them to LogTape.

## Merge and provenance algorithm

Do not reconstruct provenance by comparing the final value with source values.
Equal values can have different authorship. Record decisions while resolving.

For each normalized source layer:

1. Preserve whether every field was absent or explicitly present.
2. Convert source-native names to canonical application paths.
3. Validate the sparse patch without defaults.
4. Attach `{ source, sourceId, explicit: true }` to present fields.
5. Merge lowest-to-highest so operation order is meaningful.
6. At each affected path, record the contribution and operation.
7. When a higher scalar or atomic branch replaces a value, mark the earlier
   contribution as shadowed.
8. For append/prepend, retain every contributing source in execution order.
9. After authored sources resolve, apply derived values only to absent paths.
10. Parse with the complete Zod schema.
11. Compare pre-default and post-default structure by presence, not value. Add a
    `runtime-default` decision for paths materialized by Zod.
12. Redact values and source locations before exposing the envelope.

Conceptual implementation:

```ts
for (const layer of lowestToHighest) {
	for (const contribution of flattenPresentFields(layer.patch, layer.meta)) {
		applyContribution(valueDraft, contribution, decisionDraft, mergePolicy);
	}
}

applyMissingDerivedContributions(valueDraft, decisionDraft, derivedPatch);

const beforeDefaults = structuredClone(valueDraft);
const value = RuntimeConfigSchema.parse(beforeDefaults);
recordMaterializedDefaults(beforeDefaults, value, decisionDraft);
```

`recordMaterializedDefaults()` needs schema-owned default metadata for perfect
accuracy when transforms create or remove keys. Do not label every post-parse
difference a default: transforms are a separate operation. A robust
implementation either records defaults through field descriptors or separates
normalization from default materialization into observable passes.

## Arrays, objects, and union branches

| Shape | Default merge rule | Provenance rule |
|---|---|---|
| Scalar | Higher explicit value replaces lower | One winner, lower values shadowed |
| Ordinary object | Merge known properties recursively | Decision per leaf path |
| Plain array | Higher array replaces lower | Array-level winner unless element identity is specified |
| Empty array | Explicitly clears inherited values | Must remain an explicit winner |
| Append/prepend | Evaluate against inherited array | Record all ordered contributors |
| Discriminated union | Replace branch atomically at schema-known path | Branch-level winner; old branch fields shadowed |
| Secret | Same merge behavior | Value always redacted in public envelope |

Do not invent per-element array provenance unless elements have stable identity.
If routes have IDs, define merge and explanation by ID. If they do not, explain
the array as one value plus ordered operations.

## Evidence limits

Optique normally yields the selected value, not necessarily a complete token
trace proving whether the same value came from an explicit token or a source
fallback. Provenance must be based on evidence the installed integration
actually exposes.

Use this hierarchy:

1. Parser/integration metadata that explicitly identifies the winning source.
2. A separately parsed minimal presence term for explicitly supplied aliases.
3. Raw-token inspection for exact registered aliases and `--name=value` forms.
4. Value comparison only as a last resort, and label it inferred.

Never infer that CLI was absent because its value equals config. The user may
have explicitly supplied the same value. Test canonical names, short aliases,
hidden compatibility aliases, repeated options, and negated flags.

## Implementation sequence

1. Inventory every default and classify it with the owner table.
2. Define authored, sparse, and complete schemas separately.
3. Remove defaults from source-bearing Optique terms and patch schemas.
4. Keep scalar Zod adapters non-defaulted.
5. Add help-only default metadata and prove omission remains absent.
6. Select `.default()` versus `.prefault()` from input/output shape.
7. Load c12 once and preserve its loader metadata until loading completes.
8. Normalize each layer to one sparse patch vocabulary.
9. Implement and unit-test the pair merger before adding provenance.
10. Record provenance during merge, not after it.
11. Apply complete Zod validation and record runtime defaults.
12. Configure LogTape after bootstrap controls are known; redact the envelope.
13. Inject `{ config, provenance, logger }` into handlers.
14. Verify help, config explain, runtime behavior, and the installed artifact.

## Required tests

| Scenario | Assertion |
|---|---|
| CLI omitted, env present | Env wins; CLI has no contribution |
| CLI omitted, config present | Config wins; runtime default is not applied |
| All authored sources absent | Zod materializes one runtime default decision |
| Explicit CLI equals config | CLI still wins; config is shadowed |
| Help-only default | Help/man contains it; parsed patch omits the field |
| Zod adapter placeholder | Never appears in patch, config, or provenance |
| `.default()` after transform | Test documents short-circuit behavior |
| `.prefault()` after transform | Fallback passes through transform/refinement |
| Nested object absent | Intended nested defaults do or do not materialize explicitly |
| `false`, `0`, empty string | Preserved or rejected by schema policy, never treated as absence |
| Empty array | Explicitly clears inherited array |
| Append/prepend | Value and ordered contributors are both correct |
| Atomic union branch change | No fields leak from the lower branch |
| Dynamic config factory | Side-effect counter proves one evaluation |
| Secret contribution | Redacted in human output, JSON, logs, and errors |
| Recovery fallback | Marked `recovery`, never `runtime-default` |

See [testing.md](../../../references/testing.md) for executable test layers and
[benchmarking.md](benchmarking.md) for measuring the cost of resolution and
provenance without weakening these invariants.
