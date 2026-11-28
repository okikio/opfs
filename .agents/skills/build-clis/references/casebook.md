# CLI architecture casebook

These are anonymized illustrative examples adapted from historical project
reviews. Local paths, identifiers, and commands describe example ownership;
they do not establish maintained APIs or executed evidence for this project.
Trace the active consumer, verify public package sources for the installed
version, and run the relevant checks before adoption.


## Contents

- [Use this casebook](#use-this-casebook)
- [Repository trace index](#repository-trace-index)
- [End-to-end value trace template](#end-to-end-value-trace-template)
- [Portable CLI policy overlay](#portable-cli-policy-overlay)
- [Library ownership map](#library-ownership-map)
- [Optique integration details](#optique-integration-details)
- [Root program and one-snapshot config](#root-program-and-one-snapshot-config)
- [Config patch organization](#config-patch-organization)
- [Sparse adapter rules](#sparse-adapter-rules)
- [c12 loading details](#c12-loading-details)
- [Config merge and provenance mechanics](#config-merge-and-provenance-mechanics)
- [Field-extension checklist](#field-extension-checklist)
- [LogTape integration details](#logtape-integration-details)
- [Trace: browser detect](#trace-browser-detect)
- [Trace: Common Crawl detect](#trace-common-crawl-detect)
- [Trace: local WARC detect](#trace-local-warc-detect)
- [Trace: domains verify](#trace-domains-verify)
- [Stage, artifact, result, and diagnostic routes](#stage-artifact-result-and-diagnostic-routes)
- [Lifecycle, concurrency, cancellation, and cleanup](#lifecycle-concurrency-cancellation-and-cleanup)
- [Verification matrix](#verification-matrix)
- [Failure signatures](#failure-signatures)

## Use this casebook

Load this casebook when a CLI has multiple input sources, generated command
surfaces, durable artifacts, long-running source work, or the Optique + c12 +
defu + LogTape + Zod stack. Its anonymized examples show how to trace a CLI's
actual behavior through entrypoints, consumers, and checks. The `collector`
executable, local helper names, and paths are illustrative; resolve the
corresponding owners in the active repository.

Keep three states separate while reviewing or editing:

| State | Meaning | Required evidence |
|---|---|---|
| Intended architecture | The design the code appears to aim for | architecture docs plus code ownership |
| Observed implementation | What the current source actually does | traced entrypoints, adapters, schemas, tests |
| Executed behavior | What a subprocess or focused test proved | command/test output with exit status |

## Repository trace index

Use this example map to find corresponding owners before changing a public CLI surface:

| Concern | Primary files | What to inspect |
|---|---|---|
| Root command graph | `clis/main/src/shared/program.ts`, `clis/main/src/commands/index.ts` | Static command imports, `runProgram()` metadata, help/completion policy, source contexts, hooks |
| Compatibility entrypoints | `clis/main/src/browser.ts`, `commoncrawl.ts`, `warc.ts`, `domains.ts`, `shared/entrypoint.ts` | Delegation to root program, bootstrap error logging, raw logging flag recovery |
| Source contexts | `clis/main/src/shared/source.ts` | `PROJECT_` env source, c12 config source, route-derived default source, fallback order |
| Shared parser fragments | `shared/output.ts`, `shared/routes.ts`, `shared/run-config.ts`, `shared/logging.ts`, `shared/time.ts` | aliases, env/config binding, derived defaults, early controls, Temporal values |
| Help-only defaults | `shared/defaults.ts`, `shared/defaults.test.ts` | `documentDefault()` preserves sparse parse output while feeding Optique docs |
| Config overlay | `shared/config.ts` | `resolveCommandConfig()`, `applyConfigPatch()`, explicit argv provenance aliases |
| Source adapters | `browser/adapter.ts`, `commoncrawl/adapter.ts`, `warc/adapter.ts`, `domains/adapter.ts` | sparse patch creation, profile expansion, alias normalization, source validation |
| Config package | `packages/config/src/index.ts`, `merge.ts`, `schemas.ts` | c12 loader policy, two mergers, operation syntax, final Zod defaults, provenance |
| Results/logs | `shared/logging.ts`, `packages/diagnostics/src/logging.ts`, `index.ts` | raw result sink, diagnostic routing, redaction, file buffering, reset/flush |
| Stage writer | `packages/stages/src/index.ts`, `schemas.ts`, `stage-payloads.ts` | envelope schema, per-stage queues, known payload schemas, binary rejection |
| Browser source | `clis/main/src/browser/run.ts`, `source.ts`, `route.ts`, `packages/browser/src/*`, `packages/discovery/src/*` | discovery, collection policy, archive/WARC/WACZ, resume, screenshot/storage/CDP/DNS/TLS knobs |
| WARC and Common Crawl runs | `shared/run.ts`, `packages/warc/src/*`, `packages/commoncrawl/src/*`, `packages/cdx/src/*` | planner, CDX decisions, range fetches, retry/rate limiting, worker pool, run summaries |
| Domain verification | `domains/run.ts`, `packages/domains/src/*` | input/output files, accepted/retry classification, audit stages, DNS/HTTP policy |
| Concurrency primitives | `packages/engine/src/queue.ts`, `shared/run.ts` | bounded queues, ordered async map, detector worker pool, closure paths |

## End-to-end value trace template

Trace every source-bearing public value through all arrows. Do not skip directly
from parser to handler.

```text
public token/env/config field
  -> Optique parser term and source-context wrappers
  -> raw parsed value or absence
  -> source adapter sparse ProjectConfigPatch
  -> c12 loaded file patch, env patch, CLI patch
  -> application merge semantics
  -> complete Zod ProjectConfig default/transform validation
  -> provenance leaf or conservative source detail
  -> command run input
  -> source adapter/planner/collector consumer
  -> result, diagnostic, stage, artifact, or summary
  -> focused test or subprocess oracle
```

Classify each public term first:

| Term kind | Examples | Ownership |
|---|---|---|
| Early control | `--help`, `--version`, raw `--log-format` for bootstrap failure | executable/parser entrypoint before project config |
| Source-bearing config | `--out-dir`, `--run-id`, `--range-cache`, source network knobs | Optique parses, adapter emits sparse patch, resolver merges, Zod completes |
| Domain request input | route values, WARC file path, domains input file | parser/adapter validates shape; source run owns domain semantics |
| Result selector | `--json`, generated man/completion output | renderer/LogTape result route owns bytes |

## Portable CLI policy overlay

The worked example separates a CLI's execution architecture from its
human-interface policy. Optique,
LogTape, c12, defu, and Zod can implement pieces of that policy; none of them
decides the product contract.

```text
command language
  -> parser grammar, aliases, completion, help, suggestions
source language
  -> CLI/env/config/default provenance and precedence
result language
  -> stdout machine contracts and human renderers
diagnostic language
  -> stderr, files, support bundles, telemetry routes
safety language
  -> dry-run plans, force, typed confirmations, checkpoints
state language
  -> status, resume, explain, files, install/remove locations
```

When auditing or extending a CLI, inspect these policy layers explicitly:

| Policy layer | Preferred owner | Review questions | Tests that prove it |
|---|---|---|---|
| Command names and flags | Optique parser plus app naming policy | Are long names stable? Are aliases deliberate? Are hidden aliases documented for compatibility? Are heterogeneous inputs flags rather than magic positionals? | help/man/completion snapshots; invalid sibling command suggestions; alias parse tests |
| No-argument and help behavior | root command policy | Does no-arg output orient a human without pretending to run? Does full help contain examples, config/env names, output modes, and issue/docs links? | subprocess `app`, `app --help`, `app command --help`; generated man smoke |
| Human versus machine output | result schemas and renderers, transported by LogTape | Is stdout exactly the requested result mode? Is stderr free to be human? Are JSON and JSONL stable schemas rather than stringified human output? | separate stdout/stderr/exit assertions for human, `--plain`, `--json`, `--jsonl` |
| Interaction | prompt adapter gated by app policy | Does every prompt have a flag/file/stdin equivalent? Does `--no-input` fail fast with missing fields? Does CI/non-TTY avoid hanging? | TTY and non-TTY subprocess tests; `--no-input`; CI env simulation |
| Dangerous operations | risk and operation-plan schemas | Is danger classified as none/mild/moderate/severe? Does dry-run emit the exact plan the executor consumes? Does severe risk require a typed target token? | dry-run plan schema test; `--force`; `--confirm=<target>`; mismatch rejection |
| Standard streams | endpoint parser and IO adapter | Does `-` mean stdin/stdout only where file-like values are expected? Are empty strings rejected rather than overloaded? Does a command fail if required stdin is a TTY? | parser tests for `-`, `none`, path; subprocess with piped and TTY stdin |
| Secrets | `SecretSource` capability plus redaction | Are secrets read from file/stdin/prompt/provider/socket instead of argv or broad env? Are argv, config views, URLs, errors, and support bundles redacted? | redaction fixtures; process-argv snapshot excludes secret values; prompt gated on TTY |
| Pager | host `Pager` capability | Does paging activate only for long human output on TTY? Is `--no-pager` honored? Is JSON never paged? Is `PAGER` spawned as argv, not shell text? | redirected stdout, JSON, CI, no-pager, custom pager tests |
| Config locations and edits | c12/rc9/magicast/confbox behind adapters | Are project/user/system layers explicit? Do edits show target and diff, obtain consent, write atomically, and validate authored schema? | dry-run edit plan; temp XDG paths; format-preserving edit fixture; malformed edit rollback |
| Recovery and checkpoints | checkpoint schema and store capability | Can an interrupted run reconcile committed work and resume idempotent units? Is the request fingerprint checked? | kill/restart subprocess; incompatible resume rejection; checkpoint cleanup |
| Telemetry | consent schema and LogTape remote sinks | Is remote reporting disabled by default unless enterprise policy says otherwise? Are diagnostics separate from analytics? Is consent revocable? | default no-network test; consent config; sink redaction; telemetry failure does not fail command |
| Distribution and removal | packaging/release scripts | Does the installed or compiled shape include commands/assets/workers? Are uninstall and owned paths discoverable? | clean install/tarball/binary smoke; `doctor paths`; offline startup |

Concrete schema anchors for portable policy:

```ts
export const InteractionPolicySchema = z.object({
  mode: z.enum(["auto", "interactive", "non_interactive"]),
  force: z.boolean().default(false),
  dry_run: z.boolean().default(false),
  confirm: z.string().optional(),
});

export const RiskLevelSchema = z.enum(["none", "mild", "moderate", "severe"]);

export const OperationPlanSchema = z.object({
  operation: z.string(),
  risk: RiskLevelSchema,
  changes: z.array(z.object({
    kind: z.string(),
    target: z.string(),
    description: z.string(),
  })),
  confirmation_token: z.string().optional(),
});

export const FileEndpointSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path"), path: z.string().min(1) }),
  z.object({ kind: z.literal("stdin") }),
  z.object({ kind: z.literal("stdout") }),
  z.object({ kind: z.literal("disabled") }),
]);

export const TelemetryPolicySchema = z.object({
  mode: z.enum(["disabled", "local", "consented_remote"]),
  consented_at: z.iso.datetime().optional(),
  retention_days: z.int().positive().optional(),
  endpoint: z.url().optional(),
});
```

Use these schemas as contracts, not decorations. A `--dry-run` command should
emit an `OperationPlanSchema` object and the executor should consume the same
plan or a fingerprinted/persisted equivalent. A prompt should fill a normal
request schema, not bypass validation. A pager should consume already-rendered
human text; it should not be another logging sink. Telemetry routes should be
LogTape sinks selected by consent policy, not ad hoc network calls inside
domain handlers.

Diagram/documentation policy for future casebooks:

| Relationship | Preferred doc shape | Why |
|---|---|---|
| terminal flows and source precedence | fenced ASCII flow | stable in terminals, diffs, and Markdown previews |
| ownership handoffs and test matrices | tables | dense relationships stay readable |
| small regular graphs | Mermaid | useful only when auto-layout is predictable |
| nested architecture or page-constrained docs | prose plus tables or a designed visual | Mermaid auto-layout tends to obscure detail |

Every diagram needs a text equivalent. Render documentation in the target
surface before claiming it is readable.

## Library ownership map

When all five libraries are present, the safe design is not “use everything
everywhere.” Give each library one crisp job.

| Owner | Optique | c12 | defu | Zod | LogTape |
|---|---|---|---|---|---|
| Public command grammar | Owns command tree, flags, aliases, choices, suggestions, completion, man/help metadata | none | none | value parser adapter only when useful | none |
| Environment/config/default source binding | May bind one parser term to env/config/derived contexts | Supplies loaded config object for config context | none | validates individual values if used through `@optique/zod` | none |
| Config file discovery | none | Owns file lookup, explicit config path, env branches, `extends`, TS/JS factory execution | Used as c12 merger helper | validates retained layer shapes after load | diagnostics only |
| App-level precedence | none, except parsed CLI value contribution | none after loaded file patch exists | Implements field-specific merge callback behind app resolver | validates sparse patch and final config | can report decisions |
| Defaults | Shows documented defaults; may provide handler-time `deferredValue()` | none | none | Owns executable runtime defaults after all sources merge | none |
| Provenance | Provides argv and parser/source-context evidence; does not provide full winner graph | file path and loader metadata evidence | merge operation source evidence | default-origin evidence | transports redacted explanation |
| Results and diagnostics | command metadata can influence output shape | none | none | validates result schemas | owns result and diagnostic routes |
| Durable artifacts | none | none | none | validates artifact/stage metadata | may mirror event; does not own artifact storage |

Reject these cross-library anti-patterns:

| Anti-pattern | Why it fails |
|---|---|
| `withDefault(option("--x", ...), value)` for a source-bearing field | The parser emits a CLI-shaped value even when the user omitted the flag, so config/env/default precedence is polluted. |
| `loadConfig({ merger: mergeConfigInputs })` | The strict app merger can reject c12 control keys before c12 resolves `extends` and env branches. |
| `defu(cli, env, file)` as the public merge policy | Default defu array concatenation and object recursion are not the CLI's product semantics. |
| One Zod schema for config authoring, sparse patches, and runtime config | Defaults materialize too early and authoring controls can leak into handlers. |
| `console.log(JSON.stringify(result))` beside LogTape | Stable stdout bypasses routing, redaction, sink isolation, and tests. |
| Durable JSONL stages written as ordinary log messages | Logs are observation transport; stage files are replay/test artifacts with schemas and counters. |

## Optique integration details

Optique should make the public command language rich and hard to misuse. It
should not become the application config resolver.

### Parser construction

Use Optique terms to model the public grammar:

```ts
const parser = merge(
  cliRouteInputOptionsParser,
  cliOutputOptionsParser,
  cliRunOptionsParser,
  cliConfigOptionsParser,
  cliLogOptionsParser,
  object({
    mode: documentDefault(optional(option("--mode", choice(["detect", "collect"]))), "detect"),
    range_cache_enabled: optional(negatableFlag("--range-cache")),
    timeout: optional(option("--timeout", duration())),
  }),
);
```

The parser owns:

- flag spelling and aliases;
- choices and typo suggestions;
- conflict shapes such as positive/negative Boolean pairs;
- help and man-page metadata;
- shell completion metadata;
- typed value parsers such as durations, instants, URLs, integers, and enums.

The parser does not own:

- final runtime defaults for source-bearing fields;
- cross-source precedence;
- operation-aware array merging;
- field provenance winner graphs;
- durable artifacts or stage files;
- source execution policy.

### Source contexts

The example composes three Optique source contexts:

```ts
export const envContext = createEnvContext({
  prefix: "PROJECT_",
  envFile: [".env", ".env.local"],
});

export const configContext = createConfigContext({
  schema: projectConfigPatchSchema,
});

export const derivedDefaults = createDerivedDefaults({
  run_id: (parsed) => firstRouteValue(parsed)?.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-"),
});

export const sourceContexts = [
  envContext,
  configContext,
  derivedDefaults.context,
] as const;
```

Use source contexts for fields that are truly public command terms and can be
revalidated by the same parser. Do not assume this gives you complete
provenance. The command still needs explicit argv evidence to distinguish a
user-supplied CLI value from an env/config/derived fallback that Optique
re-emits.

### Help-visible defaults versus executable defaults

Use these patterns:

| Need | Optique shape | Runtime effect |
|---|---|---|
| Show default in help, keep patch sparse | `documentDefault(optional(option(...)), value)` | omitted parse remains `undefined` |
| Early parser control default | `withDefault(option("--json"), false)` | safe because `json` is output mode, not config precedence |
| Handler-time secret/interactive/expensive fallback | `deferredValue(parser, fallback)` | handler receives resolver function; fallback is not persisted into config |
| Ordinary runtime fallback | no parser default | final Zod runtime schema applies `.default()` or `.prefault()` after merge |

Wrong:

```ts
// Pollutes the CLI patch: config/env can no longer win over omission.
concurrency: withDefault(option("--concurrency", integer()), 4)
```

Right:

```ts
// Help shows the default, but omitted parser output remains absent.
concurrency: documentDefault(optional(option("--concurrency", integer())), 4)
```

### Command handler integration

Command modules should do only four things:

1. collect route/file/stdin request inputs;
2. create a sparse source patch;
3. resolve that patch against the hook-provided config snapshot;
4. run the source project and print the stable result.

Illustrative command shape:

```ts
export async function run(options, context) {
  const routes = await resolveRouteUrls(options, normalizeBrowserRouteUrl);
  const patch = createBrowserConfigPatch(options, routes);
  const resolved = await resolveCommandConfig({ patch }, context);

  if (options.dry_run) {
    printCliResult(formatPlan(resolved), options.json, humanPlan(resolved));
    return;
  }

  const summary = await runBrowserProject({ config: resolved.config });
  printCliResult(summary, options.json, formatBrowserSummary(summary));
}
```

Handlers should not call `Deno.exit`, read `Deno.env`, configure LogTape, or
call `resolveConfig()` when hook context is present.

## Root program and one-snapshot config

The root program should be the only place that joins parser, source contexts,
config snapshot, and logger resource.

Illustrative program shape:

```ts
await runProgram<ProgramResource>({
  commands,
  args,
  metadata,
  help: "both",
  completion: "both",
  showDefault: true,
  showChoices: true,
  contexts: sourceContexts,
  contextOptions: {
    async load(parsed) {
      const bootstrap = bootstrapConfigOptionsSchema.parse(parsed ?? {});
      const resolved = await resolveConfig({
        configFile: bootstrap.config_file,
        noConfig: bootstrap.no_config,
      });
      baseConfig = resolved;
      return { config: resolved.config, meta: { configPath: resolved.configPath } };
    },
  },
  hooks: {
    async beforeEach(invocation) {
      if (!baseConfig) throw new Error("The command configuration context did not load.");
      const logger = await configureCliLogging(invocation.value, ...invocation.path);
      return { resource: { config: baseConfig, logger, args } };
    },
  },
});
```

Rules:

- `commands` must be statically imported so bundling and `deno compile` can see
  every command.
- Context loading may call c12 once. Handlers should use the hook resource or a
  direct-test fallback, not reload full config.
- `beforeEach` configures command logging after final parsed command values are
  available.
- Source-specific compatibility entrypoints delegate to the root program and use
  `runCliEntrypoint()` only to report pre-handler failures.

Failure oracle:

```text
dynamic config factory increments marker
  -> run one command
  -> marker count must be 1
```

If the count is 2, source context and handler both loaded config.

## Config patch organization

Organize patches by ownership. A source command can contribute both
project-level fields and source-specific fields, but the reason must be visible.

```text
ProjectConfigPatch
  runId?                 shared run identity override
  outDir?                shared default output root override
  log?                   process-level logging preference
  sources.browser?       browser-specific source policy
  sources.commoncrawl?   Common Crawl source policy
  sources.warc?          local WARC source policy
  sources.domains?       domain-verification source policy
```

Keep these buckets distinct:

| Bucket | Examples | Rule |
|---|---|---|
| Shared project fields | `runId`, `outDir`, `log.level`, `log.format` | set only if CLI/env/config source explicitly contributes or source input implies a run root |
| Source run identity | `sources.browser.runId`, `sources.commoncrawl.runId` | mirror when the source run needs a local override or manifest identity |
| Source input | browser routes, WARC files, Common Crawl route, domains input file | required by the source runner; do not hide in global config |
| Source network policy | Common Crawl delays/retries, domain DNS/HTTP timeout | sparse; final defaults live in runtime schema |
| Output artifacts | WARC path, WACZ path/dir/package, domain accepted/retry files | source-specific artifact writers consume them |
| Diagnostic preference | process `log` and optional source `logLevel` | process logging and source library logging may be related but are not the same field |

Browser patch shape:

```ts
const browserPatch: BrowserSourcePatch = {};
assignIfDefined(browserPatch, "routes", routeUrls.length > 0 ? [...routeUrls] : undefined);
assignIfDefined(browserPatch, "runId", options.run_id);
assignIfDefined(browserPatch, "waitUntil", options.wait_until ?? maxCaptureDefault(options, "networkidle"));
assignIfDefined(browserPatch, "warc", createWarcPatch(options));
assignIfDefined(browserPatch, "wacz", createWaczPatch(options));
assignIfDefined(browserPatch, "screenshots", createScreenshotPatch(options));

const basePatch: ProjectConfigPatch = {
  runId: options.run_id,
  log: { level: logging.level, format: logging.format },
};
if (hasRouteInput || options.out_dir || options.out) basePatch.outDir = outDir;
if (Object.keys(browserPatch).length > 0) basePatch.sources = { browser: browserPatch };
```

Common Crawl patch shape:

```ts
const commoncrawlPatch = {
  route: routeUrl,
  logLevel: toSourceLogLevel(logLevel),
  crawls: crawlSelector(options),
  rangeCache: buildRangeCachePatch(options),
  network: buildNetworkPatch(options),
  analyzedAt: resolveAnalyzedAt(options),
};
```

Do not normalize everything into a flat map before validation. Nested patch
shape mirrors the runtime owner graph and makes merge/provenance paths stable.

## Sparse adapter rules

Adapters turn command values into sparse patches. They are not runtime default
owners.

Correct adapter skeleton:

```ts
export function createSourceConfigPatch(input: SourceCliOptions): ProjectConfigPatch {
  const options = sourceCliOptionsSchema.parse(input);
  const source: NonNullable<ProjectConfigPatch["sources"]>["source"] = {};

  assignIfDefined(source, "route", options.route);
  assignIfDefined(source, "timeoutMs", options.timeout?.total("milliseconds"));
  assignIfDefined(source, "enabled", options.enabled === true ? true : undefined);

  const patch: ProjectConfigPatch = {
    runId: options.run_id,
    log: resolveCliLogging(options),
  };
  if (Object.keys(source).length > 0) patch.sources = { source };
  return projectConfigPatchSchema.parse(patch);
}

function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
```

Rules and examples:

| Rule | Example | Failure if broken |
|---|---|---|
| Omitted means absent | no `--concurrency` -> no `source.concurrency` patch | config-owned concurrency is overwritten by parser default |
| Falsy can be explicit | `--no-range-cache` -> `{ enabled: false }`; `--retries 0` -> `{ retries: 0 }` | `if (value)` drops user intent |
| Empty arrays can be explicit | config operation can clear inherited routes | inherited values cannot be cleared |
| Aliases normalize once | `--out` wins over `--out-dir`; `--route`, `--route-url`, `--target` feed one route list | provenance and docs disagree about winner |
| Profile expansion is source policy | browser `capture_profile=max` synthesizes WARC/WACZ/discovery/screenshots settings | hidden defaults look like Zod or CLI defaults |
| Adapter output is revalidated | `projectConfigPatchSchema.parse(patch)` | invalid patch travels to merge/runtime code |

Do not use parser defaults for source-bearing terms merely to show help text.
Use help-only metadata such as `documentDefault()` or parser documentation
support, then let the complete runtime schema apply executable defaults.

## c12 loading details

c12 owns project config discovery and authoring composition, not the final
runtime contract.

Illustrative loader policy:

```ts
await loadConfig<ProjectConfigPatch>({
  name: "project",
  cwd,
  configFile,
  configFileRequired,
  rcFile: false,
  globalRc: false,
  packageJson: false,
  dotenv: false,
  envName,
  omit$Keys: true,
  merger: mergeC12ConfigInputs,
  context,
});
```

Why each option matters:

| Option | Reason |
|---|---|
| `configFile` / `configFileRequired` | explicit `--config` has clear missing-file behavior |
| `rcFile: false`, `globalRc: false`, `packageJson: false` | avoids hidden user/package config sources unless product policy chooses them |
| `dotenv: false` | dotenv participates through Optique env context in this design, not c12 mutation |
| `envName` | selected c12 env branch is explicit and testable |
| `omit$Keys: true` | c12 control metadata does not leak after loading |
| `merger: mergeC12ConfigInputs` | loader-aware merge keeps `extends` and env branches usable |

Validate loaded exports with an authoring schema that accepts:

- root object layers with c12 controls;
- root arrays as shorthand for several app patches;
- functions/factories when c12 supports them;
- array operation envelopes on known array-bearing fields.

Reject:

- scalar exports;
- array-shorthand elements that contain c12 control keys;
- complete runtime defaults during layer validation;
- source adapters receiving `$append`, `$prepend`, `$replace`, `extends`, or
  `$development` objects.

The loader merger must sometimes return `false` to let c12 continue its own
merge handling. The app merger may be stricter because c12 has already resolved
loader controls.

## Config merge and provenance mechanics

The example separates schema shapes and merge stages:

| Shape | Purpose | Defaults allowed? |
|---|---|---|
| authoring layer | config-file syntax, c12 root controls, array operations | no complete runtime defaults |
| sparse patch | CLI/env/file contribution after authoring normalization | no complete runtime defaults |
| complete runtime config | handler and source run contract | yes, Zod owns executable defaults |

Observed two-merger algorithm:

```text
c12 loadConfig(..., merger: mergeC12ConfigInputs)
  -> c12 resolves files, extends, env branches, and factories
  -> c12DefuMerger preserves loader controls and defers append/prepend without inherited arrays
  -> normalizeLoadedConfig(loaded.config)
  -> filePatch

resolveConfig()
  -> envPatch from process environment
  -> cliPatch from Optique adapter
  -> mergeConfigInputs(cliPatch, envPatch, filePatch)
  -> public inputs are high-to-low, implementation loops low-to-high
  -> resolveStandaloneOperations(resolved)
  -> projectConfigPatchSchema.parse(...)
  -> sanitize c12 controls and undefined values
  -> projectConfigSchema.parse(...) applies final defaults
  -> buildConfigProvenance(...)
```

Array and union merge rules:

| Input shape | Merge rule |
|---|---|
| scalar | higher defined value wins; null/undefined layers are skipped according to patch policy |
| ordinary object | recursive property merge |
| plain array | higher array replaces inherited array; no default defu concat |
| `$replace` | operation value replaces inherited array |
| `$append` | inherited array then appended values |
| `$prepend` | prepended values then inherited array |
| standalone operation | lowered to its operation array after all pair merges |
| schema-known atomic union | higher union object replaces inherited union object as a whole |

Standalone operation lowering is required because a lowest-layer operation has no
inherited array for defu's pair callback to inspect:

```ts
function resolveStandaloneOperations(value: unknown): unknown {
  if (isArrayReplaceOperation(value)) return value.$replace;
  if (isArrayAppendOperation(value)) return value.$append;
  if (isArrayPrependOperation(value)) return value.$prepend;
  if (Array.isArray(value)) return value.map(resolveStandaloneOperations);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, resolveStandaloneOperations(child)]),
  );
}
```

Provenance rules:

- Build provenance from source-layer decisions, not final values alone.
- When `applyConfigPatch(base, patch, "optique", overrides)` overlays a command
  patch, preserve base provenance for unchanged fallback values unless explicit
  argv aliases map to that path.
- Attribute explicit CLI leaves through reviewed aliases such as `--route`,
  `--route-url`, `--target`, `--range-cache`, `--no-range-cache`, `--out`,
  `--out-dir`, `-v`, `--verbose`, and `--silent`.
- Arrays and atomic unions usually receive provenance at the owning field path,
  not stale numeric indexes or inherited subfields.
- Redact provenance before `config show`, `config explain`, manifests, support
  bundles, or LogTape routes.

### Merge algorithm detail

The public app merge receives inputs highest-to-lowest:

```ts
mergeConfigInputs(cliPatch, envPatch, filePatch);
```

It evaluates them low-to-high so lower layers establish inherited values before
higher layers apply operations:

```ts
let resolved: unknown = {};
for (const layer of inputs.toReversed()) {
  if (layer == null) continue;
  resolved = defu(layer, resolved, defuMerger);
}
return projectConfigPatchSchema.parse(resolveStandaloneOperations(resolved));
```

For a concrete route example:

```ts
file = { sources: { browser: { routes: ["file"] } } };
env = { sources: { browser: { routes: { $prepend: ["env"] } } } };
cli = { sources: { browser: { routes: { $append: ["cli"] } } } };

mergeConfigInputs(cli, env, file)
// -> { sources: { browser: { routes: ["env", "file", "cli"] } } }
```

Do not reverse the public caller API to make the internal loop easier. The
public API should read like precedence: CLI, environment, file, defaults. The
implementation can reverse internally.

### defu callback classification

The merger needs field classification, not one universal deep-merge:

| Classification | Callback behavior |
|---|---|
| plain array | assign the higher array; return true |
| `$replace` operation | assign replacement array; return true |
| `$append` operation with inherited array | assign `[...inherited, ...append]`; return true |
| `$prepend` operation with inherited array | assign `[...prepend, ...inherited]`; return true |
| `$append`/`$prepend` without inherited array during c12 load | return false to defer |
| `$append`/`$prepend` without inherited array during app merge finalization | leave for standalone lowering |
| atomic union path | assign higher object as a whole; return true |
| ordinary object | return false so defu recurses |

Required invariants:

- never mutate incoming layer objects;
- always copy resolved arrays;
- preserve duplicate array entries unless the product explicitly defines a set;
- empty arrays clear inherited arrays;
- only schema-known atomic union paths are atomic.

### Provenance overlay detail

Field provenance follows merge semantics. The implementation should know whether
a field was:

1. explicitly supplied by CLI argv;
2. emitted by Optique from environment, config, or derived source context;
3. inherited from the loaded base snapshot;
4. supplied by the final Zod default.

The example's `inferExplicitCliProvenance()` collects supplied flags from argv and
maps aliases back to config paths:

```ts
const PATH_FLAG_ALIASES = {
  "analyzedAt": ["analyzed-at", "at"],
  "log.level": ["log-level", "verbose", "v", "silent"],
  "rangeCache.enabled": ["range-cache", "no-range-cache"],
  "route": ["route", "route-url", "target"],
  "routes": ["route", "route-url", "target", "route-urls", "routes-file", "stdin"],
};
```

Do not mark every Optique-returned value as `cli`. A config fallback selected by
Optique can be equal to the resolved base value and should retain base
provenance unless argv proves explicit user intent.

## Field-extension checklist

Use this whenever adding a flag, env variable, config key, runtime field, output
field, plan field, checkpoint field, or provenance path. Most CLI bugs in this
stack happen because a new field is added in one layer and silently omitted from
another.

### 1. Classify the field before writing code

| Question | If yes | Owner |
|---|---|---|
| Does it change parser/bootstrap behavior before config is valid? | early control | root parser/entrypoint |
| Can it come from CLI, env, config, or default? | source-bearing config | Optique adapter + config resolver + Zod runtime schema |
| Is it a domain target/request input? | domain request | command adapter + domain schema |
| Does it alter output transport or shape? | result/diagnostic selector | renderer + LogTape routing |
| Does it mutate external state? | operation policy input | plan/risk/confirmation schema |
| Does it persist between runs? | state/checkpoint/config location field | storage/path/config adapter |
| Is it secret or sensitive? | secret reference | `SecretSource` + redaction policy |

If the field is source-bearing, fill this map before implementation:

```text
public spelling:
  CLI flags:
  env var:
  config path:
  default documentation:

schemas:
  authored layer:
  sparse patch:
  complete runtime:

merge category:
  scalar | object | plain array | operation array | atomic union

provenance:
  canonical path:
  aliases:
  redaction:

consumers:
  handler:
  source package:
  result/stage/artifact:

tests:
  parser:
  sparse adapter:
  merge:
  defaults:
  provenance:
  subprocess:
```

### 2. Put defaults in the right layer

| Default need | Correct placement | Test oracle |
|---|---|---|
| Help text says what will happen if omitted | Optique documentation metadata such as `documentDefault()` | help contains value; parse output omits field |
| Invocation-local Boolean/output default | Optique `withDefault()` on non-source-bearing control | omitted parse has safe control value; config cannot own it |
| CLI-only expensive/secret/interactive fallback | Optique `deferredValue()` or prompt integration gated by policy | fallback function runs only when handler needs it |
| Runtime config fallback | complete Zod schema `.default()` or `.prefault()` after merge | sparse patch omits field; runtime config contains fallback |
| Transformed default input | Zod `.prefault()` | fallback passes through transform/refinement |
| Malformed recovery | Zod `.catch()` only when recovery is explicit product policy | invalid value produces recovery record or expected fallback |

Do not move a runtime default into Optique because help cannot display it. Fix
the help metadata instead.

### 3. Add schema shapes deliberately

For source-bearing config, three shapes should exist or be consciously rejected:

| Shape | Field form | Defaults? | Validation job |
|---|---|---|---|
| authored layer | sparse values plus optional operation envelopes and c12 controls | no runtime defaults | accept config-file language |
| sparse patch | ordinary sparse values after operations/c12 controls are gone | no runtime defaults | accept CLI/env/file contribution |
| complete runtime | complete normalized values | yes | contract consumed by handlers/source packages |

Example for an operation-capable array:

```ts
const routeArraySchema = z.array(z.url());
const routeOperationSchema = z.union([
  z.object({ $replace: routeArraySchema }),
  z.object({ $append: routeArraySchema }),
  z.object({ $prepend: routeArraySchema }),
]);

const authoredBrowserSchema = z.object({
  routes: z.union([routeArraySchema, routeOperationSchema]).optional(),
});

const browserPatchSchema = z.object({
  routes: routeArraySchema.optional(),
});

const browserRuntimeSchema = z.object({
  routes: routeArraySchema.default([]),
});
```

### 4. Register merge category and provenance at the same time

Adding the schema without merge/provenance rules is incomplete.

| Field category | Merge behavior | Provenance granularity |
|---|---|---|
| scalar | higher defined wins; preserve false/0/empty string if schema allows it | leaf path |
| ordinary object | recursive per-property merge | leaf paths |
| plain array | higher array replaces; empty clears | owning array path |
| operation array | operation transforms inherited array; lowered to plain array | owning array path plus operation source when explain supports it |
| atomic union | higher object replaces whole variant | union owner path |
| secret reference | merge reference, never secret value | reference path, redacted |

If a field has aliases, add them to the explicit CLI-provenance map while the
parser is changed. Provenance cannot be reliably reconstructed later from the
final value because an explicit CLI value can equal a lower config value.

### 5. Extend Optique as grammar, not config resolver

Optique work for a new field should include:

- canonical long flag and reviewed aliases;
- value parser or `@optique/zod` adapter for one-token validation when useful;
- `negatableFlag()` for tri-state Boolean overrides;
- source-context bindings only when the field truly belongs in env/config;
- help/man/completion metadata and examples;
- parser tests for omitted, explicit, invalid, alias, and source-context cases.

Optique work should not include:

- final runtime defaults for source-bearing config;
- operation-aware merging;
- secret values in argv;
- domain safety policy such as whether an action is severe.

### 6. Extend c12/defu/Zod as a staged resolver

For config-file fields:

1. add authored syntax;
2. add retained c12 layer validation;
3. add sparse patch schema;
4. classify merge behavior;
5. add standalone operation cleanup if operations are supported;
6. apply complete Zod defaults once;
7. add `config show` and `config explain` rendering with redaction.

Do not validate file layers with the complete runtime schema. That applies
defaults too early and makes absent config indistinguishable from authored
values.

### 7. Add output/stage/artifact behavior if the field affects observability

| If field changes... | Update |
|---|---|
| stable stdout result | result schema, renderer, JSON/plain fixtures |
| diagnostics | LogTape category/filter/formatter tests |
| persisted stage JSONL | stage payload schema, writer tests, migration/version note |
| artifact path/content | artifact manifest schema, digest/size/reference fields |
| support bundle/config explain | redaction and provenance rendering tests |

Never prove a field by checking only TypeScript types. A CLI field is public
only when help, parser, source resolution, runtime behavior, and observable
output agree.

### 8. Minimum behavior tests for every source-bearing field

| Behavior | Example assertion |
|---|---|
| no source | runtime default applies after sparse merge |
| config source | config value appears in runtime config and provenance |
| env source | env beats config |
| explicit CLI | CLI beats env/config and provenance says CLI |
| explicit CLI equal to config | final value equals config, but provenance still says CLI |
| omitted CLI | config/env provenance is preserved |
| invalid CLI | parser/schema reports public flag name |
| invalid config | c12/file path and Zod issue path are visible |
| help/default | help shows documented default while parse output stays sparse |
| redaction | sensitive field is hidden in config show/explain/logs |

## LogTape integration details

LogTape gives the CLI one structured observation graph. It does not replace
schemas, config merge, stage writers, or artifact storage.

### What LogTape does for the CLI

| Need | LogTape role |
|---|---|
| Stable stdout | dedicated result category and raw sink |
| Human diagnostics | pretty/plain stderr sink with levels and categories |
| Machine diagnostics | JSON/JSONL diagnostic sink |
| Redaction | apply a route-specific policy before serialization; prove known secrets are hidden without removing required diagnostic evidence |
| Bootstrap failures | minimal early configuration from raw logging flags |
| Library logging | packages receive loggers or structural logger contracts, not sink setup authority |
| Testability | recorder/test sinks assert category and structured properties |
| Lifecycle | `reset()`/flush/disposal prevents duplicate process-global sinks |

### Result route

Stable results must be pipe-safe:

```ts
export function printCliResult(value: unknown, json: boolean, human: string): void {
  const result = json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`;
  emitProgramResult(result);
}
```

The underlying LogTape config should isolate result output:

```ts
{
  category: ["project", "result"],
  sinks: ["result"],
  parentSinks: "override",
}
```

If `parentSinks` is omitted or equivalent isolation is absent, JSON output can
inherit diagnostic prefixes and break automation.

### Diagnostic route

Diagnostics should carry structured properties:

```ts
getProgramLogger("cli", "entrypoint").error("{message}", {
  error,
  message: `Config failed: ${error.message}`,
  command,
});
```

Do not stringify the entire error/config/result before redaction. Field-based
redaction must see nested keys such as `authorization`, `password`, `cookie`,
`token`, and secret URLs before formatting.

### Bootstrap failure route

Some failures occur before the full parser or loaded config exists. The example
uses a small raw-argv recovery path:

```text
raw argv
  -> readPreHandlerLoggingOptions()
  -> configureProgramLogging()
  -> log one redacted entrypoint error
  -> resetProgramLogging()
  -> exit usage/config class
```

This bootstrap parser should recover only logging controls such as
`--log-level`, `--log-format`, `--log-output`, and `--silent`. It must not
duplicate the whole domain parser.

### What LogTape must not do

- It must not be the durable stage writer.
- It must not store raw WARC/browser bytes.
- It must not decide config precedence.
- It must not apply runtime defaults.
- It must not be configured by reusable packages.
- It must not emit stable results through diagnostic formatters.

## Trace: browser detect

Representative command:

```text
collector browser detect --route example.com --capture-profile max --wacz --out out/browser
```

Flow:

```text
argv
  -> browserOptionsParser + shared route/output/run/log parsers
  -> resolveRouteUrls(..., normalizeBrowserRouteUrl)
  -> createBrowserConfigPatch(options, routeUrls)
  -> sparse project patch
  -> resolveCommandConfig({ patch }, hookContext)
  -> runBrowserProject({ config: resolved.config })
  -> optional discovery
  -> browser adapter plan/collect
  -> detection/facts/aggregates/derived/lead stages
  -> run summary, archive manifest, optional WACZ
  -> stable CLI result
```

Key implementation details:

| Behavior | Implementation detail | Test idea |
|---|---|---|
| Host-only route convenience | browser route normalizer adds `https://` when no scheme exists | `example.com` becomes `https://example.com/` |
| Sparse route patch | routes assigned only when direct/file/stdin input exists | no route input preserves config routes |
| Max capture profile | `maxCaptureDefault()` fills discovery, WARC/WACZ, screenshots, CDP/storage/DNS/TLS/body policy | profile test asserts synthesized fields; normal omission test asserts absence |
| Headed flag | `--headed` maps to `headless: false` | absent headed does not patch headless |
| Output precedence | `resolveCliOutDir()` returns `out ?? out_dir ?? default` | `--out` beats env/config `out_dir` |
| Resume marker | existing `run.json` blocks unless resume/overwrite | subprocess or temp-dir test |
| WACZ dependency | WACZ requires WARC archive writer | WACZ enabled without archive throws |
| Archive profile | replay/analysis/forensic choose stage retention | WACZ package includes expected metadata set |

## Trace: Common Crawl detect

Representative command:

```text
collector commoncrawl detect --route https://example.com --crawls latest:2 --range-cache --out out/cc
```

Flow:

```text
argv
  -> commonCrawlOptionsParser
  -> createCommonCrawlConfigPatch(options, routeUrl, multipleRoutes)
  -> crawlSelector() produces named/latest/range selector
  -> rangeCache/network/source patches stay sparse
  -> resolveCommandConfig()
  -> runCommonCrawlProject()
  -> adapter.plan() queries CDX and emits decision stages
  -> range fetcher uses rate limiter, retry policy, cache policy
  -> collected WARC units feed shared detection pipeline
  -> summarizeCommonCrawlDecisions(stages)
  -> run-summary.json and CLI result
```

Key implementation details:

| Behavior | Implementation detail | Test idea |
|---|---|---|
| Multi-route output | explicit base plus route slug per route | two routes produce sibling subdirectories |
| Atomic crawl selector | `{ kind: "named" }`, `{ kind: "latest" }`, `{ kind: "range" }` replace each other | higher selector drops stale lower keys |
| Range cache tri-state | absent/true/false conflict handled by parser/schema | absent preserves config; negative flag sets false |
| Serialized range safety | range concurrency constrained until dedicated bounded parallel tests exist | invalid higher value errors with actionable message |
| Retry policy | 429/503/network retry with bounded delay and cap | retry-policy unit tests for Retry-After and max delay |
| Stage-derived summary | CDX decision summary is computed from stage lines | enqueue/reject/alias counts match stage fixtures |

## Trace: local WARC detect

Representative command:

```text
collector warc detect --warc ./capture.warc.gz --route https://example.com --out out/warc
```

Flow:

```text
argv
  -> warcOptionsParser + route/output/run/log parsers
  -> resolveSingleWarcRouteUrl() rejects several routes
  -> createWarcConfigPatch(options, routeUrl)
  -> resolveCommandConfig()
  -> runWarcProject()
  -> prepareRunOutputDir()
  -> createWarcAdapter().plan()
  -> source.warc records/resources/observations stages
  -> shared detector/fact pipeline
  -> finalization audit, run summary, CLI result
```

Key implementation details:

| Behavior | Implementation detail | Test idea |
|---|---|---|
| Single route | WARC route helper rejects more than one route | route list with two URLs throws source-specific message |
| Marker conflict | existing `run-summary.json` blocks unless overwrite | temp output dir conflict test |
| Source terminology | WARC stages are written before detector observations | stage fixture includes source and detect layers |
| Worker lifecycle | detection worker pool closes in `finally` | failing adapter still closes workers |
| Resource records | browser-generated WARC resource records may be parsed separately from HTTP responses | readback test counts record types |

## Trace: domains verify

Representative command:

```text
collector domains verify --input domains.txt --audit --output accepted.txt --retry-output retry.txt
```

Flow:

```text
argv
  -> domainVerifyOptionsParser
  -> createDomainVerifyConfigPatch()
  -> sparse domains source patch
  -> resolveCommandConfig()
  -> runDomainVerificationProject()
  -> input records stream through bounded verification
  -> DNS and HTTP classify accepted/retry/rejected
  -> accepted, routes, retry, audit, and summary outputs
  -> source.domains verification/summary stages
  -> CLI summary result
```

Key implementation details:

| Behavior | Implementation detail | Test idea |
|---|---|---|
| Direct input selects output root | input or explicit output files cause source/project outDir assignment | adapter test for input-only and output-only |
| `--no-www` | maps to `tryWww: false` | absence preserves config; flag disables www attempt |
| Window/concurrency relation | schema rejects window smaller than concurrency | domain config test |
| Retry classification | temporary DNS, timeout, invalid status, 5xx-like outcomes can be retryable | DNS/HTTP unit tests |
| Retry file semantics | retry output contains retryable inputs, not all rejects | run test with accepted/rejected/retry rows |
| Audit mode | writes per-domain stage records and summary | audit path and stage counts asserted |

## Stage, artifact, result, and diagnostic routes

Three channels stay separate:

```text
stable result:       requested stdout/destination bytes
operational logs:    stderr or diagnostic sinks
artifacts/stages:    typed durable files, archives, checkpoints, summaries
```

Stage writer contract:

```ts
export interface StageWriter {
  write(stage: StageName, data: StageRecordInput): Promise<void>;
  flush(): Promise<void>;
  snapshot(stage: StageName): readonly StageLine[] | undefined;
  pathFor(stage: StageName): string;
  counts(): Readonly<Record<string, number>>;
}
```

Envelope:

```ts
{
  schema_version: 1,
  run_id,
  stage,
  seq,
  target,
  data,
  written_at,
}
```

Rules:

- durable stage JSONL is written by the stage writer, not by arbitrary log calls;
- known payloads use stage-specific Zod schemas;
- unknown payloads must still be JSON-compatible;
- `Date` values serialize to ISO strings;
- `undefined` object fields are dropped;
- raw `ArrayBuffer` or typed-array payloads are rejected;
- binary evidence belongs in WARC/WACZ/artifact storage with digest, byte count,
  and path/reference in the stage line;
- LogTape may mirror the validated stage line under a structured property, but
  that mirror is not the durable source of truth.

Result/diagnostic rules:

- stable JSON output must not contain pretty diagnostics, colors, timestamps, or
  category labels;
- diagnostics must not go to stdout in machine-result mode;
- route-specific redaction must happen before rendering when required;
- pre-handler failures recover only raw logging controls and must leave stdout
  empty unless the command explicitly requested a result.

## Lifecycle, concurrency, cancellation, and cleanup

Target lifecycle:

```text
composition root owns signal
  -> one AbortController tree
  -> parser/run resource gets signal
  -> HTTP/browser/workers/queues receive signal
  -> first interrupt requests cooperative stop
  -> second interrupt forces termination
  -> stages/diagnostics/artifacts flush and close
  -> stable cancellation exit
```

Illustrated behaviors to check in the active repository:

| Area | Behavior | Guardrail |
|---|---|---|
| Source run signal | WARC/Common Crawl/browser runs create an `AbortController` internally | Do not claim process-level cancellation until a root signal handler is traced and subprocess-tested |
| Browser route queue | `runBoundedQueue()` limits active routes and stops taking new work when `shouldStop()` is true | active work must also observe the signal |
| Ordered map helper | `mapBoundedAsyncOrdered()` permits concurrent transforms but yields in input order with bounded reorder window | stalled early item can apply backpressure after window fills |
| Detection worker pool | workers compile registry once and process whole observation batches | close in `finally`; fail queued/pending tasks if worker fails |
| Stage writer | per-stage promise queue serializes append order | always `flush()` before summary trust or process exit |
| Diagnostics sink | JSONL writes are queued and reset flushes high-volume buffers | avoid reconfiguring LogTape while active work may still log |
| Browser archive | archive closes on success and in error catch; WACZ packaging reads closed WARC output | close before packaging and verify WACZ readback when claiming replay support |
| Output overwrite | browser uses `run.json`; WARC/Common Crawl use `run-summary.json` marker | destructive overwrite must be explicit and scoped |

## Verification matrix

| Behavior | Evidence target |
|---|---|
| Static command reachability | installed/compiled executable reaches every registered command and generated help |
| Help-only defaults | parser docs show default; parse output omits the value |
| Sparse adapters | adapter tests assert omitted options do not enter patch |
| Profile expansion | browser max profile tests assert only documented policy-implied fields |
| Alias precedence | route/output/log aliases map to one canonical field and provenance path |
| c12 loader semantics | real config fixtures cover `extends`, env branch, JS/TS factory, malformed export |
| App merge semantics | unit tests cover high-to-low caller order, low-to-high evaluation, arrays, operations, atomic unions, immutability |
| Zod final defaults | sparse patch parse has no complete defaults; complete schema parse does |
| Provenance | env/config/default/explicit CLI/equal-value overlay cases are all tested |
| Result isolation | stdout, stderr, diagnostic file, and result string are separately asserted |
| Redaction/exposure | verified secrets are hidden before rendering on applicable routes, while required diagnostic evidence remains visible |
| Stage writer | seq, queue ordering, known schemas, JSON fallback, binary rejection, noop snapshot, counts, flush |
| Browser source | discovery, resume, overwrite, WARC, WACZ, screenshots, failed route stages |
| Common Crawl source | CDX query/page/row/decision stages, retry stages, rate limiter, range cache, summary counts |
| WARC source | single route, record/resource classification, worker close, output marker |
| Domains source | accepted/routes/retry outputs, audit stages, retry classifications, summary file |
| Cancellation | subprocess sends interrupt and checks active work stops, resources flush, exit class is stable |
| Command-language compatibility | long names, aliases, hidden aliases, suggestions, help, completion, and man surfaces stay consistent |
| Interaction safety | `--no-input`, CI/non-TTY, prompts, and missing required values never hang |
| Dangerous operations | dry-run emits executor plan; `--force` and `--confirm=<target>` gates match risk |
| Standard streams | `-` maps to stdin/stdout only for file-like fields; required piped input fails fast on TTY |
| Secrets | argv/env snapshots, config views, URLs, diagnostics, support bundles, and results redact references/values |
| Pager policy | pager activates only for long human TTY output and never for JSON/JSONL/redirected stdout/CI |
| Config edits | target, diff, dry-run, consent, atomic write, and authored-schema validation are all covered |
| Checkpoints/resume | interrupted runs reconcile state, reject incompatible fingerprints, and resume idempotent units |
| Telemetry consent | remote sinks are disabled by default, revocable, redacted, and non-blocking |
| Installed shape | compiled/packed artifact reaches commands, assets, workers, config loading, help, and uninstall/path inspection |

## Failure signatures

| Symptom | Likely ownership bug |
|---|---|
| Config value ignored when CLI flag omitted | parser default polluted sparse patch |
| Help default appears in dry-run patch | documented default was implemented as executable source value |
| Dynamic config factory executes twice | source context and handler both call full resolver |
| `extends` is rejected | strict runtime validation ran inside c12 loading |
| `$append` merges into `$append` object | c12/app merger distinction or standalone operation lowering is missing |
| Plain arrays concatenate | default defu behavior leaked past app merger policy |
| Common Crawl range selector keeps stale named selector fields | atomic union path was not handled |
| Equal CLI/config value loses config provenance | provenance inferred from final value only |
| `config explain` shows only static precedence | resolver did not retain field decisions and shadowed values |
| JSON stdout contains warning text | LogTape result and diagnostic routes are mixed |
| A result that should hide a secret leaks it | result policy ran after the object was flattened/stringified, or the route inherited the wrong exposure policy |
| Stage JSONL contains bytes | artifact writer writer was bypassed |
| WACZ exists but replay fails | package structure was validated without URL-targeted WARC/CDX readback |
| `Ctrl-C` does not stop work | AbortSignal type exists but is not connected to process and active operations |
| Retry file contains all rejects | domain retry classification collapsed retry and terminal rejection |
| Raising Common Crawl concurrency passes type-check | service-safety policy lacks behavior tests |
| Source command works from source but not binary | dynamic command discovery or assets are invisible to bundler/compiler |
| `--no-input` still prompts | prompt adapter bypasses interaction policy or TTY/CI gate |
| Severe destructive command accepts `--force` alone | risk policy collapsed moderate and severe operations |
| Dry-run summary differs from execution | dry-run renderer builds an approximate explanation instead of executor `OperationPlanSchema` |
| `-` creates a file named `-` unexpectedly | endpoint parser did not map standard-stream sentinel contextually |
| Secret appears in shell history or support bundle | CLI accepted secret value directly or stringified before redaction |
| JSON output opens in pager | pager attached to stdout/result route without output-mode and TTY checks |
| Config edit rewrites unrelated formatting | editor ignored format-preserving adapter or broad formatted authored config |
| Resume corrupts output after argument change | checkpoint lacks normalized request fingerprint/precondition check |
| Telemetry failure changes exit code | remote diagnostic/product sink is on critical execution path |
| Uninstall docs miss user state/cache paths | distribution contract lacks owned-path inventory command |

## Sources and freshness

- Historical source scope: CLI and configuration reviews from 2026-07-22,
  adapted into anonymized examples of Optique 1.2 integration, c12 merge policy,
  LogTape routing, artifact writers, source work, and Zod defaults.
- Portable contract guidance: [architecture](architecture.md),
  [configuration](config.md), and the
  [CLI policy audit](../../../guides/cli-guidelines-audit-and-expansion.md).
- Verify installed package exports, lockfile versions, active consumers, and
  executed tests before adopting an example. These traces do not establish
  current maintained APIs or successful execution in another repository.
