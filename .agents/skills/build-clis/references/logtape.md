# LogTape output and diagnostics manual

## Contents

- [Evidence and ownership](#evidence-and-ownership)
- [Package capability map](#package-capability-map)
- [Category architecture](#category-architecture)
- [Stable result isolation](#stable-result-isolation)
- [Diagnostic routing](#diagnostic-routing)
- [Structured events and context](#structured-events-and-context)
- [Filters, levels, and output policy](#filters-levels-and-output-policy)
- [Redaction before rendering](#redaction-before-rendering)
- [Bootstrap and reconfiguration](#bootstrap-and-reconfiguration)
- [Lifecycle and disposal](#lifecycle-and-disposal)
- [Library and application ownership](#library-and-application-ownership)
- [Testing](#testing)
- [Exclusions](#exclusions)
- [Failure signatures](#failure-signatures)
- [Sources and freshness](#sources-and-freshness)

## Evidence and ownership

Use the active repository's logging and output contracts. The diagnostics
adapter examples are anonymized illustrations from a historical LogTape 2.2.4
integration. Their local helpers do not define LogTape's public API.

Before adopting this design, establish the existing output owner. If the
repository does not use LogTape and the request does not authorize a migration,
preserve its verified transport and apply only compatible channel principles.

If LogTape is the diagnostic owner, route operational diagnostics through it instead of creating competing logger stacks. Stable command results, workflow state, domain events, durable records, and artifacts keep their own typed authority even when LogTape also observes them. Do not make a log record the only copy of data another subsystem must consume reliably.

## Package capability map

| Capability | Package | Use |
|---|---|---|
| Categories, records, filters, formatters, sinks, context | `@logtape/logtape` | Required transport core |
| Human terminal diagnostics | Repository formatter; `@logtape/pretty` as reference/fallback | Keep a custom formatter when it communicates the repository's records, stages, metrics, or topology more clearly |
| File and rotating diagnostics | `@logtape/file` | Durable support logs and configured files |
| Structured secret protection | `@logtape/redaction` or focused project policy | Apply only after tracing which fields are actually secret and which are essential diagnostic evidence |
| Recorder-backed assertions | `@logtape/testing` | Categories, levels, messages, context, and properties |
| Parser-owned verbosity and destinations | `@optique/logtape` | CLI terms only; does not configure the graph |
| Static rules | `@logtape/lint` | Adopt only when runtime/linter integration maturity fits |
| OpenTelemetry | `@logtape/otel` | Explicitly selected remote telemetry route |
| Other remote/system sinks | Sentry, syslog, CloudWatch, Windows Event Log integrations | Deployment-specific and consent/policy gated |

Inspect the installed version and package exports. Do not add:

- `@logtape/config` when c12 and the application schema already own config;
- a database adapter that does not support the actual dialect or custom adapter;
- every remote sink merely because the ecosystem provides one;
- LogTape packages to manifests that do not import them directly.

## Category architecture

Model categories as ownership and routing namespaces:

```text
app.result              stable general result
app.clickhouse.result   stable ClickHouse-specific result, if separately owned
app.cli                 command lifecycle diagnostics
app.config              config discovery and resolution
app.http                request/retry diagnostics
app.workflow            durable-work client diagnostics
app.deprecation         compatibility warnings
app.progress            structured progress events
logtape.meta            transport configuration failures
```

Use category hierarchy to share policy. Do not encode the entire event type in a
free-form message string. Bind stable dimensions such as command, run ID, target,
and request ID as context or structured properties.

Define category constants so result routing cannot drift:

```ts
export const APP_CATEGORY = ["app"] as const;
export const RESULT_CATEGORY = [...APP_CATEGORY, "result"] as const;
```

## Stable result isolation

A stable result is user-requested output. It may be JSON, JSONL, a completion
script, a man page, a generated config, or plain text. It must remain pipe-safe.

Configure a dedicated raw sink and block inherited diagnostic sinks:

```ts
await configure({
	sinks: {
		result: createResultSink(output.result),
		diagnostic: createDiagnosticSink({ ...options, writer: output.diagnostic }),
	},
	loggers: [
		{
			category: [...RESULT_CATEGORY],
			lowestLevel: "info",
			sinks: ["result"],
			parentSinks: "override",
		},
		{
			category: [...APP_CATEGORY],
			lowestLevel: options.level,
			sinks: ["diagnostic"],
		},
	],
});
```

`parentSinks: "override"` is the important isolation contract in the observed
LogTape version. Verify the option name and behavior in the installed version.

Carry the raw rendered text as a structured property:

```ts
export function emitResult(text: string): void {
	getLogger([...RESULT_CATEGORY]).info("{result}", {
		result: text.endsWith("\n") ? text : `${text}\n`,
	});
}
```

The raw sink reads only the expected property:

```ts
import { fromAsyncSink, type AsyncSink, type Sink } from "@logtape/logtape";

export interface ByteWriter {
	write(bytes: Uint8Array): void | Promise<void>;
}

function createResultSink(writer: ByteWriter): Sink & AsyncDisposable {
	const encoder = new TextEncoder();
	const sink: AsyncSink = async (record): Promise<void> => {
		const result = record.properties.result;
		if (typeof result !== "string") {
			throw new TypeError("Result records require a string result property.");
		}
		await writer.write(encoder.encode(result));
	};

	return fromAsyncSink(sink);
}
```

LogTape sinks are synchronous by design. Use `AsyncSink` plus `fromAsyncSink()`
when the runtime-neutral writer can require asynchronous backpressure or I/O;
do not return a promise from a plain `Sink`.

Do not let the result sink add timestamps, levels, category names, colors, or a
second newline. Define exact newline and empty-result policy. For JSONL, emit one
complete JSON value per record and reject embedded raw newlines where the schema
forbids them.

## Diagnostic routing

Diagnostics describe execution rather than return the requested value. Route
them to stderr, a selected file, or explicitly configured remote sinks.

Select formatters by mode. If the repository owns a compact formatter, keep it
as the human default and use `@logtape/pretty` as a source of ideas or a
fallback, not as an automatic replacement:

```ts
function diagnosticFormatter(options: LogOptions): TextFormatter {
	if (options.format === "json") return jsonLinesFormatter;
	if (options.format === "plain") return defaultTextFormatter;
	return createRepositoryFormatter({
		timestamp: "time",
		colors: options.colors,
		width: options.width,
		properties: true,
	});
}
```

A professional repository formatter should have explicit renderers for the
structured shapes it already emits, such as stages, result records, metrics,
process/resource trees, causes, grouped properties, multiline values, and
terminal-width degradation. Test narrow terminals and non-TTY output. Do not
flatten structured records merely to make the formatter easier to implement.

Resolve terminal width and color for stderr independently from stdout. Never put
ANSI styling in machine results. `NO_COLOR`, forced color, explicit flags, CI,
TTY status, and stream capability need one precedence policy.

Use a file sink when diagnostics must survive the process or support a bug
bundle. Define rotation, retention, permissions, path ownership, flushing, and
failure policy. A failed optional diagnostic file should not silently destroy a
successful domain result; the product must decide whether it degrades, warns, or
fails before starting work.

## Structured events and context

Keep message templates stable and properties queryable:

```ts
logger.info("migration generated", {
	migration_id: migration.id,
	statement_count: migration.statements.length,
	output_path: migration.path,
});
```

Avoid pre-rendered interpolation when the values matter:

```ts
logger.info(`Generated ${migration.id} with ${migration.statements.length}`);
```

The structured form preserves filtering, JSON encoding, redaction, recorder
tests, support-bundle extraction, and future telemetry.

Bind stable context once per operation:

```text
run_id
command
target
request_id
plan_id
attempt
```

Use lazy properties for expensive debug-only calculations. Do not hash files,
serialize large graphs, or inspect the filesystem before knowing a sink will
receive the debug record.

Log a cause as structured, redacted data. Public error rendering remains owned
by the executable entry point. Do not emit the same failure in a handler and again
at the entrypoint.

## Filters, levels, and output policy

Keep result mode separate from diagnostic verbosity:

```ts
const OutputPolicySchema = z.object({
	mode: z.enum(["human", "plain", "json", "jsonl"]),
	quiet: z.boolean().default(false),
	silent: z.boolean().default(false),
	color: z.enum(["auto", "always", "never"]).default("auto"),
});
```

Suggested semantics:

- `--quiet` suppresses routine human diagnostics while preserving warnings,
  errors, and requested results;
- `--silent` suppresses diagnostics but preserves requested results unless the
  public contract explicitly says otherwise;
- repeated `-v` raises diagnostic detail but does not change result encoding;
- a configured level and repeated verbosity need an explicit algebra;
- subsystem filters may raise or lower a category without changing siblings.

The illustrative adapter treats repeated verbosity as an override only when it
raises detail above its baseline. That is one product policy, not a LogTape rule.
Document and test the chosen behavior.

Progress is a structured event stream. A TTY renderer may turn it into a spinner
or live region; a JSON diagnostic sink may retain state changes; normal stderr
may show only acknowledgement and milestones. Do not add Clack or Consola as an
untracked second event transport.

Do not make a fingers-crossed or sampling sink the only record of successful
work. Successful execution remains evidence. A human sink may retain only a
compact success summary, while a configured durable diagnostic sink keeps the
full structured records. Rate controls may collapse repetitive records into
counted summaries, but they must not make completed work disappear without an
intentional retention policy.

## Redaction before rendering

Redaction is a deliberate data policy, not a blanket formatter wrapper. Trace
real log call sites and classify each field before choosing patterns. A broad
name such as `token`, `key`, `path`, `url`, `id`, or `value` can contain either a
secret or the exact evidence needed to diagnose a failure. Blind field-name
redaction can make an incident impossible to debug.

For fields that are verified secrets, redact the structured value before a
formatter serializes it:

```ts
const sink = redactByField(createDiagnosticSink(options), {
	fieldPatterns: [
		/^authorization$/iu,
		/^cookie$/iu,
		/^set-cookie$/iu,
		/^password$/iu,
	],
	action: () => "[REDACTED]",
});
```

Do not automatically wrap the stable result route. A command such as
`config show`, an export, or a support bundle needs its own schema/policy that
defines what the user is allowed to receive. Diagnostic redaction must not
silently mutate a user-requested result.

If redaction applies, keep the record structured until after that policy runs.
`JSON.stringify()` first makes nested field policy much harder. Test nested
values, arrays, URLs, connection strings, errors/causes, bootstrap records, and
support bundles. Prefer exact field/location rules or narrow value policies to
large generic deny lists.

Redaction is defense in depth. Continue to reject secrets in argv and broad
environment/config dumps. Add regression tests that prove both sides: known
secrets are hidden and known diagnostic identifiers remain visible.

## Bootstrap and reconfiguration

Configuration can fail before the full CLI is parsed. Implement a deliberately
small early-control pass:

```text
raw args and environment
  -> logging-only controls
  -> bootstrap LogTape configuration
  -> c12/source loading
  -> full Optique parse
  -> validated final logging policy
  -> reconfigure once
  -> command execution
```

The early pass may recover log format, destination, level, and silent policy. It
must not duplicate domain grammar. Test malformed configuration with each early
logging option and verify stdout remains empty.

If reconfiguration calls `reset()`, ensure no active command logs between reset
and final configuration. Cache an exact normalized signature only if repeated
configuration is semantically idempotent. Tests must reset process-global state
between cases.

## Lifecycle and disposal

Configure LogTape at the composition root. Before exit:

1. stop new work;
2. abort or complete active operations;
3. close owned domain resources;
4. flush asynchronous sinks;
5. dispose file and remote transport resources;
6. reset process-global logging state for embedded/test contexts;
7. return the stable exit status.

Do not close the host's stdout or stderr stream. The adapter owns wrappers, not
process-global streams.

Exercise success, domain failure, parse failure, config failure, cancellation,
and second-interrupt paths. A direct `Deno.exit()` or `process.exit()` before
awaited cleanup can lose file or remote records.

## Library and application ownership

Expose a small structural logger contract to reusable packages:

```ts
export interface DiagnosticLogger {
	debug(message: string, properties?: Readonly<Record<string, unknown>>): void;
	info(message: string, properties?: Readonly<Record<string, unknown>>): void;
	warn(message: string, properties?: Readonly<Record<string, unknown>>): void;
	error(message: string, properties?: Readonly<Record<string, unknown>>): void;
}
```

Libraries record events but never choose sinks, files, remote endpoints, global
levels, or redaction policy. Without application configuration, library logging
must remain safe and silent according to LogTape's library-first model.

Keep durable JSONL stage writers, databases, checkpoints, and exports as their
own typed capabilities. They may also emit diagnostic records, but LogTape must
not become their persistence protocol.

## Testing

Use `@logtape/testing` recorder sinks for structured assertions and subprocess
tests for byte-level process contracts.

Test:

- category, level, message template, properties, and bound context;
- result category does not reach parent diagnostic sinks;
- diagnostic category never reaches stdout;
- exact result bytes and newline behavior;
- pretty/plain/JSON diagnostic shape;
- quiet, silent, repeated verbosity, and subsystem levels;
- route-specific secret policy hides verified secrets without removing required
  diagnostic identifiers;
- bootstrap config failure routing;
- selected file destination and file flush;
- successful operations retain either their structured records or an explicit
  counted/summary record according to the configured retention policy;
- one public failure record, not duplicates;
- process cancellation and sink cleanup;
- reset isolation between tests;
- remote sink absence until consent/policy is present.

Example route assertions:

```text
command success with --json
  stdout: exactly one JSON document
  stderr: empty at normal level
  file: no result record

invalid config with --log-format json --log-output errors.jsonl
  stdout: empty
  stderr: empty when file exclusively owns diagnostics
  file: one redacted JSONL failure record
  exit: configuration class
```

## Exclusions

- Do not add Consola beside LogTape for friendly output. It is an alternative
  terminal logger/reporter and would split routing and testing ownership.
- Do not send pager control sequences through a sink. A pager consumes a
  completed human result document after result rendering policy selects it.
- Do not use remote telemetry without consent or explicit organization policy.
- Do not let telemetry failure block the command unless the product explicitly
  requires audit delivery.
- Do not put `console.*` fallbacks inside handlers. If bootstrap transport can
  fail, define one minimal emergency path at the executable root.
- Do not treat LogTape as a workflow history, queue, database, or artifact store.

## Failure signatures

| Signature | Likely cause | Next inspection |
|---|---|---|
| JSON contains timestamps/category prefixes | Result inherited diagnostic formatter | Check result category and `parentSinks` |
| Result appears twice | Result reaches result and parent sinks | Check category hierarchy and override |
| Secret survives inside a JSON string | Serialization happened before redaction | Keep object structured until sink wrapper |
| `--silent` removes requested JSON | Result and diagnostics share one filter | Separate result category from level policy |
| Invalid config ignores `--log-output` | Logger configured only after config resolution | Add logging-only bootstrap pass |
| Same error appears twice | Handler and executable entry point both render/log | Give public error output one owner |
| File log misses final records | Process exits before flush/disposal | Trace the awaited lifecycle owner |
| Test records leak between cases | Process-global LogTape state not reset | Reset in test teardown |
| Debug logging is expensive when hidden | Properties computed eagerly | Use lazy evaluation and category filters |
| Pretty output corrupts a pipe | TTY/color resolved globally, not per stream | Inspect stdout/stderr policy separately |
| Durable stage data appears as log messages | Artifact persistence was collapsed into diagnostics | Restore typed writer/store ownership |
| Remote data leaves process unexpectedly | Sink enabled without consent/policy | Trace telemetry configuration and defaults |

## Sources and freshness

- Portable guidance: [CLI architecture](architecture.md) and the
  [CLI policy audit](../../../guides/cli-guidelines-audit-and-expansion.md).
- Historical source scope: a diagnostics adapter and its tests/manifests,
  reviewed 2026-07-17 and adapted here into anonymized examples.
- Official documentation: <https://logtape.org/>, discovery pointer for current categories, sinks, formatters, filters, redaction, and integrations.
- Official source: <https://github.com/dahlia/logtape>, discovery pointer for package/version history.

Historical version scope: the adapter examples concern LogTape 2.2.4.
The recorded review of sink lifecycle and async-sink notes checked them
against the official LogTape 2.3.1 documentation/changelog on 2026-08-19.
The reviewed LogTape 2.3.1 documentation keeps a plain `Sink` synchronous; asynchronous output uses `AsyncSink` wrapped by `fromAsyncSink()`, and that wrapper requires asynchronous disposal. Always verify `parentSinks`, sink wrapper signatures, formatter APIs, context helpers, lint maturity, and optional package names against the repository's installed version before copying code.
