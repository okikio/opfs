# c12, defu, and jiti configuration manual

## Contents

- [Evidence and version lines](#evidence-and-version-lines)
- [Responsibility map](#responsibility-map)
- [Configuration shapes](#configuration-shapes)
- [Resolution stages](#resolution-stages)
- [c12 loading capabilities](#c12-loading-capabilities)
- [Two mergers](#two-mergers)
- [Dynamic factories and jiti](#dynamic-factories-and-jiti)
- [Precedence and evaluation order](#precedence-and-evaluation-order)
- [Merge algebra](#merge-algebra)
- [Declarative array operations](#declarative-array-operations)
- [Atomic unions and special fields](#atomic-unions-and-special-fields)
- [Provenance and inspection](#provenance-and-inspection)
- [Configuration mutation](#configuration-mutation)
- [Validation stages](#validation-stages)
- [Testing strategy](#testing-strategy)
- [Failure signatures](#failure-signatures)
- [Extension checklist](#extension-checklist)
- [Sources and freshness](#sources-and-freshness)

## Evidence and version lines

Use the active repository's configuration contract to define merge policy.
The `packages/config` owner below is an anonymized illustrative resolver,
adapted from a historical project review. Its local schemas and helpers are
example application code, not maintained exports from c12 or defu.

The historical example resolved c12 3.3.4 and c12 4.0.0-beta.5, with jiti 2.7.0
and defu 6.1.7. Its CLI selected c12 4 beta while other consumers could resolve
c12 3. These versions describe that example. Verify the active graph before
using its layer fields, loader options, defaults, or TypeScript-loading behavior.

Before changing config code:

1. identify which manifest owns the active resolver;
2. trace the exact c12 instance imported by that resolver;
3. inspect its public types and the lockfile-resolved jiti/defu versions;
4. inspect actual `loadConfig()` options, not c12 defaults from memory;
5. create a temporary project and execute discovery, `extends`, environment,
   factory, and malformed-export cases through the public resolver.

## Responsibility map

| Owner | Responsibilities | Exclusions |
|---|---|---|
| c12 | File discovery, supported formats, RC/package/global sources when enabled, `extends`, environment layers, config factories, watch/update features, layer metadata | Application merge semantics, domain defaults, final runtime validation |
| jiti | Runtime loading/evaluation of TypeScript and JavaScript config modules where c12 uses it | Configuration precedence or trust policy |
| defu | Default-style recursive pair merge and custom merger hook | Complete multi-layer operation language or final schema validation |
| application resolver | Enabled sources, trust policy, precedence, low-to-high evaluation, operations, atomic fields, sanitation, provenance | Parser token grammar |
| Zod/Valibot | Authored shape, sparse patch, resolved runtime config, transformations, defaults | Discovery or code evaluation |
| Optique | CLI/environment/config bindings and early config selection | Project inheritance and merge policy |

Do not hide ownership inside a generic `loadConfig()` call. c12 defaults are
still product behavior if the application leaves them enabled.

## Configuration shapes

Keep at least three schemas:

| Shape | Contains | Must not contain |
|---|---|---|
| Authoring patch | Partial fields, ergonomic strings, shorthands, array operations, dynamic factory result | Runtime-only derived state |
| Resolved sparse patch | Normalized ordinary data, plain arrays, no defaults unless explicitly authored | `$append`, `$prepend`, `$replace`, c12 metadata |
| Runtime configuration | Complete values, defaults, normalized aliases, semantic values | Missing required values, authoring operations |

Example:

```ts
const AuthoringSchema = z.object({
	routes: z.union([
		z.array(z.string()),
		z.object({ $append: z.array(z.string()) }).strict(),
		z.object({ $prepend: z.array(z.string()) }).strict(),
		z.object({ $replace: z.array(z.string()) }).strict(),
	]).optional(),
});

const PatchSchema = z.object({
	routes: z.array(z.string()).optional(),
});

const RuntimeSchema = z.object({
	routes: z.array(z.url()).default([]),
});
```

Infer types from schemas. Do not maintain handwritten parallel interfaces that
can drift from accepted input or output.

## Resolution stages

Use one explicit pipeline:

```text
select cwd, explicit path, environment, and source policy
  -> c12 discovers and evaluates authored file layers
  -> validate every retained authored layer
  -> normalize c12 exports and metadata
  -> build sparse environment patch
  -> build sparse CLI/programmatic patch
  -> merge highest-priority inputs using low-to-high evaluation
  -> remove authoring operations and loader-only metadata
  -> validate resolved sparse patch
  -> apply defaults and semantic transformations once
  -> return runtime config plus provenance
```

The illustrative resolver calls c12 with an intentionally narrow source policy:

```ts
await loadConfig({
	cwd,
	name: "project",
	configFile: resolvedConfigFile,
	configFileRequired: Boolean(resolvedConfigFile),
	rcFile: false,
	globalRc: false,
	packageJson: false,
	dotenv: false,
	envName: false,
	omit$Keys: true,
	merger: mergeC12ConfigInputs,
	context,
});
```

This proves only that one revision disables RC, global RC, package metadata,
dotenv, and environment-specific layers. It does not mean c12 lacks them or the
product should always disable them. The important merger detail is that c12 gets
a loader-aware merger, not the strict public application merger.

## c12 loading capabilities

Decide each capability explicitly:

- conventional named config discovery;
- explicit config path and missing-explicit-file failure;
- JavaScript/TypeScript module loading;
- JSON, JSONC, YAML, or TOML according to installed support and product policy;
- `extends` chains and preset packages;
- environment-specific config branches;
- RC, user/global RC, and package metadata sources;
- dotenv loading and mutation policy;
- dynamic whole-config factories with a typed context;
- layer metadata and config-file provenance;
- watching/reloading;
- configuration creation/update hooks.

Do not enable remote `extends` casually. Remote presets expand the trust and
reproducibility requirement. Prefer installed, version-pinned presets. If remote
fetching is allowed, document protocol, cache, integrity, offline behavior,
credentials, redirects, and failure policy.

Resolve relative paths against their owning layer when the field semantics
require it. Do not resolve all paths against the process cwd after layers from
several directories have merged.

Define environment layer position. c12 discovery order is not automatically the
same as the product's public precedence. Prove it with conflicting values.

## Two mergers

c12 and the application resolver need different merge functions.

The c12 merger runs while c12 is still discovering and composing file layers. It
must preserve loader metadata and control fields long enough for c12 to consume
them: `extends`, environment branches, config-file layer metadata, and dynamic
factory results. It may normalize enough structure for layer composition, but it
must not run the complete runtime schema or reject loader-only keys too early.

The public application merger runs after c12 has loaded authored layers. It owns
product semantics: CLI/environment/config precedence, low-to-high operation
evaluation, plain-array replacement, operation-capable arrays, atomic
discriminated unions, strict unknown-key rejection, and final sparse patch
validation.

Do not pass the strict application merger directly as c12's `merger`. That can
reject `extends` before c12 processes it, and it can evaluate `$append` or
`$prepend` before inherited arrays from extended layers are available.

Use this shape:

```text
c12DefuMerger
  preserves loader metadata and c12 control fields
  composes config-file layers
  defers standalone array operations until inherited layers exist

mergeConfigInputs
  accepts only application-authored sparse patches
  applies explicit field semantics
  strips authoring operations
  validates one resolved sparse patch
```

Add an integration fixture where a top-level config file both `extends` a base
file and appends to an array from that base. The expected result proves c12
processed `extends` before the application merger validated the sparse output.

## Implementation algorithm

The illustrative resolver uses this algorithm. Check each step against the
active repository's merge contract before adapting local fields or helpers.

```text
authoring operation schemas
  -> authoring patch schema
  -> c12 layer schema with loader control keys
  -> c12 loader merger
  -> loaded config normalization
  -> CLI/env/file sparse patch merge
  -> standalone operation lowering
  -> sparse patch validation
  -> c12 metadata and undefined stripping
  -> complete runtime schema parse
  -> provenance build or overlay
```

Definitions:

| Function or schema | Job |
|---|---|
| `arrayOperationSchema(item)` | allow plain arrays, `$replace`, `$append`, and `$prepend` in authored files |
| `projectConfigAuthoringPatchSchema` | validate sparse config files before operations are lowered |
| `projectConfigLayerSchema` | allow root c12 controls such as `extends`, `$env`, and named env branches |
| `projectConfigExportValueSchema` | accept object export or array shorthand |
| `resolveStandaloneOperations()` | convert unresolved operation envelopes to arrays when no inherited value exists |
| `defuMerger` | apply application merge exceptions inside defu pair merging |
| `c12DefuMerger` | defer append/prepend without inherited arrays during c12 loading |
| `mergeC12ConfigInputs()` | c12-only custom merger |
| `mergeConfigInputs()` | public app merger, called highest-to-lowest but evaluated low-to-high |
| `normalizeLoadedConfig()` | convert c12 output into an app sparse patch |
| `sanitizeConfigInput()` | remove `extends`, `$meta`, and `undefined` before final sparse validation |
| `applyConfigPatch()` | merge one parsed Optique patch over an existing resolved config snapshot |

The app merger callback handles only exceptions:

```text
incoming $replace                    -> copy replacement array
incoming $append + inherited array    -> inherited then appended
incoming $append alone                -> appended only
incoming $prepend + inherited array   -> prepended then inherited
incoming $prepend alone               -> prepended only
incoming plain array over array       -> copy incoming array
sources.commoncrawl.crawls object     -> replace atomically
everything else                       -> return false to defu
```

The c12 merger changes one rule:

```text
append/prepend without inherited array -> return false, do not lower yet
```

c12 may still be about to merge an extended base layer. Lowering too early loses
the chance to compose with that inherited array.

The public app merge reverses caller order:

```text
caller order:    CLI, env, file
evaluation order: file, env, CLI
```

Then it parses `resolveStandaloneOperations(resolved)` with the sparse patch
schema. That last parse is the guard that operation envelopes and loader-only
fields did not leak toward runtime.

## Dynamic factories and jiti

Use a whole-config factory when configuration genuinely depends on typed load
context:

```ts
export default defineConfig(({ cwd, environment }) => ({
	root: cwd,
	output: environment === "production" ? "./dist" : "./tmp",
}));
```

Keep factories:

- deterministic for a supplied context;
- side-effect-light;
- bounded and cancellable if asynchronous behavior is allowed;
- free of command execution;
- validated immediately after evaluation;
- evaluated once per CLI invocation.

jiti is a code loader, not a sandbox. A TypeScript config module can execute
arbitrary code with the process's permissions. Treat config trust like code
trust. Do not load untrusted project configuration during `--help`, completion,
or other early surfaces unless the product explicitly requires it.

Avoid arbitrary field-level callback functions. They cannot be represented in
JSON/JSONC, complicate provenance, and introduce hidden evaluation order. Use
serializable operations for merge behavior and reserve a whole-config factory
for actual computation.

Two-pass parsing can accidentally evaluate a factory twice. Count executions in
an integration test:

```ts
let loads = 0;
export default defineConfig(() => {
	loads += 1;
	return { output: `./run-${loads}` };
});
```

The public command should observe one load and a stable value. A test-only
counter can live in a fixture module or write to a temporary marker.

## Precedence and evaluation order

Document caller precedence from highest to lowest:

```text
CLI/programmatic patch
  > environment patch
  > explicit/project config
  > user/global/preset layers if enabled
  > derived default
  > runtime-schema default
```

Evaluate compositional operations from the foundation upward:

```text
caller: mergeConfigInputs(cli, env, file)
execution: file -> env -> cli
```

This difference is essential. An environment prepend needs a resolved file
array, and a CLI append needs the result of both.

Ignore missing layers, not meaningful falsy leaves. Preserve `false`, `0`, an
explicit empty string where schema-valid, and an empty array. Define `null`
semantics per field or reject it; do not let a generic merge library decide.

Apply derived and schema defaults after authored precedence. A higher sparse
layer must not receive defaults that mask lower authored values.

## Merge algebra

Classify every field:

| Category | Default rule |
|---|---|
| Scalar leaf | Higher defined value wins |
| Ordinary object | Recursively merge properties |
| Plain array | Higher array replaces complete lower array |
| Operation-capable array | Apply declared operation to resolved inherited array |
| Discriminated union | Higher branch replaces atomically |
| Default | Apply once after sparse merge |

Do not inherit defu's array concatenation as accidental product behavior. A
route list, sink list, schema list, seed module list, or status filter may need
replacement, ordered composition, or deduplication. Decide path by path.

Use a custom defu merger for pairwise exceptions:

```ts
type Merger = Parameters<typeof createDefu>[0];

const merger: Merger = (target, key, incoming, namespace) => {
	const inherited = target[key];

	if (isAppend(incoming)) {
		setMergedValue(
			target,
			key,
			Array.isArray(inherited)
				? [...inherited, ...incoming.$append]
				: [...incoming.$append],
		);
		return true;
	}

	if (Array.isArray(incoming)) {
		setMergedValue(target, key, [...incoming]);
		return true;
	}

	if (namespace === "sources.commoncrawl" && key === "crawls") {
		setMergedValue(target, key, structuredClone(incoming));
		return true;
	}

	return false;
};
```

Inspect the installed defu callback orientation. In the observed contract,
`target[key]` is the inherited lower value and `incoming` is the higher layer.
A callback that returns `true` without assigning the intended value can keep the
wrong side.

Isolate the required generic indexed-assignment assertion in one documented
helper. Do not scatter unsafe casts through the merger.

Copy arrays and mutable nested operation values. The resolved config must not
alias caller inputs.

## Declarative array operations

Use serializable data:

```ts
export function replace<const T>(values: readonly T[]) {
	return { $replace: [...values] } as const;
}

export function append<const T>(values: readonly T[]) {
	return { $append: [...values] } as const;
}

export function prepend<const T>(values: readonly T[]) {
	return { $prepend: [...values] } as const;
}
```

Define exact semantics:

| Authored value | Inherited `[A, B]` | No inherited value |
|---|---|---|
| `[C]` | `[C]` | `[C]` |
| `{ $replace: [C] }` | `[C]` | `[C]` |
| `{ $append: [C] }` | `[A, B, C]` | `[C]` |
| `{ $prepend: [C] }` | `[C, A, B]` | `[C]` |

Raw pairwise defu reduction may never call the custom merger for a standalone
operation. Normalize operations that have no inherited value after traversal:

```ts
function resolveStandalone(value: unknown): unknown {
	if (isReplace(value)) return [...value.$replace];
	if (isAppend(value)) return [...value.$append];
	if (isPrepend(value)) return [...value.$prepend];
	if (Array.isArray(value)) return value.map(resolveStandalone);
	if (!isPlainRecord(value)) return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, resolveStandalone(child)]),
	);
}
```

Resolve one layer at a time from low to high so an operation never receives an
unresolved operation object as its inherited value.

Do not silently deduplicate. Duplicates may be meaningful. If a field needs
set-like behavior, specify equality, normalization, ordering, and provenance as
field semantics outside the generic merger.

## Atomic unions and special fields

Recursively merging discriminated union branches creates impossible hybrids:

```text
lower:  { kind: "range", from: "A", to: "B", limit: 3 }
higher: { kind: "named", crawls: ["C"] }
wrong:  { kind: "named", crawls: ["C"], from: "A", to: "B", limit: 3 }
```

Replace the entire value when the higher layer selects a new branch. Key the
exception by a schema-known path, not a broad “objects with a `kind` key” guess.

Other fields may need atomic replacement: credential providers, output
destinations, retry strategies, database connection modes, authentication
methods, and deployment targets. Inventory unions when schemas change.

## Provenance and inspection

Return normalized c12 layers alongside the runtime config. Preserve at least:

- source kind;
- resolved path or package/preset identifier;
- environment/extends relationship;
- authored sparse contribution;
- evaluation order;
- load timestamp or revision where reproducibility matters.

Maintain per-field winners if `config explain` is promised:

```ts
const ValueProvenanceSchema = z.object({
	path: z.string(),
	winner: z.object({ source: z.string(), detail: z.string().optional() }),
	shadowed: z.array(z.object({
		source: z.string(),
		detail: z.string().optional(),
	})).default([]),
	operations: z.array(z.string()).default([]),
});
```

`config files` must report every contributing layer, not only the final
`_configFile`. `config explain` must report actual winners and shadowed values,
not print a static precedence list.

Redact secrets before rendering resolved config or provenance. Avoid serializing
executable source or arbitrary error objects into support output.

## Configuration mutation

Use configuration mutation only with explicit target and consent:

1. select the owned project or user file;
2. parse and validate its authored shape;
3. build the intended patch;
4. show a diff for `--dry-run` and interactive review;
5. write atomically;
6. preserve source style where practical;
7. reload through the public resolver;
8. report the exact changed path.

Use c12 creation/update hooks where supported. Use `magicast` for
source-preserving TypeScript/JavaScript edits and `confbox` for structured
formats such as JSONC/YAML/TOML. Do not apply a JSON serializer to a TypeScript
config or discard comments in a user-authored file without authorization.

`rc9` can own XDG-aware user RC reads/writes. Keep user config distinct from
project config and document their precedence and uninstall/preservation policy.

## Validation stages

Validate retained source layers, not only c12's final merged object. A malformed
scalar export can be hidden or collapsed during generic merging.

Use this order:

```text
each authored export -> authoring schema
merged operations -> resolved sparse patch schema
defaults/transforms -> complete runtime schema
```

Never pass authoring operation objects to source adapters. Use strict schemas to
reject unknown keys unless extension fields are deliberately supported.

Keep external source errors distinct:

- explicit config file missing;
- unsupported extension/format;
- evaluation/import failure;
- invalid factory return;
- cyclic or failed `extends`;
- malformed layer value;
- invalid merged patch;
- invalid complete runtime config.

Render the layer path and schema issue path without leaking secrets.

## Testing strategy

Test three stages:

1. merger unit tests: generic pair orientation, field exceptions, immutability,
   operations, arrays, and atomic unions;
2. public resolver tests: valid public authoring shapes, source precedence,
   defaults, provenance, and strict output;
3. c12 integration fixtures: real file discovery, formats, extends, environment
   layers, factories, malformed exports, and exact version behavior.

Required matrix:

- missing versus `false`, `0`, empty string, and empty array;
- ordinary nested object contribution from three layers;
- plain array replacement and empty-array clearing;
- replace/append/prepend with and without inheritance;
- operation-on-operation across file, environment, and CLI;
- atomic union branch changes;
- no input aliasing;
- defaults applied once after merge;
- explicit file required/missing;
- nested extends and path resolution;
- dynamic factory evaluated once;
- malformed scalar, array, and unknown-key exports;
- layer list, winner, shadowed value, and operation provenance;
- help/version behavior when config is invalid;
- c12 3 versus c12 4 behavior if both are supported.

Run type checking against the public types. defu's generic callback commonly
exposes `string | symbol` keys; use `String(key)` in diagnostics and isolate
indexed writes.

## Failure signatures

| Symptom | Likely cause | Corrective action |
|---|---|---|
| `$append` reaches runtime | Standalone operation was not normalized | Resolve operations after low-to-high traversal and validate patch |
| CLI append drops file values | Layers evaluated high-to-low | Reverse traversal and apply one higher layer at a time |
| Plain arrays concatenate | Inherited defu default was not overridden | Add explicit array replacement branch |
| Empty array fails to clear | Truthiness/missing logic treats it as absent | Distinguish `undefined` from valid empty values |
| Union contains fields from two variants | Recursive merge crossed atomic branch | Add precise path replacement |
| Factory side effect occurs twice | Source context and handler both reload c12 | Load once at composition root and reuse result |
| Defaults override an authored lower value | Patch schema injected defaults per layer | Keep sources sparse; default final runtime schema once |
| `config explain` lacks actual winners | Provenance discarded during merge | Track field contributions while resolving |
| `config files` shows one file | Only `_configFile` retained | Normalize all c12 layer metadata |
| Malformed scalar becomes empty config | Only final c12 result was validated | Validate retained source layers before normalization |
| Output mutates when input array changes | Merger retained caller reference | Clone arrays/operation payloads |
| TS error on `target[key]` | Generic defu indexed assignment | Use one documented mutation adapter |
| Config works on one package only | c12 major/prerelease lines diverge | Pin owner and run version-specific fixtures |
| `.env` winner differs by command | Multiple loaders own same environment setting | Create one source algebra and visible precedence |
| Remote preset changes without lock update | Mutable `extends` trust transition | Pin installed preset or require integrity/cache policy |

## Extension checklist

For each new field:

1. classify it as scalar, recursive object, plain array, operation array, atomic
   union, or specialized value;
2. add it to the authored schema;
3. add the normalized field to the sparse patch without defaults;
4. add the runtime field and defaults/transforms;
5. define `undefined`, `null`, falsy, empty, and deletion semantics;
6. define source precedence and enabled sources;
7. add a path-specific merger rule only when necessary;
8. add provenance rendering and redaction policy;
9. test one, two, and three conflicting layers through real c12 files;
10. confirm no authoring syntax reaches a runtime consumer.

For each new array operation, define behavior with no inherited array, order,
duplicates, immutability, serialization, provenance, and final-schema validity.
Reject operations whose semantics cannot be explained consistently in
TypeScript and JSONC.

## Sources and freshness

- Portable contract guidance: [configuration](config.md) and [CLI architecture](architecture.md).
- Historical source scope: configuration and CLI reviews from 2026-07-17 and
  2026-07-22, adapted here into an anonymized resolver example.
- c12 official source: <https://github.com/unjs/c12>, discovery pointer for current loader APIs and version history.
- defu official source: <https://github.com/unjs/defu>, discovery pointer for current merger callback behavior.
- jiti official source: <https://github.com/unjs/jiti>, discovery pointer for loader/runtime behavior.

Historical version scope: the resolver example used c12 3.3.4 and
4.0.0-beta.5, defu 6.1.7, and jiti 2.7.0. The recorded two-merger review concerned
c12 4 beta. This example does not prove current behavior. Verify layer metadata,
callback orientation, and both mergers with the active installed version.
