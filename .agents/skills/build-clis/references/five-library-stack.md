# Optique, c12, defu, LogTape, and Zod stack

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


## Use this reference

Load this reference whenever a CLI uses two or more of these at the same
ownership: Optique, c12, defu, LogTape, and Zod. The failure mode is rarely that
one library is bad. The failure mode is that two good libraries both become the
owner of the same decision.

The target mental model:

```text
public CLI language
  Optique terms, help, suggestions, completion, manuals
      |
      v
sparse source contributions
  CLI patch, env patch, config patch, derived patch
      |
      v
project configuration loading
  c12 discovers, evaluates, extends, environments, and layer metadata
      |
      v
application merge policy
  defu-powered internals behind explicit app semantics
      |
      v
runtime contract
  Zod validates, transforms, and applies defaults once
      |
      v
execution and observation
  handler receives injected capabilities; LogTape routes redacted results
```

If an implementation cannot draw this graph for one option, one config key, one
result, and one failure, it is not done.

## Contents

1. [The ownership map](#the-ownership-map)
2. [Data shapes](#data-shapes)
3. [Default taxonomy](#default-taxonomy)
4. [Optique patterns](#optique-patterns)
5. [c12 and defu patterns](#c12-and-defu-patterns)
6. [LogTape patterns](#logtape-patterns)
7. [Zod patterns](#zod-patterns)
8. [One-snapshot execution](#one-snapshot-execution-recipe)
9. [End-to-end trace and audit](#end-to-end-trace-example)
10. [Required tests and failure signatures](#required-test-matrix)

For the precise `.default()`/`.prefault()` rules, `@optique/zod` integration,
nested-object defaults, and field-level provenance algorithm, load
[defaults-provenance.md](defaults-provenance.md). For performance work, load
[benchmarking.md](benchmarking.md); a microbenchmark must not replace the
semantic matrix in this reference.

## The ownership map

| Decision | Owner | Good sign | Bad sign |
|---|---|---|---|
| What token shapes are accepted | Optique | Illegal forms are impossible or rejected before the handler | Handler receives `foo?: boolean`, `no_foo?: boolean`, and guesses intent |
| What users see in help/completion/man pages | Optique | Parser terms expose choices, aliases, metavars, hidden compatibility, documented defaults | Help text is handwritten and drifts from parsing |
| Which values were supplied by CLI | Optique parser output | Absent source-bearing options stay `undefined` | Parser default appears as a CLI value |
| Which files and layers exist | c12 | Explicit policy for discovery, `extends`, environment branches, dotenv, RC, package metadata | App code scans config files beside c12 or relies on c12 defaults accidentally |
| How loader control fields survive loading | c12-aware merger | `extends` and environment metadata survive until c12 consumes them | Strict app schema rejects `extends` before loading finishes |
| How app values merge | Application merger, using defu only internally | Field categories are explicit and tested | Public `defu(cli, env, file)` decides arrays, unions, and nulls |
| What complete runtime values mean | Zod complete schema | Defaults and transforms apply once after all sources merge | Sparse schemas contain `.default()` and mask lower layers |
| Where diagnostics and results go | LogTape composition root | Libraries receive loggers; executable configures sinks and redaction | Libraries call `console.*` or configure LogTape globally |
| What the domain may do | Portable handler contract | Handler receives `{ config, logger, fs, fetch, signal }` or equivalent | Handler reads argv/env/config or exits the process |

## Data shapes

Use names that make source state obvious.

| Shape | Example fields | Defaults? | Owner |
|---|---|---|---|
| `CliOptions` | `out_dir?: string`, `range_cache_enabled?: boolean` | No for source-bearing fields | Optique parser |
| `EnvPatch` | `logging?: { level?: string }` | No | env adapter |
| `ConfigAuthoringPatch` | ergonomic strings, `$append`, `extends`-adjacent authored data | No runtime defaults | c12 layer validation |
| `ConfigPatch` | normalized sparse ordinary data | No | application resolver |
| `AppConfig` | complete values consumed by handlers | Yes | Zod complete schema |
| `CommandResult` | stable machine output | Usually explicit defaults for arrays | Zod result schema |
| `DiagnosticEvent` | level, category, message, properties | Schema defaults only for stable event fields | LogTape formatter/sink handoff |

Bad:

```ts
const CliOptionsSchema = z.object({
	out_dir: z.string().default("./out"),
});

const parser = object({
	out_dir: option("--out-dir", string()).withDefault("./out"),
});
```

This creates two defaults before source precedence is known. The CLI default
can outrank config even when the user did not pass `--out-dir`.

Good:

```ts
const CliPatchSchema = z.object({
	out_dir: z.string().optional(),
});

const AppConfigSchema = z.object({
	out_dir: z.string().trim().min(1).default("./out"),
});

const parser = object({
	out_dir: optional(option("--out-dir", string({ metavar: "DIRECTORY" }))),
});
```

Document `./out` in help without returning it from the parser when the option is
absent.

## Default taxonomy

| Default kind | Example | Mechanism | Enters sparse patch? |
|---|---|---|---|
| Runtime fallback | default output directory | Zod `.default()` on complete schema | No |
| Transforming fallback | default string that must trim/case/codec | Zod `.prefault()` on complete schema | No |
| Parser-local fallback | `--color` defaults to `auto` and has no config/env source | Optique `withDefault()` | Yes, intentionally |
| Help-only default | show `default: 4` for omitted concurrency | Optique document metadata helper | No |
| Handler-time fallback | prompt for a token only when command actually runs | Optique `deferredValue()` | No scalar until handler calls it |
| Error recovery fallback | tolerate malformed optional legacy input | Zod `.catch()` with explicit policy | Not for normal config |
| Derived fallback | infer cache dir from project root | derived source below authored values | No, unless recorded as derived provenance |

Decision rule:

1. If the value should lose to config or env, it is not an Optique parser
   default.
2. If the fallback is an ordinary literal, it belongs in the complete schema.
3. If the fallback must run a transform, use `.prefault()`.
4. If the fallback requires a prompt, secret provider, expensive lookup, or
   handler context, use `deferredValue()`.
5. If the fallback should appear in help, add documentation metadata and test
   that parse output stays sparse.

## Optique patterns

### Choices from schemas

Good:

```ts
const LogLevelSchema = z.enum(["debug", "info", "warning", "error"]);

const logLevel = option(
	"--log-level",
	choice(LogLevelSchema.options, { suggest: "nearest" }),
);
```

Why:

- Zod owns the persisted/runtime enum contract.
- Optique owns spelling suggestions, choices, help, and completion.
- The option list has one literal source.

Bad:

```ts
const logLevel = option("--log-level", string());
const LogLevelSchema = z.enum(["debug", "info", "warning", "error"]);
```

This forces Optique to treat `--log-level debgu` as any other string until a
later schema error. Users lose parser-aware suggestions.

### Boolean overrides

Good:

```ts
const patch = object({
	range_cache_enabled: optional(negatableFlag({
		positive: "--range-cache",
		negative: "--no-range-cache",
	})),
});
```

States:

| argv | patch |
|---|---|
| none | `{}` |
| `--range-cache` | `{ range_cache_enabled: true }` |
| `--no-range-cache` | `{ range_cache_enabled: false }` |
| both | parse error |

The complete schema can still default `range_cache_enabled` after config/env
precedence.

### Deferred values

Use `deferredValue()` for a secret prompt:

```ts
const parser = object({
	service: option("--service", choice(["github", "gitlab"] as const)),
	token: deferredValue(
		optional(option("--token", string({ metavar: "TOKEN" }))),
		async ({ service }: { readonly service: string }) =>
			await promptForToken(service),
		{ memoize: true },
	),
});

async function handler(options: ParsedOptions) {
	const token = await options.token({ service: options.service });
}
```

Do not use it for:

```ts
deferredValue(optional(option("--timeout", integer())), () => 30);
```

That is a schema default pretending to be a handler-time fallback.

### Help-only documented defaults

Use a local helper when the project needs default text in help but sparse parse
output:

```ts
const parser = object({
	timeout_seconds: optional(documentDefault(
		option("--timeout", integer({ min: 1, metavar: "SECONDS" })),
		30,
	)),
});
```

Tests:

| Test | Assertion |
|---|---|
| `app --help` | contains `--timeout` and `default: 30` |
| `parse([])` | `timeout_seconds` is absent or `undefined` |
| config has timeout 10 and CLI omits it | final config is 10 |
| CLI passes `--timeout 5` | final config is 5 |

## c12 and defu patterns

### Two mergers

Wrong:

```ts
await loadConfig({
	name: "app",
	merger: mergeConfigInputs,
});
```

Why it fails:

- c12 control keys such as `extends` may be rejected by strict app validation.
- `$append` can be evaluated before the inherited array from an extended file is
  available.
- loader metadata and application semantics become one untestable function.

Right:

```ts
await loadConfig({
	name: "app",
	merger: mergeC12ConfigInputs,
});

const patch = mergeConfigInputs(cliPatch, envPatch, loaded.config);
const config = AppConfigSchema.parse(patch);
```

Mental model:

```text
base config file
  -> c12 loader merger keeps loader fields alive
extended config file
  -> c12 returns one authored sparse object
CLI and env patches
  -> app merger applies product precedence
complete schema
  -> Zod applies final defaults
```

### Illustrative implementation anatomy

The anonymized implementation example has several small pieces. Map each
responsibility to the active repository before adapting the pattern.

| Piece | File-local role | Why it exists |
|---|---|---|
| `arrayReplaceOperationSchema()` | validates `{ $replace: [...] }` envelopes | author can state replacement explicitly |
| `arrayAppendOperationSchema()` | validates `{ $append: [...] }` envelopes | author can compose above inherited arrays |
| `arrayPrependOperationSchema()` | validates `{ $prepend: [...] }` envelopes | author can place higher-layer values first |
| `arrayOperationSchema(item)` | accepts plain array or one operation envelope | one authoring language for arrays |
| `projectConfigAuthoringPatchSchema` | sparse file shape with operation-capable fields | config files are not runtime configs |
| `projectConfigLayerSchema` | authoring patch plus c12 root control keys | `extends`, `$env`, `$development`, `$production`, `$test`, `$meta` are loader-stage only |
| `projectConfigExportValueSchema` | object layer or array shorthand | root arrays mean several application patches, not c12 control layers |
| `replace()`, `append()`, `prepend()` | TypeScript helpers returning plain operation data | TS config ergonomics without runtime callbacks |
| `isArray*Operation()` guards | runtime envelope detection | defu callback sees unknown values |
| `resolveStandaloneOperations()` | recursively lowers operations with no inherited array | lowest-layer operations cannot be resolved by defu pair callbacks |
| `defuMerger` | application pair merge rule | arrays, operations, atomic unions, and copies |
| `c12DefuMerger` | loader-stage pair merge rule | preserves c12 control behavior and defers some operations |
| `mergeC12ConfigInputs()` | c12 `loadConfig({ merger })` adapter | compose c12 layers without strict app parsing |
| `mergeConfigInputs()` | public application merge | high-to-low API, low-to-high evaluation, final sparse validation |
| `normalizeLoadedConfig()` | c12 result to app sparse patch | validates root export and array shorthand |
| `sanitizeConfigInput()` | removes c12-only and undefined fields | public sparse patch must not contain loader leftovers |
| `projectConfigSchema.parse()` | complete runtime parse | final defaults and semantic refinements happen once |
| `applyConfigPatch()` | patch over an existing resolved snapshot | Optique hook path avoids reloading dynamic config |

The important shape is not “use defu.” It is this:

```text
authoring schemas accept ergonomic source syntax
  -> c12 loader merger composes loader layers without final validation
  -> normalize loaded result into a sparse app patch
  -> app merger evaluates source patches by product precedence
  -> standalone operations are lowered
  -> sparse patch schema rejects unresolved authoring syntax
  -> complete Zod schema applies runtime defaults
```

### Export and layer validation

The example accepts two root export shapes:

```ts
export default {
	extends: "./base.config.ts",
	$development: { log: { level: "debug" } },
	sources: {
		browser: {
			routes: { $append: ["https://main.example/"] },
		},
	},
};
```

or:

```ts
export default [
	{ outDir: "one" },
	{ log: { level: "debug" } },
];
```

The root object may contain c12 control keys. Array elements are only application
patch shorthand and intentionally cannot contain `extends`, `$env`, or named
environment branches. That prevents a root array from becoming an ambiguous
mini-loader language.

Validation occurs in two places:

1. retained c12 file layers are checked with the export schema so malformed file
   exports fail before source adapters receive them;
2. the normalized merged result is checked with the sparse patch schema so
   operation objects and loader metadata cannot reach runtime consumers.

### Pair-merger mechanics

The example's app merger is a defu callback with this orientation:

```text
target[key] = inherited lower-precedence value
value       = incoming higher-precedence value
namespace   = dotted parent path
```

Returning `true` means “I completed the merge for this property.” The callback
must assign the intended value before returning:

```ts
if (Array.isArray(target[key]) && Array.isArray(value)) {
	target[key] = [...value];
	return true;
}
```

Returning `true` without assigning leaves the lower value in place. Returning
`false` delegates to defu's ordinary scalar/object behavior.

App merger rules:

| Condition | Assignment | Reason |
|---|---|---|
| incoming `$replace` | copy `$replace` array | explicit replacement |
| incoming `$append` and inherited is array | inherited then appended | compose upward |
| incoming `$append` without inherited array | appended array only | standalone operation |
| incoming `$prepend` and inherited is array | prepended then inherited | priority values first |
| incoming `$prepend` without inherited array | prepended array only | standalone operation |
| incoming plain array over inherited array | copy incoming array | arrays replace, no concatenation |
| `namespace === "sources.commoncrawl"` and `key === "crawls"` | copy incoming object | discriminated union is atomic |
| otherwise | return `false` | let defu handle scalar/object merge |

c12 merger difference:

```ts
if ((isAppend(value) || isPrepend(value)) && !Array.isArray(inherited)) {
	return false;
}
return defuMerger(target, key, value, namespace);
```

That `return false` is deliberate. During c12 `extends`, an append in the child
may not yet see the base array. The loader-stage merger must not collapse it too
early. The final app merge lowers any standalone operation after c12 has
finished producing the loaded file patch.

### Public merge evaluation

The public API is highest-to-lowest:

```ts
mergeConfigInputs(cliPatch, envPatch, filePatch);
```

The loop evaluates low-to-high:

```text
resolved = {}
merge file over {}
merge env over resolved file
merge CLI over resolved env+file
parse resolveStandaloneOperations(resolved) with ConfigPatchSchema
```

The reversal is necessary because operations need inherited values. A caller
should not pass layers low-to-high; the function owns that reversal.

Example:

```ts
mergeConfigInputs(
	{ sources: { browser: { routes: append(["cli"]) } } },
	{ sources: { browser: { routes: prepend(["env"]) } } },
	{ sources: { browser: { routes: ["file"] } } },
);
```

Resolution:

```text
file: ["file"]
env:  prepend(["env"]) over ["file"]      -> ["env", "file"]
CLI:  append(["cli"]) over ["env","file"] -> ["env", "file", "cli"]
```

### Loaded config normalization

After c12 returns, the example normalizes as follows:

| Loaded value | Normalization |
|---|---|
| `null` or `undefined` | `{}` |
| root array | parse every element as an authoring patch, then `mergeConfigInputs(...items)` |
| root object | parse as one authoring patch, then `mergeConfigInputs(object)` |

Then `resolveConfig()` builds:

```text
filePatch = normalizeLoadedConfig(loaded.config)
envPatch  = readEnvPatch(PROJECT_*)
cliPatch  = projectConfigPatchSchema.parse(options.patch ?? {})
merged    = mergeConfigInputs(cliPatch, envPatch, filePatch)
sanitized = stripUnsupportedC12Keys(stripUndefinedValues(merged))
config    = projectConfigSchema.parse(sanitized)
```

Only the final `projectConfigSchema.parse()` applies runtime defaults.

### Provenance overlay

The example records leaf-level provenance after final defaults are known:

```text
if CLI/env/file patch has the leaf path -> that layer wins
else -> schema_default
```

`applyConfigPatch(base, patch, "optique", overrides)` overlays provenance on an
existing resolved snapshot. It preserves earlier provenance when an Optique
source re-emits the same fallback value. It marks leaves as `cli` only when
their option aliases appeared in `argv`; otherwise the origin remains
`optique`, meaning the value came through Optique source resolution rather than
an explicit token.

This distinction matters for `config explain`: “Optique-resolved” is not always
“typed by the user on the command line.”

### Array operations

Given:

```ts
// base config
{ routes: ["file"] }

// env patch
{ routes: { $prepend: ["env"] } }

// CLI patch
{ routes: { $append: ["cli"] } }
```

Public precedence is `CLI > env > file`, but operation evaluation is low to
high:

```text
["file"]
  -> prepend ["env"] = ["env", "file"]
  -> append ["cli"] = ["env", "file", "cli"]
```

Required tests:

- operation with inherited array;
- operation with no inherited array;
- operation after `extends`;
- operation on operation across three layers;
- empty array replacement;
- no input aliasing;
- provenance records operation source.

### Atomic unions

Wrong merge:

```text
lower:  { kind: "range", from: "2024-01", to: "2024-02" }
higher: { kind: "named", crawls: ["CC-MAIN-2024-10"] }
result: { kind: "named", crawls: [...], from: "...", to: "..." }
```

Right rule: replace the whole value at schema-known union paths.

Do not make every object atomic. Ordinary config objects still merge by field.
Only union-like fields and explicitly atomic fields replace as a unit.

## LogTape patterns

Categories are contracts:

| Category | Sink | Parent sinks? | Payload |
|---|---|---|---|
| `app.result` | stdout raw sink | Override | exact stable result text or bytes |
| `app.diagnostic` | stderr human/json/file | Inherit diagnostic graph | structured operational events |
| `app.config` | diagnostic graph | Inherit | loader, validation, provenance events |
| `app.bootstrap` | minimal early diagnostic graph | Inherit only bootstrap sinks | failures before final config |
| `app.deprecation` | diagnostic graph | Inherit | public interface compatibility warnings |

Rules:

- Redact structured properties before formatting.
- Do not serialize secrets into `result_text` before redaction.
- Use a raw result formatter for JSON, JSONL, completion scripts, and man pages.
- Flush LogTape before returning exit status.
- Libraries call `getLogger()` or receive a logger; they do not configure sinks.

Bad:

```ts
console.error("Loading config", config);
console.log(JSON.stringify(result));
```

Good:

```ts
logger.get(["app", "config"]).debug("Config layer loaded", {
	path,
	source,
});

resultLogger.info("Command result", {
	result_text: renderResult(redactStructured(result)),
});
```

## Zod patterns

Use three schemas for configuration:

```ts
const AuthoringPatchSchema = z.object({
	timeout: z.string().optional(),
	routes: RouteOperationSchema.optional(),
});

const ConfigPatchSchema = z.object({
	timeout_seconds: z.number().int().positive().optional(),
	routes: z.array(z.url()).optional(),
});

const AppConfigSchema = z.object({
	timeout_seconds: z.number().int().positive().default(30),
	routes: z.array(z.url()).default([]),
});
```

Use result schemas too:

```ts
const CommandResultSchema = z.object({
	schema_version: z.literal("1"),
	status: z.enum(["ok", "failed"]),
	artifacts: z.array(z.object({
		path: z.string(),
		kind: z.string(),
	})).default([]),
});
```

Do not trust TypeScript interfaces at external inputs where JSON, files, subprocess
output, logs, or persisted artifacts are involved.

## One-snapshot execution recipe

Implement this when a command needs config-backed parser sources and a handler
needs final config:

1. Parse only early controls from raw argv: help/version/completion, config
   path, logging format/output/silent, and no-config.
2. Configure a minimal LogTape bootstrap graph if a fallible operation comes
   next.
3. Load c12 once with a c12-aware merger and explicit source policy.
4. Validate retained authored layers.
5. Build Optique source contexts from that loaded snapshot and injected env.
6. Parse the full Optique program into sparse patches.
7. In `runProgram().hooks.beforeEach`, apply the parsed patch over the loaded
   snapshot using the strict app merger.
8. Parse the complete Zod runtime schema once.
9. Configure final LogTape sinks, filters, result route, and redaction.
10. Return `{ config, logger }` as the hook resource.
11. Handler receives parsed command value plus the resource; it does not reload
    config, read env, configure logging, or call `Deno.exit`.
12. `afterEach`/`onError` flushes and disposes resources.

Minimal shape:

```ts
interface AppResource {
	readonly config: AppConfig;
	readonly logger: Logger;
}

await runProgram<AppResource>({
	commands,
	metadata,
	hooks: {
		async beforeEach(invocation) {
			const cliPatch = CliPatchSchema.parse(invocation.value);
			const config = applyConfigPatch(loaded.config, cliPatch);
			const logger = await configureAppLogging(config.logging);
			return { resource: { config, logger } };
		},
		async afterEach(context) {
			await context.resource?.logger.flush();
		},
		async onError(context, error) {
			context.resource?.logger.error("Command failed", { error });
			await context.resource?.logger.flush();
		},
	},
});
```

## End-to-end trace example

Trace `--timeout`:

| Stage | Value | Owner |
|---|---|---|
| CLI absent | no patch field | Optique |
| `APP_TIMEOUT=10` | env patch `timeout_seconds: 10` | env adapter |
| config `timeout: "PT20S"` | file patch `timeout_seconds: 20` | c12 + authoring schema |
| derived default | not used because env/config exist | derived source |
| runtime default `30` | not used because sparse patch has value | Zod complete schema |
| final config | `10` if env outranks config | app merger |
| HTTP timeout | ofetch receives 10 seconds as app policy | HTTP adapter |
| provenance | env winner, config shadowed, default shadowed | resolver |
| help | shows `--timeout SECONDS`, maybe `default: 30` | Optique docs |
| tests | subprocess proves stdout/stderr/exit and final request | release gate |

If the CLI parser default returns `30`, env and config never get a fair chance.

## Audit questions

Ask these before editing:

1. Which fields are source-bearing and must stay sparse?
2. Which fields are parser-local and may use `withDefault()`?
3. Which defaults must pass through Zod transforms and therefore need
   `.prefault()`?
4. Which c12 sources are enabled, and is that product policy documented?
5. Does c12 receive a loader-aware merger rather than the strict app merger?
6. Which arrays replace, which compose, and which deduplicate?
7. Which object paths are atomic unions?
8. Does any dynamic config factory run more than once?
9. Can help/version/completion run when project config is broken?
10. Does LogTape have a separate raw result route and diagnostic route?
11. Does each output route have an explicit secret-exposure policy that hides
    verified secrets without removing required diagnostic evidence?
12. Does the handler receive all capabilities by injection?
13. Are generated completion and man surfaces produced from the parser?
14. Has the installed or compiled artifact been executed?

## Required test matrix

| Area | Cases |
|---|---|
| Parser absence | option omitted, config present; parser output stays sparse |
| Help defaults | help/man show documented default; parse omitted remains absent |
| Choices | valid choice, typo suggestion, completion list |
| Negatable flag | absent, true, false, conflict |
| Deferred value | specified branch, fallback branch, memoization, fallback error |
| c12 discovery | explicit path, missing explicit path, no-config, malformed config |
| c12 extends | base file, child override, child operation over base array |
| Environment branch | branch selected, branch disabled, branch precedence |
| Merge algebra | falsy values, plain arrays, operations, atomic unions, immutability |
| Defaults | config over default, env over config, CLI over env, final Zod default |
| Single snapshot | dynamic factory counter equals one |
| LogTape result | JSON stdout has no diagnostics; diagnostics go to stderr/file |
| Redaction/exposure | verified secret hidden on applicable routes; diagnostic IDs/paths preserved; stable result follows its own schema/policy |
| Bootstrap failure | invalid config honors raw logging options and leaves stdout empty |
| Generated surfaces | help, completion shells, man pages, hidden aliases |
| Package artifact | installed/compiled binary reaches each command |

## Example verification map

Use this map to select checks for the contracts the active repository adopts.
The entries describe required observations, not executed results for that repository.

| Invariant | Example observation |
|---|---|
| Leftmost input is highest precedence | `mergeConfigInputs({ outDir: "cli" }, { outDir: "env" }, { outDir: "file" })` returns `"cli"` |
| Missing higher layers inherit lower values | empty CLI/env patches preserve file patch |
| Null/undefined layers are skipped | `undefined`, `null`, and real layers produce only real contributions |
| `false` and `0` are explicit values | `emitStages: false`, `retries: 0`, `cdxMinDelayMs: 0` survive |
| Invalid sparse output still fails | empty strings or invalid worker concurrency throw after merging |
| Ordinary objects merge by property | `log.level` from CLI plus `log.format` from file both survive |
| Plain arrays replace | higher `mime: ["text/plain"]` does not concatenate inherited MIME filters |
| Empty arrays clear inherited values | higher `affiliatedHosts: []` resolves to `[]` |
| `$replace` discards inherited array | replacement routes remove file routes |
| `$append` composes after inherited array | inherited route then appended route |
| `$prepend` composes before inherited array | prepended route then inherited route |
| Standalone operations lower to arrays | single-layer `append(["x"])` returns `["x"]`, not `{ $append: ... }` |
| Duplicates are preserved | append duplicate route keeps both entries |
| Higher plain array beats lower operation | CLI array replaces env append plus file array |
| Higher replace beats lower operation | CLI replace discards env append plus file array |
| Common Crawl selector is atomic | named selector replaces range selector and drops `from`, `to`, `limit` |
| Only schema-known union path is atomic | unrelated property named `crawls` still recursively merges |
| Inputs are not mutated | snapshots before/after merge remain equal |
| Resolved arrays are copied | output array is not the same reference as incoming or inherited array |
| c12 `extends` resolves before defaults | base `outDir` and route plus child log level and `$append` all survive |
| c12 environment branch applies when selected | `$development` can override log settings when `envName` is explicit |
| c12 control keys are forbidden in array shorthand | root array element with `extends` is rejected |
| malformed exports fail early | string export throws schema-valid object/array/function error |
| JSONC parser preserves `//` inside strings | route with `/a//b` survives JSONC loading |
| defaults happen after sparse resolution | `projectConfigSchema.parse()` supplies defaults only after merge |
| `applyConfigPatch()` preserves snapshot provenance | re-emitted Optique fallback does not steal env provenance |
| dynamic config factory runs once | temp config increments a marker file and command sees count `1` |
| help-only defaults do not parse | `documentDefault()` docs include default while `parse([])` returns `undefined` |
| Zod enum choices power suggestions | typos such as `standart`, `domian`, `reachabl` suggest nearest valid choice |
| negatable flag is tri-state | absent, `--range-cache`, `--no-range-cache`, and conflict are tested |
| LogTape category routing is structured | recorder sink sees category `["project","test"]` and structured properties |
| diagnostic redaction wraps sinks | password field becomes `[REDACTED]` in diagnostic file |
| result route is raw stdout | `project.result` has `parentSinks: "override"` and writes `result` string to stdout |

When reporting verification, separate:

- focused unit tests for parser and merger rules;
- c12 fixture tests for real loading behavior;
- runtime CLI tests with `--no-check` when the checked graph is resource-heavy;
- generated surface tests for help, completion, and man output;
- broad type-check or workspace gates that were skipped, blocked, or OOM-limited.

## Failure signatures

| Symptom | Likely ownership bug |
|---|---|
| Config value ignored when CLI flag omitted | Optique default became a sparse CLI value |
| `extends` is an unknown key | c12 received strict app validation too early |
| `$append` appends to an operation object | Operation evaluated before inherited c12 layers resolved |
| Zod default appears in provenance as user-authored | Complete schema parsed a sparse layer |
| Help lists choices but completion does not | Choices are handwritten in docs rather than parser terms |
| Handler sees both `cache` and `no_cache` | Boolean pair was not modelled with `negatableFlag()` |
| Prompt appears during `--help` or CI | Prompt adapter owns policy instead of executable layer |
| Dynamic config increments twice | Source context and handler both call resolver |
| JSON output has warning text before it | Result and diagnostic LogTape routes are not isolated |
| Redaction misses `config show --json` | Secrets were stringified before structured redaction |
| Command exists in source but not binary | Dynamic discovery was invisible to bundler/compiler |

## Sources and freshness

- Portable contract guidance: [CLI architecture](architecture.md).
- Historical source scope: a CLI review from 2026-07-22, adapted into anonymized
  Optique 1.2.0, c12 two-merger, LogTape resource, and Zod default examples.
- Official Optique 1.2 API docs: <https://jsr.io/@optique/core@1.2.0> and <https://jsr.io/@optique/discover@1.2.0>.
- Official Zod v4 docs: <https://zod.dev/>.
- Official c12 source: <https://github.com/unjs/c12>.
- Official defu source: <https://github.com/unjs/defu>.
- Official LogTape docs: <https://logtape.org/>.

The recorded review of the example and Optique 1.2 API docs dates to
2026-07-22. Verify exact package exports, installed lockfile versions, and current
consumers before adapting the code.
