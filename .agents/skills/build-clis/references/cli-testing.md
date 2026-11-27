# CLI verification playbook

Verification must prove the public contract through the artifact users receive.
Static schema inspection, parser unit tests, and a successful type-check are
necessary evidence, but none proves the whole CLI.

## Contents

1. [Test layers](#test-layers)
2. [Schema and default tests](#schema-and-default-tests)
3. [Optique grammar and source tests](#optique-grammar-and-source-tests)
4. [c12 and defu tests](#c12-and-defu-tests)
5. [Provenance tests](#provenance-tests)
6. [LogTape and stream tests](#logtape-and-stream-tests)
7. [Lifecycle and cancellation tests](#lifecycle-and-cancellation-tests)
8. [Generated and installed surfaces](#generated-and-installed-surfaces)
9. [Benchmark gates](#benchmark-gates)
10. [Evidence reporting](#evidence-reporting)

## Test layers

| Layer | Proves | Cannot prove alone |
|---|---|---|
| Schema unit | Defaults, transforms, refinements, invalid combinations | CLI grammar or source precedence |
| Parser unit | Token language and sparse output | Real c12 loading or stream bytes |
| Merger unit | Precedence and merge algebra | c12 integration or factory count |
| Real config fixture | Discovery, `extends`, env branches, factories | Packaged executable behavior |
| In-process program | Handler/resource composition | OS signals and exact stdio |
| Subprocess | Exit, stdout, stderr, signals, TTY/pipe behavior | Published package contents |
| Generated surface | Help/completion/man agreement | Installed asset availability |
| Clean consumer | Install/compile/package contract | Every supported platform unless run there |
| Benchmark | Cost under a named workload | Correctness or general performance |

Use the repository’s task graph when present. A Deno-oriented split often looks
like:

```text
deno test path/to/schema_test.ts
deno test path/to/merge_test.ts
deno test --allow-read --allow-write path/to/config_fixture_test.ts
deno test --allow-run --allow-read path/to/cli_subprocess_test.ts
deno check path/to/entrypoint.ts
deno task build
deno test path/to/installed_artifact_test.ts
deno bench path/to/cli_bench.ts
```

Do not invent permissions or task names. Inspect the manifest and report the
actual commands and exit statuses.

## Schema and default tests

Test authored, sparse, and complete schemas independently.

```ts
import { describe, it } from "node:test";
import { expect } from "@std/expect";

describe("configuration schema stages", () => {
	it("keeps source patches sparse", () => {
		expect(CliPatchSchema.parse({})).toEqual({});
	});

	it("materializes defaults only in the complete schema", () => {
		expect(RuntimeConfigSchema.parse({}).timeoutSeconds).toBe(30);
	});

	it("runs prefault input through normalization", () => {
		expect(RuntimeConfigSchema.parse({}).outputDirectory).toBe("./dist");
	});
});
```

Required default matrix:

| Case | Required assertion |
|---|---|
| Help-only default | Visible in help/man; absent in parsed patch |
| Scalar `.default()` | Output-shaped fallback materializes |
| Scalar `.prefault()` | Input-shaped fallback passes through transforms/refinements |
| Nested object omitted | Inner defaults activate only when intended |
| Explicit `false` | Does not fall through |
| Explicit `0` | Does not fall through |
| Explicit empty string | Rejected or retained by documented schema policy |
| Invalid user value | Fails; does not silently become `.catch()` fallback |
| Recovery value | Labeled recovery in result/provenance |
| Composed object | Cross-field refinements still execute |

Test the exact schema used at runtime, not a similar leaf schema. If schema
composition uses `.shape`, `.pick()`, `.extend()`, or codecs, include a
regression test for every refinement or transformation that must survive.

## Optique grammar and source tests

Verify successful parses and grammar failures:

- canonical long option and short alias;
- hidden/deprecated compatibility alias;
- unknown option and nearest suggestion;
- required value and invalid scalar;
- repeated option policy;
- mutually exclusive structural branches;
- `negatableFlag()` absent, positive, negative, and conflict;
- enum `choice()` help, completion, and typo suggestions;
- help/version/completion before project config loading;
- `deferredValue()` specified branch, fallback branch, memoization policy, and
  fallback error;
- placeholder never appears in patch, provenance, or request.

For every source-bearing term, assert parser omission:

```ts
const patch = parseCli([]);
expect(Object.hasOwn(patch, "timeoutSeconds")).toBe(false);
```

Then test precedence through real adapters:

| CLI | Env | Config | Expected winner |
|---|---|---|---|
| absent | absent | absent | runtime default |
| absent | absent | present | config |
| absent | present | present | environment |
| present | present | present | CLI |
| explicit value equal to config | absent | same value | CLI, not config |

Do not infer precedence from wrapper nesting. Encode the intended result against
the installed Optique integration packages.

## c12 and defu tests

### Unit-test the application merger

Cover:

- public highest-to-lowest input order;
- internal lowest-to-highest pair evaluation;
- null and undefined layers skipped;
- ordinary objects merged by property;
- plain arrays replace;
- empty arrays clear;
- `$append`, `$prepend`, and `$replace` evaluate against inherited arrays;
- standalone operations lower to concrete arrays;
- duplicate behavior is explicit;
- higher plain array or replace defeats lower operations;
- schema-known discriminated unions replace atomically;
- unrelated same-named properties do not become atomic accidentally;
- inputs are not mutated;
- output arrays/objects do not retain mutable input references.

Table-driven example:

```ts
for (const testCase of mergeCases) {
	test(testCase.name, () => {
		const before = structuredClone(testCase.layers);
		const actual = mergeConfigInputs(...testCase.layers);
		expect(actual).toEqual(testCase.expected);
		expect(testCase.layers).toEqual(before);
	});
}
```

### Use real temporary c12 projects

Merger unit tests cannot prove loader behavior. Create temporary files that
exercise:

- default config discovery;
- explicit path and missing explicit path;
- supported JSON/JSONC/TypeScript formats;
- malformed or unsupported exports;
- base `extends` plus child overrides;
- base array plus child append/prepend/replace;
- selected and disabled environment branches;
- sync and async config factories;
- loader control keys consumed before strict application validation;
- environment-independent JSONC parsing, including `//` inside strings.

Prove one dynamic factory evaluation with an external side effect:

```ts
// The temporary config increments a marker file when evaluated.
const result = await runCliInFixture(projectDirectory, ["config", "show"]);
expect(result.code).toBe(0);
expect(await Deno.readTextFile(markerPath)).toBe("1");
```

Do not reset the marker between a hidden first load and handler load; that would
mask the bug. Handlers must receive the already loaded snapshot.

## Provenance tests

Test value and explanation together:

| Scenario | Value oracle | Provenance oracle |
|---|---|---|
| Config only | Config value | Config winner with file/source ID |
| Env over config | Env value | Env winner; config shadowed |
| CLI over env | CLI value | CLI winner; env and config shadowed |
| CLI equals config | Same value | CLI still explicit winner |
| Runtime default | Default value | `runtime-default`, no fabricated CLI source |
| Derived value | Derived value | Derived source, not runtime default |
| Append/prepend | Ordered array | Every contributing operation in order |
| Empty clear | Empty array | Explicit higher winner |
| Union switch | New branch only | Branch-level replacement and shadowed old branch |
| Recovery | Recovery value | `recovery`, not ordinary default |

Additional invariants:

- every decision path exists in the resolved config or is explicitly marked as
  a transformation/removal;
- no secret appears in human explain output, JSON output, LogTape records, or
  error causes;
- machine envelope has a schema version and parses with its published schema;
- human output is a rendering of the same decisions;
- aliases and `--name=value` forms retain explicit CLI evidence;
- inference is labeled when the parser integration cannot expose source
  identity directly.

Snapshot tests are useful for rendering, not for resolver correctness. Assert
winner, shadowed sources, operation, path, and redaction structurally.

## LogTape and stream tests

Use a recorder or in-memory sink for structured diagnostics, then subprocesses
for byte-level stream behavior.

Verify:

- diagnostic category and structured properties;
- level filtering and category inheritance;
- result category blocks inherited diagnostic sinks with
  `parentSinks: "override"` when supported by the installed version;
- JSON/JSONL/completion/man results reach stdout as exact raw bytes;
- warnings, debug records, and bootstrap failures never contaminate stdout;
- diagnostics reach stderr or the configured file;
- verified secret fields are redacted before formatting where that route's
  policy requires it;
- diagnostic identifiers, paths, URLs, causes, and other non-secret evidence
  that the policy is meant to preserve remain visible;
- stable result routes follow their own result schema/policy rather than
  inheriting diagnostic redaction automatically;
- quiet/silent semantics do not hide required machine results or failures;
- buffers flush on success, failure, and cancellation;
- sink and resource disposal occurs once.

Do not compare only visible strings. Assert raw byte sequences, trailing newline
policy, empty stderr/stdout where required, exit code, and generated file
contents.

Bootstrap tests must use logging controls available before full config is
valid. A malformed config should still honor raw `--log-level`, `--log-format`,
or equivalent early controls without attempting the failing full parse twice.

## Lifecycle and cancellation tests

Subprocess tests should cover:

- normal success and operational failure;
- invalid token grammar and invalid merged semantics;
- missing permissions or inaccessible files;
- closed stdin and redirected stdin;
- non-interactive prompt fallback or deterministic failure;
- first interrupt initiating graceful cancellation;
- second interrupt forcing termination when that contract exists;
- child process/worker/browser receiving cancellation;
- bounded cleanup and stable signal exit mapping;
- checkpoint/resume semantics where claimed;
- one public diagnostic per failure.

Use synchronization instead of fixed sleeps. Have the child emit a readiness
marker or create a file before the test sends a signal. Bound every wait so a
regression fails rather than hanging the suite.

## Generated and installed surfaces

Generate help, shell completion, man pages, and docs from the same static command
model. Tests should detect:

- a command present in source but missing from the standalone binary;
- visible versus hidden/deprecated aliases;
- choices or documented defaults missing from completion/help/man;
- stale generated output after grammar changes;
- missing compiled assets, workers, templates, certificates, or dynamic
  imports;
- version metadata disagreement.

Run the packaged/compiled artifact in a clean temporary consumer. Check:

1. `--version` and `--help` without project config.
2. Every top-level command is reachable.
3. One typical real command succeeds.
4. Invalid input has exact output and exit class.
5. Completion/man generation or installation works.
6. Required runtime assets exist.
7. Uninstall/cleanup behavior where distributed by an installer.

Run every operating system and architecture the release claims. If the matrix
was not run, narrow the claim in the handoff.

## Benchmark gates

Benchmarks run after semantic tests. Each fixture must pass its merge,
provenance, and output oracle before timing. Separate:

- installed cold startup;
- warm parser/resolver throughput;
- c12 discovery and factory evaluation;
- merge and provenance overhead by layer/field/depth count;
- Zod sparse and complete parsing;
- LogTape disabled, formatted, redacted, and flush paths.

Require the same runtime, lockfile, fixture, artifact type, and environment for
baseline and candidate. Report distributions and absolute changes. See
[benchmarking.md](benchmarking.md) for the full protocol.

## Evidence reporting

Separate facts by check and outcome:

| Status | Meaning |
|---|---|
| Passed | Command completed successfully; record command and exit status |
| Failed | Command completed and found a defect |
| Blocked | Environment/resource limitation prevented a result |
| Skipped | Intentionally not run; state why |
| Unverified | Claim inferred from source/docs only |

Do not report streamed output as a pass until the final process exit is known.
For resource-heavy Deno graphs, it can be reasonable to report focused checked
tests separately from `deno test --no-check` runtime evidence and from a broad
workspace check that OOMs or hangs. Do not turn that separation into a claim
that type-checking passed.

For Markdown skill changes, inspect the diff and fail if unrelated paragraphs,
tables, or code blocks were reformatted. Code formatters must exclude authored
Markdown unless the user explicitly asks for reformatting.

The final handoff should list:

- files or public behavior changed;
- exact commands run and exit status;
- focused behaviors proved;
- broad, platform, live-service, and benchmark checks not run;
- any observed pre-existing failure kept outside the change scope.
