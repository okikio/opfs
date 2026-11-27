# Results, diagnostics, and durable artifacts

Use this reference to decide where CLI information goes and how its contract is
kept stable. Load [logtape.md](logtape.md) for full current LogTape semantics.

## Three output classes

### Stable command result

The output the caller explicitly requested. Typical destinations:

- stdout;
- an explicitly named file/object;
- a machine stream;
- a returned programmatic value.

Its format is part of the CLI API. Human, plain, JSON, JSONL, CSV, binary, and
other modes need deliberate schemas and empty/error behavior.

### Operational diagnostics

Information about execution: progress, warnings, retries, cache decisions,
provider state, timings, debug context, and public error explanation. Typical
destination is stderr or diagnostic sinks.

### Durable artifact/state

Files, checkpoints, databases, manifests, reports, exports, or other application
state. These belong to their data/storage writer and commit protocol. They are
not logger records merely because logging can write files.

## Stable stdout rule

Machine-readable stdout must contain only the documented result format. No:

- timestamps;
- levels/categories;
- ANSI color;
- progress bars;
- debug lines;
- prompts;
- stack traces;
- duplicate result summaries.

This makes shell composition predictable.

## LogTape when selected

LogTape can transport structured diagnostics and, where deliberately designed,
stable result records. Keep ownership clear:

- reusable libraries call `getLogger()`/emit categories; they do not globally
  configure LogTape;
- executable root configures sinks, filters, formatters, redaction, and
  lifecycle;
- result categories that feed stable stdout must be isolated from inherited
  diagnostic sinks when the LogTape configuration model requires it;
- diagnostic formatters do not decorate stable results;
- use `@logtape/testing` for structured logger assertions where selected;
- retain successful evidence when useful; control hot noise with filters, rate
  control, summaries, or lazy expensive properties rather than deleting all
  success context.

A custom project formatter can remain when it communicates the domain better
than `@logtape/pretty`. Ecosystem uniformity is not itself a migration reason.

## Synchronous versus asynchronous sinks

Current LogTape distinguishes normal synchronous `Sink` behavior from
asynchronous output via `AsyncSink` and `fromAsyncSink()`. Do not return a
Promise from a normal sink and assume it will be awaited. Verify the installed
version before implementing version-sensitive sink code.

## Redaction is route-specific

Do not wrap every sink in the same redactor automatically. Ask what each route
is allowed to reveal:

```text
diagnostic stderr/log
config show/explain
support bundle
stable JSON result
user-requested export
```

When redaction is required, preserve structure long enough to identify fields.
Serializing the entire record to one opaque string first destroys field-aware
policy.

Test both sides:

- secret is absent;
- necessary IDs/paths/status/correlation context remain useful.

## Human output

Human output can use headings, tables, aligned columns, summaries, progress, and
color when the stream supports it. Keep the narrative actionable and stable
enough for users, but do not promise human prose as a machine API unless
explicitly documented.

When content is large, use filtering/pagination/pager behavior deliberately.
Never page redirected machine output.

## Machine output

Define schemas for JSON/JSONL/etc. Include:

- versioning strategy if persisted/consumed long-term;
- `null` versus missing semantics;
- error/partial-result representation;
- ordering guarantees;
- streaming record framing;
- numeric/time units;
- sensitive fields;
- whether diagnostics ever appear in-band.

For JSONL, one record per line means diagnostic lines cannot share stdout.

## Quiet and silent

Do not guess. Define the product contract. A common distinction is:

- `--quiet`: suppress/reduce ordinary diagnostics but preserve warnings/errors
  and requested result;
- `--silent`: suppress diagnostics more aggressively;
- neither should discard a user-requested data result unless explicitly stated.

Test the actual modes with redirected streams.

## Artifact publication

A requested file/export is successful when its writer's commit contract succeeds,
not when the CLI printed “writing…”. For multi-file outputs use an atomic publish
or manifest/commit marker where needed. Do not route durable state through
LogTape because it is convenient.

## Failure signatures

| Symptom | Cause |
|---|---|
| JSON parser fails on stdout | diagnostics/progress mixed into result stream |
| result appears twice | result emitted and also inherited through diagnostic sinks |
| support bundle missing useful IDs | over-broad redaction |
| secret leaks in `config explain` | route policy not audited |
| async file sink loses tail records | lifecycle/sink type not awaited/flushed |
| `--quiet` hides actual result | result/diagnostic policy conflated |
| human table becomes automation dependency | no machine format contract |
| artifact exists partially after error | publication/abort contract missing |

## Verification

Capture exact streams and artifacts for:

1. human success;
2. JSON/JSONL or other machine success;
3. empty result;
4. invalid input;
5. operational failure;
6. cancellation;
7. quiet/silent/color/no-color;
8. redirected stdout/stderr;
9. secret-bearing diagnostics/config explanation/support output;
10. sink flush/disposal and duplicate-record checks;
11. artifact partial-failure/commit behavior.

A snapshot of pretty output is not enough. Assert machine schemas, exact stream
separation, record counts, sensitive-field policy, and durable artifact state.
