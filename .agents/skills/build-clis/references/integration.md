# CLI integration sequences

## Contents

- [Composition invariants](#composition-invariants)
- [Five-library execution graph](#five-library-execution-graph)
- [Normal command execution](#normal-command-execution)
- [Bootstrap failure](#bootstrap-failure)
- [Configuration explanation](#configuration-explanation)
- [Machine-readable streaming result](#machine-readable-streaming-result)
- [Interactive configuration initialization](#interactive-configuration-initialization)
- [Long-running recoverable command](#long-running-recoverable-command)
- [Durable workflow client](#durable-workflow-client)
- [Project mutation command](#project-mutation-command)
- [Completion and manual generation](#completion-and-manual-generation)
- [Release sequence](#release-sequence)
- [Cross-cutting verification](#cross-cutting-verification)
- [Sources and freshness](#sources-and-freshness)

## Composition invariants

Keep these invariants across every sequence:

1. parse early controls before loading fallible domain configuration;
2. evaluate each external source once;
3. preserve sparse values until precedence resolution finishes;
4. validate the complete request before harmful work;
5. inject capabilities and one abort signal into portable handlers;
6. transport stable results and diagnostics through separate LogTape routes when
   LogTape is the selected owner;
7. persist durable artifacts through typed writers/stores, not log sinks;
8. render one public failure at one error mapper;
9. flush/close owned resources before returning an exit status;
10. verify the exact installed invocation path.

## Five-library execution graph

When Optique, c12, defu, LogTape, and Zod are all present, the intended graph is:

```text
Optique
  owns token grammar, help, suggestions, completion, man pages, and sparse CLI values
      |
      v
c12 loader with c12-aware defu merger
  owns config discovery, formats, extends, environment branches, and factories
      |
      v
application resolver with strict merge policy
  owns precedence, arrays, operations, atomic unions, and sparse patch validation
      |
      v
Zod runtime schema
  applies defaults and transformations once
      |
      v
Optique runProgram hook resource
  threads the single resolved config snapshot and logger into the handler
      |
      v
LogTape
  routes redacted results, diagnostics, bootstrap failures, and lifecycle flush
```

Do not collapse c12's merger and the application merger. Do not let Optique
materialize defaults into sparse source patches. Do not let the handler reload
configuration or configure LogTape.

## Normal command execution

```text
raw argv and process environment
  -> parse help/version/completion and logging controls
  -> configure bootstrap diagnostics
  -> first-pass parse selects command and config path
  -> c12 loads/evaluates file layers once with a loader-aware merger
  -> Optique source contexts bind environment, config, and derived values
  -> sparse CLI/environment/config patches resolve by explicit app precedence
  -> runtime schema applies defaults and semantic checks
  -> runProgram beforeEach creates `{ config, logger }` from that snapshot
  -> composition root creates capabilities and AbortController
  -> portable handler executes validated request
  -> result schema validates outcome
  -> renderer produces human/plain/JSON/JSONL representation
  -> LogTape result category writes exact stdout bytes
  -> diagnostics/resources flush and close
  -> exit 0
```

Reject a design in which the handler reloads config, reads globals, configures
logging, chooses output encoding, or exits the process.

Prove this sequence with one command whose values conflict across CLI,
environment, and config. Assert the final request and provenance, not only the
human output.

## Bootstrap failure

Configuration and parser setup can fail before the main logger exists:

```text
raw argv
  -> recover only --log-level/--log-format/--log-output/--silent
  -> configure minimal redacted LogTape graph
  -> attempt c12 loading
  -> validate retained config layer
  -> one public configuration failure
  -> flush selected diagnostic sink
  -> leave stdout empty
  -> exit configuration class
```

The bootstrap parser must not duplicate domain options. If an early control is
malformed, use a safe stderr fallback owned by the executable layer.

Required cases:

- invalid TypeScript/JavaScript config;
- missing explicit config file;
- malformed scalar export;
- schema-invalid nested field;
- invalid `extends` layer;
- selected JSON diagnostic file;
- `--silent` behavior;
- help and version despite broken project config.

## Configuration explanation

`config explain` is a query over the resolver's recorded decision data:

```text
same source load and merge used by execution
  -> retain ordered layers and per-field contributions
  -> retain append/prepend/replace operations
  -> apply secret redaction to structured records
  -> select one field or complete safe view
  -> render winner, shadowed values, defaults, and source details
  -> emit stable result through result category
```

Do not reconstruct provenance by reloading configuration or comparing only the
final object. Do not show a hardcoded precedence list as though it explains a
field.

Machine output should use a versioned schema:

```ts
const ExplainResultSchema = z.object({
	schema_version: z.literal("1"),
	path: z.string(),
	value: z.unknown(),
	winner: z.object({ source: z.string(), detail: z.string().optional() }),
	shadowed: z.array(z.object({ source: z.string(), detail: z.string().optional() })),
	operations: z.array(z.object({ source: z.string(), operation: z.string() })),
});
```

## Machine-readable streaming result

For a command that streams records:

```text
handler emits typed result records
  -> validate/encode one record at a time
  -> structured redaction sees the record before serialization
  -> JSONL renderer emits exactly one value and newline
  -> LogTape result sink writes raw bytes to stdout
  -> operational progress goes only to stderr/file categories
  -> backpressure is awaited at the result writer backpressure point
```

Do not accumulate an unbounded array for final `JSON.stringify()`. Do not log the
whole record as an opaque string before redaction. Do not let progress spinners
or warnings enter stdout.

Define partial-failure policy:

- fail-fast before any result;
- emit per-record success/error envelopes;
- write an external artifact and return a summary;
- or mark the stream incomplete in a final versioned record.

The selected policy is part of the machine contract. Exit status alone cannot
undo records already consumed from stdout.

## Interactive configuration initialization

```text
parse explicit flags and --no-input
  -> identify missing values
  -> if non-interactive, fail with exact required flags
  -> if interactive, Optique prompt adapter calls Clack/Inquirer renderer
  -> build authored config patch
  -> resolve owned target path through c12/path policy
  -> magicast/confbox prepares source-preserving change
  -> show plan/diff
  -> require authorization appropriate to risk
  -> atomic write
  -> reload through public c12 resolver
  -> validate authored, patch, and runtime schemas
  -> stable result identifies changed file and next command
```

Never prompt merely because a value is absent. Honor TTY, CI, output mode,
redirection, cancellation, and no-input policy. Never print secret answers.

## Long-running recoverable command

A local long-running command needs more than retries:

```text
validated request
  -> canonical request/input fingerprint
  -> acquire run identity and checkpoint owner
  -> reconcile prior checkpoint and external artifacts
  -> process idempotent unit
  -> commit durable output
  -> atomically record committed checkpoint
  -> emit structured progress
  -> repeat until complete or cancelled
```

On first SIGINT:

```text
acknowledge immediately
  -> root AbortController aborts new/active work
  -> current unit resolves according to atomicity policy
  -> committed checkpoint is persisted
  -> subprocesses/workers/browser resources close within deadline
  -> LogTape flushes
  -> exit 130 where the host supports SIGINT status
```

On second SIGINT, follow the declared force policy. Do not claim recovery if a
crash between output commit and checkpoint write can duplicate or lose effects
without reconciliation.

Compose with `build-workflows` when leases, durable timers, replay, cross-process
signals, or multi-worker recovery are material.

## Durable workflow client

Keep the CLI as a client over Temporal, `@effect/workflow`, or another durable
engine:

```text
Optique parses start/status/signal/cancel/result command
  -> c12 resolves endpoint/namespace/task-queue policy
  -> credentials come from a safe SecretSource
  -> client adapter sends a request with workflow/run ID
  -> durable engine owns history, retries, timers, signals, and workers
  -> CLI optionally follows status or returns immediately
  -> stable result returns workflow/run identity and next commands
```

Parser packages such as `@optique/temporal` parse Temporal values. They do not
make an in-process operation durable.

Define separate commands rather than a hidden conversational state:

```text
app run start ...
app run inspect <run-id>
app run follow <run-id>
app run signal <run-id> <signal>
app run cancel <run-id>
app run result <run-id>
```

Handle Ctrl-C while following as “detach” unless the public command explicitly
and safely maps it to workflow cancellation. Never cancel durable work merely
because the client terminal disconnected.

## Project mutation command

For dependency/config/code generation:

```text
discover project and workspace ownership
  -> classify package manager/runtime/framework
  -> build typed operation plan and preconditions
  -> render dry run
  -> authorize apply
  -> stage writes in owned temporary paths
  -> apply files atomically where possible
  -> invoke package manager/build generator with root signal
  -> verify manifests, lockfiles, generated output, and clean consumer
  -> emit changed-file result and rollback/recovery guidance
```

Use pkg-types/nypm/pathe or runtime-native equivalents behind adapters. Preserve
dirty user changes. Do not rewrite unrelated Markdown or configuration.

## Completion and manual generation

```text
statically registered command model
  -> Optique program parser
  -> help document
  -> shell-specific completion generator
  -> @optique/man roff generator
  -> deterministic artifacts
  -> shell/roff syntax checks
  -> drift comparison in release gate
```

Do not require project config, network, credentials, or a repository to generate
basic completion/manual output. Dynamic completion providers must be bounded,
cached, and optional.

Verify every claimed shell. Verify option aliases, choices, hidden terms,
deprecated terms, and subcommands. An artifact existing in `dist/` is not proof
it matches the active parser.

## Release sequence

```text
typecheck/lint/test source
  -> generate static registry/completion/man/docs regions
  -> fail on drift
  -> build package or standalone executable
  -> inspect package contents and embedded assets
  -> install in clean environment
  -> run version/help/config/representative success/failure/cancel cases
  -> verify checksums/signing/provenance where claimed
  -> verify install, upgrade, and uninstall instructions
```

Keep Deno compile, Node SEA, registry packages, and OS packages as different
artifact contracts. Test every target architecture claimed or narrow the claim.

## Cross-cutting verification

For each integration sequence, record:

| Dimension | Evidence |
|---|---|
| Reachability | Active entrypoint imports/registers the command |
| Source ownership | One resolver returns values and provenance |
| Validation | Sparse and complete schemas exercise real invalid cases |
| Output | Exact stdout/stderr/file records and redaction |
| Failure | One diagnostic and stable exit class |
| Cancellation | Concrete process signal reaches active dependency |
| Cleanup | Files, workers, subprocesses, clients, and sinks close |
| Recovery | Restart/reconcile behavior executes rather than being described |
| Packaging | Installed artifact runs without source-tree fallbacks |
| Documentation | Help, manual, completion, and examples agree |

Report each surface as intended, documented, implemented, or executable-verified.
Keep blocked checks distinct from failed checks.

## Sources and freshness

- Portable guidance: [architecture](architecture.md), [configuration](config.md),
  and the [CLI policy audit](../../../guides/cli-guidelines-audit-and-expansion.md).
- Historical source scope: CLI and configuration reviews from 2026-07-17,
  adapted into anonymized integration examples and counterexamples.
- Official project pointers: <https://optique.dev/>, <https://logtape.org/>, and <https://unjs.io/>.

Freshness status: sequences describe ownership and verification invariants, not
proof that an example or the active CLI implements every stage. Re-run the source trace and
installed-artifact checks for the current repository revision and dependency
versions before making a completion claim.
