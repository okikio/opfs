# CLI benchmarking protocol

Benchmark only after behavioral tests pass. A faster resolver that changes
precedence, provenance, redaction, output bytes, or cancellation is a defect.

## Contents

1. [Questions worth measuring](#questions-worth-measuring)
2. [Workload model](#workload-model)
3. [Startup and steady state](#startup-and-steady-state)
4. [Mitata harnesses](#mitata-harnesses)
5. [Merge and provenance fixtures](#merge-and-provenance-fixtures)
6. [Logging benchmarks](#logging-benchmarks)
7. [End-to-end artifact benchmarks](#end-to-end-artifact-benchmarks)
8. [Controls and statistics](#controls-and-statistics)
9. [Regression policy](#regression-policy)
10. [Benchmark report](#benchmark-report)

## Questions worth measuring

Measure an operation to answer a product question:

| Operation | Question |
|---|---|
| Optique grammar | Does command count or choice vocabulary make parse/help slow? |
| Source binding | What does env/config/derived binding add to an ordinary invocation? |
| c12 | What is discovery and TypeScript config evaluation latency? |
| defu-backed merger | How does layer count, depth, and array policy scale? |
| Zod | What do sparse validation, complete parsing, transforms, and refinements cost? |
| Provenance | What latency and allocation overhead does explanation add? |
| LogTape | What is disabled-log, pretty, JSON, redaction, and flush cost? |
| Executable | What do users experience for `--help`, success, and invalid input? |

Do not collapse these into one microbenchmark and call it “CLI performance.”
Startup-heavy CLIs and long-running commands have different budgets.

## Workload model

Create named fixtures from observed usage rather than random objects:

| Fixture | Suggested shape |
|---|---|
| `tiny` | 1 command, 1 layer, 10 scalar fields |
| `typical` | 12 commands, 4 layers, 60 fields, 3 arrays, 2 nested objects |
| `large` | 60 commands, 8 layers, 500 fields, deep nesting, 20 array operations |
| `adversarial` | Maximum supported depth/size, branch replacements, empty arrays, secrets |

For each fixture, record:

- command and option count;
- source layer count and precedence;
- scalar, object, array, and union-path counts;
- append/prepend/replace operation counts;
- Zod transforms and refinements;
- provenance enabled or disabled;
- logging level, formatter, sink, and redaction state.

Keep fixtures deterministic and committed. A benchmark that regenerates
different data on every run cannot diagnose a regression.

## Startup and steady state

Separate these measurements:

1. **Process startup:** spawn the installed/compiled entrypoint once per sample.
2. **Cold application path:** import modules, build grammar, discover config,
   initialize logging, and execute once in a fresh process.
3. **Warm parse/resolution:** reuse constructed schemas and parser terms in one
   process.
4. **Long-running throughput:** repeat only the operation relevant to a daemon,
   watcher, or batch command.

Never report a warm in-process parse as command startup. Never include fixture
generation or filesystem cleanup inside a merge-only timing.

## Mitata harnesses

Prefer mitata for Deno benchmarks when the repository has not standardized on
another runner. Construct fixtures outside the timed callback.

```ts
import { bench, group, run } from "mitata";
import { CliPatchSchema, RuntimeConfigSchema } from "#/config/schema.ts";
import { mergeConfigInputs } from "#/config/merge.ts";
import { typicalLayers } from "./fixtures/config-layers.ts";

group("config resolution: typical", () => {
	bench("merge only", () => {
		mergeConfigInputs(...typicalLayers);
	});

	bench("merge + complete Zod parse", () => {
		RuntimeConfigSchema.parse(mergeConfigInputs(...typicalLayers));
	});

	bench("sparse Zod parse, one CLI patch", () => {
		CliPatchSchema.parse(typicalLayers[0]);
	});
});

await run();
```

Compare provenance with the same algorithm and fixture:

```ts
group("provenance overhead: typical", () => {
	bench("value only", () => resolveConfig(typicalSources, {
		provenance: false,
	}));

	bench("value + decisions", () => resolveConfig(typicalSources, {
		provenance: true,
	}));
});
```

If the production resolver always records provenance, do not create a fake
value-only production mode solely to win a benchmark. A test-only comparator is
acceptable when clearly labeled.

## Merge and provenance fixtures

Benchmark the algorithmic dimensions independently:

```text
layers:       1, 2, 4, 8, 16
object depth: 1, 4, 8, supported maximum
field count:  10, 100, 1_000
arrays:       replace, empty clear, append, prepend, replace operation
unions:       no switch, repeated atomic branch switch
provenance:   off/comparator, decisions only, decisions + redacted values
```

Every benchmark fixture must first pass the same semantic oracle used by unit
tests. Before timing, assert:

- public highest-to-lowest precedence resolves correctly;
- internal lowest-to-highest operation evaluation is correct;
- `false`, `0`, empty string, and empty arrays retain their intended meaning;
- inputs are not mutated and resolved arrays are copied;
- atomic union branches do not hybridize;
- provenance winner, shadowed values, and operation order are correct.

Watch for accidental quadratic behavior in repeated object cloning, path-string
construction, flattening, and shadowed-contribution arrays. Profile before
replacing clear code with mutation or custom data structures.

## Logging benchmarks

Measure LogTape configurations separately:

| Case | Why |
|---|---|
| Below-threshold diagnostic | Hot-path cost when log is disabled |
| Structured record to null/recorder sink | Dispatch and filtering cost |
| Pretty stderr formatter | Human path |
| JSON formatter | Automation/collection path |
| Nested redaction | Security overhead on representative objects |
| Raw result sink | Exact stdout route without diagnostic formatting |
| Flush/dispose | Short-command shutdown cost |

Do not benchmark real terminal rendering in a tight loop and interpret it as
formatter speed. Use an in-memory sink for formatter comparison; use subprocess
latency separately for actual stderr behavior.

Never remove structured redaction because an unrepresentative benchmark says it
is expensive. First reduce logged object size, avoid logging full config trees,
or move verbose diagnostics behind an explicit level.

## End-to-end artifact benchmarks

Use the artifact users execute:

```ts
Deno.bench("installed --help startup", async () => {
	const command = new Deno.Command(installedExecutable, {
		args: ["--help"],
		stdin: "null",
		stdout: "null",
		stderr: "null",
	});
	const output = await command.output();
	if (!output.success) throw new Error("--help failed");
});
```

Process-spawn benchmarks are noisy. Use enough samples, run them separately from
microbenchmarks, and report the operating system, architecture, runtime,
artifact type, and power state. Include at least:

- `--version` or `--help` fast path with no project config requirement;
- invalid token path;
- typical successful command with config discovery;
- machine-output path;
- one config factory path if factories are supported.

Use an isolated temporary project and deterministic local files. Network access
belongs in a separately labeled integration benchmark, never the default suite.

## Controls and statistics

Before comparing commits:

- use the same Deno version, lockfile, permissions, machine, and power profile;
- close competing CPU-heavy work and record thermal throttling risk;
- pin deterministic fixture content and temporary-directory layout;
- warm caches only for warm cases; create fresh processes for cold cases;
- keep stdout/stderr away from an interactive terminal unless testing it;
- validate output and exit status outside or before the timed region;
- compare distributions, not one fastest sample;
- retain runner output as an artifact.

Use median and a tail percentile for process startup. For stable
microbenchmarks, report the runner’s estimate and variability. A result inside
normal run-to-run noise is inconclusive.

## Regression policy

Define budgets from user impact and baseline variance. Example policy:

| Metric | Review trigger | Failure trigger |
|---|---:|---:|
| Typical warm resolution | >10% with stable confidence | >20% |
| Installed `--help` median | >10% and >10 ms | Product-specific budget exceeded |
| Installed `--help` p95 | >15% | Product-specific budget exceeded |
| Typical peak memory | >15% | Supported-environment budget exceeded |
| Provenance overhead | Explain any material change | Explicit product budget exceeded |

These are example thresholds, not universal standards. Calibrate them with at
least several baseline runs. Require both a relative and meaningful absolute
change for noisy, short operations.

Do not accept a performance change that breaks a semantic oracle. If a change
trades memory for latency or startup for steady state, state both effects and
which command population benefits.

## Benchmark report

Record enough context to reproduce the claim:

```ts
import * as z from "zod";

export const BenchmarkRecordSchema = z.object({
	schemaVersion: z.literal(1),
	commit: z.string().min(7),
	runtime: z.string(),
	platform: z.string(),
	architecture: z.string(),
	artifact: z.enum(["source", "installed", "compiled"]),
	fixture: z.string(),
	metric: z.string(),
	medianMs: z.number().nonnegative(),
	p95Ms: z.number().nonnegative().optional(),
	samples: z.number().int().positive(),
	notes: z.array(z.string()).default([]),
});
```

The handoff should state:

1. Which semantic tests passed before benchmarking.
2. Exact benchmark command and fixture.
3. Baseline and candidate revisions.
4. Median, variability/tail, and sample count.
5. Absolute and relative change.
6. Whether the result is conclusive.
7. Any unmeasured claim, such as Windows startup or network behavior.

See [testing.md](../../../references/testing.md) for correctness gates and
[defaults-provenance.md](defaults-provenance.md) for the resolution invariants
that benchmarks must preserve.
