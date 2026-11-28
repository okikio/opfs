# Optique command-system manual

## Contents

- [Evidence and version discipline](#evidence-and-version-discipline)
- [Package capability map](#package-capability-map)
- [Parser architecture](#parser-architecture)
- [Typed grammar](#typed-grammar)
- [Sparse sources and precedence](#sparse-sources-and-precedence)
- [Schemas and validation](#schemas-and-validation)
- [Version-specific features](#version-specific-features)
- [Discovery, running, and packaging](#discovery-running-and-packaging)
- [Help, completion, and manuals](#help-completion-and-manuals)
- [Prompts and interaction adapters](#prompts-and-interaction-adapters)
- [Logging, time, and Git integrations](#logging-time-and-git-integrations)
- [Error ownership](#error-ownership)
- [Testing and verification](#testing-and-verification)
- [Failure signatures](#failure-signatures)
- [Sources and freshness](#sources-and-freshness)

## Evidence and version discipline

Use the active repository's CLI architecture. The implementation examples are
anonymized illustrations from historical CLI reviews. A package's presence in a
manifest or guide does not prove that its features work in the active consumer.

Historical integration examples mixed stable Optique 1.1.1 packages with prerelease 1.2 builds. The recorded official documentation review on 2026-08-19 identified 1.2.1 as stable and 1.3 material as unreleased. Before editing any repository, verify the installed line rather than assuming this guidebook or a previous lockfile is current:

1. inventory the root manifest, CLI manifest, import map, and lockfile;
2. group every `@optique/*` package by the exact resolved version;
3. inspect the package export map or type declarations for the installed build;
4. keep core, runner, discovery, and integration packages on compatible lines;
5. run the packaged executable because a type-compatible dev build can still
   fail during bundling, discovery, or completion generation.

Do not normalize a prerelease version to a caret range or stable line without a
documented migration. Do not copy a current documentation example into an older
installed version without checking its exports. When the installed stable line already provides the required behavior, prefer its native feature over a project-local compatibility shim.

## Package capability map

Select packages by owned capability. Do not install the entire ecosystem.

| Capability | Package or integration | Ownership |
|---|---|---|
| Grammar algebra and value parsing | `@optique/core` | Options, arguments, commands, constructs, modifiers, values, usage metadata |
| Executable runner | `@optique/run` | Argument execution, help/version/completion behavior where used directly |
| Command modules and program runner | `@optique/discover` | Command definition, program metadata, registration/discovery, dispatch |
| Environment values | `@optique/env` | Typed environment and dotenv-backed source context |
| Configuration values | `@optique/config` | Binding parser terms to a loaded configuration context |
| Derived fallbacks | `@optique/derived-defaults` | Values computed after a first parse without becoming CLI values |
| Zod value parsing | `@optique/zod` | Zod diagnostics, transformations, and schema-derived metadata |
| Valibot value parsing | `@optique/valibot` | Modular validation and picklist-derived metadata where available |
| Validator-neutral validation seam | Standard Schema integration | Interoperable validation; not rich completion metadata by itself |
| Prompts | `@optique/prompt` | Missing-value prompt binding and prompt contract |
| Clack presentation | `@optique/clack` | Clack-backed implementation of Optique prompt behavior |
| Inquirer presentation | Optique Inquirer integration | Alternative prompt renderer; verify exact installed package/export |
| Diagnostics options | `@optique/logtape` | Verbosity and diagnostic destination parser terms, not LogTape configuration |
| Temporal values | `@optique/temporal` | Duration, instant, and plain-date value parsers |
| Manuals | `@optique/man` | Roff manual generation from the parser/program document |
| Git values | Optique Git integration | Git-aware parsers/completion; verify exact package and repository requirement |

The audit guidebook also names completion, configuration, environment, derived
defaults, prompt, Git, Clack, Inquirer, LogTape, Temporal, Zod, Valibot, and
Standard Schema integrations. Treat that as an ecosystem-discovery requirement,
not proof of the precise import path in an arbitrary installed revision.

## Parser architecture

Keep four models separate:

```text
tokens and structural grammar
  -> sparse source patch
  -> resolved request schema
  -> portable command handler
```

Optique owns the first arrow and may own typed adapters for other sources. It
does not own domain orchestration, persistence, retry policy, risk policy, or
process-global logging configuration.

Define a portable command independently when commands must be exercised outside
the CLI:

```ts
import type { StandardSchemaV1 } from "@standard-schema/spec";

export interface CommandDefinition<TPatch, TRequest, TResult> {
	readonly path: readonly string[];
	readonly patchSchema: StandardSchemaV1<unknown, TPatch>;
	readonly requestSchema: StandardSchemaV1<unknown, TRequest>;
	readonly resultSchema: StandardSchemaV1<unknown, TResult>;
	run(request: TRequest, context: CommandContext): Promise<TResult>;
}
```

Let the executable adapter:

1. parse raw tokens;
2. load source contexts once;
3. construct a sparse patch;
4. resolve precedence and defaults;
5. validate the complete request;
6. call the portable command;
7. route its typed outcome.

Do not read `Deno.args`, `process.argv`, environment variables, or config files
inside the domain handler.

## Typed grammar

Use the smallest grammar that prevents invalid structures before execution.
The historical integration example used these public subpaths:

```ts
import { merge, object } from "@optique/core/constructs";
import { optional } from "@optique/core/modifiers";
import { message } from "@optique/core/message";
import { negatableFlag, option } from "@optique/core/primitives";
import { choice, integer, string } from "@optique/core/valueparser";
```

Preserve absence for source-bearing values:

```ts
import { object } from "@optique/core/constructs";
import { optional } from "@optique/core/modifiers";
import { option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";

export const syncPatchParser = object({
	endpoint: optional(option("--endpoint", string({ metavar: "URL" }))),
	output: optional(option("--output", string({ metavar: "DIRECTORY" }))),
});
```

Do not add `withDefault()` to a value that should fall through to environment or
configuration. Use `withDefault()` only for parser-local behavior or when the
parser is intentionally the sole source owner. For source-bearing values,
document defaults in help/man output without materializing them into the parsed
patch.

Represent alternatives structurally. Prefer a parser result that already
selects one branch:

```ts
type OutputSelection =
	| { readonly mode: "stdout"; readonly format: "json" | "jsonl" }
	| { readonly mode: "directory"; readonly path: string }
	| { readonly mode: "remote"; readonly endpoint: URL };
```

Do not independently parse `--stdout`, `--output`, and `--endpoint` into three
optional properties and defer impossible combinations to the handler when the
grammar can exclude them.

Keep long names canonical. Attach a short alias to the same term. Model visible,
hidden compatibility, and deprecated aliases deliberately. Never accept
arbitrary command prefixes or reinterpret an unknown command silently.

## Sparse sources and precedence

Use one visible fallback chain:

```text
explicit CLI
  > environment
  > resolved configuration
  > derived default
  > final request-schema default
```

Use an Optique source context for each non-token source. The illustrative
integration composes them as follows:

```ts
import { createConfigContext } from "@optique/config";
import { createDerivedDefaults } from "@optique/derived-defaults";
import { createEnvContext } from "@optique/env";

export const envContext = createEnvContext({
	prefix: "APP_",
	envFile: [".env", ".env.local"],
});

export const configContext = createConfigContext({ schema: configPatchSchema });

export const derived = createDerivedDefaults({
	run_id: (parsed: unknown) => deriveRunId(parsed),
});

export const contexts = [envContext, configContext, derived.context] as const;
```

Bind one parser term to a source rather than parsing the same setting in
uncoordinated loaders:

```ts
const output = bindEnv(
	bindConfig(option("--output", outputParser), {
		context: configContext,
		key: (config) => config.output,
	}),
	{
		context: envContext,
		key: "OUTPUT",
		parser: outputParser,
	},
);
```

Check actual wrapper nesting and source-context precedence in the installed
version. Encode the intended winner order in tests rather than inferring it from
visual nesting.

Two-pass parsing is legitimate when an early token such as `--config` determines
which source to load. Keep the first pass minimal. Load dynamic configuration
once and reuse its result. Do not execute an async config factory before parsing
and then execute it again inside a command. When using `@optique/discover`,
thread the loaded snapshot through `runProgram()` hooks or an equivalent
composition-root resource.

Derived defaults consume first-pass values but remain lower precedence than
authored sources. They must be deterministic for the same input and must not
perform unbounded network or filesystem work.

## Schemas and validation

Use parser structure for token-language validity and schemas for value/domain
validity.

Choose adapters intentionally:

- use Zod v4 when schemas own transformations, codecs, JSON Schema, complex
  refinements, or broad server-side integration;
- use Valibot when modular imports and client bundle size materially matter;
- accept Standard Schema at portable library and plugin APIs;
- use the Optique-specific Zod or Valibot adapter when it provides richer
  diagnostics or completion metadata than the generic schema adapter.

Example Zod parser:

```ts
import { zod } from "@optique/zod";
import * as z from "zod";

const endpoint = option(
	"--endpoint",
	zod(z.url(), { placeholder: "https://example.com" }),
);
```

Do not assume Standard Schema exposes enum choices, labels, JSON Schema, or
completion metadata. Store explicit completion hints beside a generic schema or
use the richer adapter.

Keep schema stages distinct:

- authored schema: ergonomic config syntax, operations, and shorthands;
- sparse patch schema: normalized values without defaults;
- resolved request schema: defaults, cross-field refinements, brands, and
  executable domain values.

When composing Zod objects from `.shape`, `pick`, `extend`, or manual fields,
audit refinements and transformations. Reapply cross-field rules to the final
schema and test the exact composed schema.

Remote/asynchronous validation used for completion must be bounded, cached, and
optional. Completion should degrade to no dynamic suggestions rather than block
ordinary parsing or hang the shell.

## Version-specific features

Use `negatableFlag()` for paired Boolean options:

```ts
export const cachePatch = object({
	range_cache_enabled: optional(negatableFlag({
		positive: "--range-cache",
		negative: "--no-range-cache",
	}, {
		description: message`Enable or disable range-cache reuse.`,
	})),
});
```

This produces one tri-state patch field: absent, explicitly `true`, or
explicitly `false`. Do not parse `--cache` and `--no-cache` as two independent
flags and reconcile them later.

Use `choice(schema.options, { suggest: "nearest" })` for enum-like CLI
languages when the Zod schema exposes the option list. Let Optique see the
choices natively so help, completion, and spelling suggestions are generated
from the parser. Use `@optique/zod` for richer scalar schemas such as URLs,
branded values, transformations, or diagnostics that are not just an enum.

Use `deferredValue()` only when the fallback genuinely belongs at handler time:
interactive prompt fallback, secret lookup, expensive project discovery,
handler-scoped services, or values that need a runtime context. The parsed field
is a `DeferredValue` function; calling it returns the specified value or runs
the fallback. This is not an ordinary defaulting mechanism and should not be
used for static config defaults.

Optique 1.2-era value parsers carry type-appropriate placeholders used during
deferred prompt resolution. The placeholder exists to keep first-pass parsing
and `map()` transforms structurally valid. It is not user intent and must not
be serialized into sparse patches, provenance, or final command requests.

Use `runProgram()` lifecycle hooks for per-command resources:

```ts
await runProgram<AppResource>({
	commands,
	metadata,
	hooks: {
		async beforeEach(invocation) {
			const config = await resolveOnce(invocation.value);
			const logger = await configureLogger(config.logging);
			return { resource: { config, logger } };
		},
		async afterEach(context) {
			await context.resource?.logger.flush();
		},
	},
});
```

This is the right place to thread one resolved config snapshot, logger scope,
tracing span, or lazy service into handlers. It avoids loading c12 for source
contexts and then loading the same dynamic project config again in the handler.

## Discovery, running, and packaging

Use explicit command imports for bundlers and standalone executables:

```ts
import browserDetect from "./commands/browser/detect.ts";
import configShow from "./commands/config/show.ts";
import configValidate from "./commands/config/validate.ts";

export const commands = [browserDetect, configShow, configValidate] as const;
```

The illustrative CLI passes a static registry to `runProgram()` even though it
uses `@optique/discover` command definitions. This preserves visibility to Deno
compile and bundlers.

```ts
await runProgram({
	commands,
	args,
	metadata,
	help: "both",
	completion: "both",
	contexts,
	contextOptions: {
		async load(parsed) {
			return loadSourcesOnce(parsed);
		},
	},
});
```

Runtime directory scanning is acceptable only when the installed environment
retains the directory and supports dynamic imports. Prove it in the packed or
compiled artifact. A generator may create the static registry, but commit or
generate it before compilation and add drift detection.

Use `@optique/run` for a direct parser runner where a command-module program is
unnecessary. Do not add both runners without an explicit composition seam.

## Help, completion, and manuals

Generate these surfaces from the same parser document:

- root and subcommand help;
- help command and/or `--help` according to product policy;
- shell completion for every shell claimed by the release;
- roff man pages through `@optique/man`;
- command examples, aliases, choices, defaults, and deprecations.

The illustrative implementation uses `createProgramParser()` and
`generateManPageAsync()`. Verify their signatures against the installed
prerelease before copying that pattern.

Help, version, completion, and manual generation must run without a valid
project config unless their content truly depends on it. A malformed config
should not prevent the user from discovering how to repair configuration.

Test Bash, zsh, fish, PowerShell, and Nushell only when claimed. Parse or source
the generated artifact with the real shell where available. Snapshot tests alone
do not prove scripts are syntactically valid.

## Prompts and interaction adapters

Optique prompt integrations bind a missing value to an interaction adapter.
They do not own the product's automation policy.

Gate every prompt on:

- stdin is an appropriate TTY;
- CI and non-interactive policy;
- `--no-input` or equivalent;
- output mode and redirection;
- cancellation;
- secret-input requirements.

The observed `config init` command imports `prompt` from `@optique/clack`.
Treat this as evidence of an adapter, not proof that every command is safe in
CI. Test the actual command with closed stdin and `--no-input`.

Choose Clack or Inquirer as presentation alternatives. Do not install both
without a concrete interaction requirement. Keep parser and handler independent
from the renderer so tests can inject answers without terminal automation.

## Logging, time, and Git integrations

Use `@optique/logtape` for parser terms such as repeated verbosity and log
destination. Configure LogTape itself at the executable composition root.
`verbosity()` and `logOutput()` do not establish categories, sinks, redaction,
or flushing.

Use `@optique/temporal` to parse authored durations, instants, and dates into
semantic Temporal values. Do not immediately turn a duration back into a loose
string. Validate supported units, zero/negative behavior, and serialization.

Use Git-aware integration only when Git concepts are public command inputs or
completion targets. Inject repository discovery and subprocess capabilities;
do not make ordinary help depend on a repository. Verify exact package exports
because the guidebook records the integration family, not a stable universal
import path.

## Error ownership

Optique may render syntax and value-parser failures. The application entrypoint
owns merged-source validation, domain failures, public diagnostics, and exit
classes.

Do not:

- catch Optique stderr text and wrap it repeatedly;
- log a parse error and rethrow it to a second logger;
- collapse all failures to exit 2;
- silently reinterpret typos;
- expose raw schema internals without a user-facing path and correction.

Normalize Deno task separators only at the executable entrypoint if tasks inject
an extra `--`. Keep that compatibility adapter outside the domain parser and
test direct binary and task invocation separately.

## Testing and verification

Add tests at five levels:

1. parser algebra: option order, aliases, exclusions, missing values, and sparse
   output;
2. source contexts: CLI/environment/config/derived/default precedence and one
   source load;
3. resolved request: refinements, transformations, and default timing;
4. generated surfaces: help, completion, man, and registry drift;
5. subprocess/package: stdout, stderr, exit status, signals, and static command
   reachability in the artifact users install.

Use table-driven tests for every public term:

| Case | Expected proof |
|---|---|
| flag absent, config present | config survives sparse CLI patch |
| flag and environment present | flag wins and provenance records both |
| first-pass config selector | factory executes once |
| mutually exclusive terms | parser rejects before handler |
| malformed config | help/version still work |
| hidden alias | parses but does not clutter normal help |
| completion network unavailable | completion returns promptly |
| compiled binary | every statically registered command is reachable |

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| Config value disappears when no flag is passed | Parser default polluted sparse patch | Search `withDefault`, `??`, and defaulted patch schemas |
| Dynamic config runs twice | Two parser/resolver passes reload sources | Trace source-context loading, `runProgram()` hooks, and handler config reads |
| Command works from source but not binary | Dynamic discovery or asset graph is invisible | Inspect registration and compiled contents |
| Final schema accepts an invalid combination | Object composition lost a refinement | Inspect `.shape`, `pick`, `extend`, and final `superRefine` |
| Completion hangs | Remote validation/provider is unbounded | Add deadline, cache, and empty fallback |
| Help fails on malformed project config | Bootstrap surfaces load domain config too early | Split early controls from source-bearing execution |
| Prompt hangs in CI | TTY/no-input policy is outside prompt adapter | Trace interaction policy before prompt binding |
| `-v` and configured level disagree | Verbosity and source level have no explicit algebra | Define winner/raising semantics and test repeats |
| Alias appears as a new canonical command | Compatibility alias lacks visibility/deprecation metadata | Inspect command metadata and generated docs |
| Stable and dev packages resolve together | Optique package lines are incompatible | Compare import map and lockfile exact versions |

## Sources and freshness

- Portable guidance: [CLI architecture](architecture.md) and the
  [CLI policy audit](../../../guides/cli-guidelines-audit-and-expansion.md).
- Historical source scope: CLI integration reviews from 2026-07-17 and
  2026-07-22, adapted here into anonymized examples.
- Official project documentation: <https://optique.dev/>, discovery pointer for current APIs; re-verify against the installed package exports.
- Official source: <https://github.com/dahlia/optique>, discovery pointer for package/version history and implementation details.
- Official Optique documentation and changelog were rechecked on 2026-08-19. Stable 1.2.1 fixes shell-completion descriptions; unstable 1.3 material must not be treated as released behavior.

Freshness status: package names and architectural capabilities are grounded in
the historical integration review plus the recorded 2026-08-19 official Optique review. Exact
examples remain version-bound evidence. Inspect the current official docs,
installed types, and lockfile before implementation.
