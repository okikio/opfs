# Deno verification matrix

Use this reference for the final technical proof of a Deno change. Verification
is claim-driven: run the commands that prove the behavior you will report.

## Baseline

Before editing, record the relevant baseline when practical:

- current tests/checks;
- failing reproduction;
- package/build output;
- benchmark numbers;
- runtime behavior;
- dirty files/user changes.

This distinguishes pre-existing failures from regressions.

## Suggested progression

### 1. Changed-surface check

After the first substantive edit, run the narrowest useful command: focused test,
type check, formatter check, or executable reproduction.

### 2. Package/affected graph

Run the owning package tests/checks and any direct consumer that exercises the
changed public contract.

### 3. Native runtime lanes

Execute each runtime the claim requires:

- Deno;
- Node;
- Bun;
- browser Window/worker/etc.;
- deployment/provider integration.

Do not count a validation shim or foreign runtime compile as native execution.

### 4. Repository gates

Use the actual repository authority, which can be Deno tasks, Mise, package
scripts, or a composition. Typical classes:

```text
format check
lint
type check
unit/integration tests
browser tests
benchmarks
build/package
publish dry-run
generated-output drift
```

### 5. Real capability

Run the actual CLI/server/library consumer/migration/generator/user flow when the
environment permits. Static validation supports this proof but does not replace it.

### 6. Artifact verification

For a ZIP/package/build output:

- inspect contents;
- extract/install in clean location;
- recreate validation-only dependencies only if explicitly outside the artifact;
- rerun the same available gates;
- compare file lists/hashes where required.

## Cross-runtime libraries

Verify separately:

1. import safety;
2. TypeScript environment targets;
3. behavioral tests under each runtime;
4. runtime-specific adapter subpaths;
5. package exports/conditions;
6. clean consumers;
7. browser capability probes rather than browser-name assumptions.

## Cancellation/resource verification

When resources are affected, test:

- success cleanup;
- expected failure cleanup;
- partial initialization failure;
- abort before start;
- abort during I/O;
- disposal after completion;
- borrowed resource remains open;
- transferred/owned resource closes;
- cleanup failure retains primary cause.

## Generated/public type verification

For libraries/config builders, add compile fixtures for expected contextual
typing, inference, and expected errors. A generated `.d.ts` file existing is not
proof the intended call site infers correctly.

## Benchmark verification

Performance claims require:

- named workload/fixture;
- semantic correctness oracle;
- baseline/candidate versions;
- environment;
- warm/cold distinction where material;
- absolute and relative change;
- variability;
- memory/resource/lifecycle metrics when they are part of the cost.

## Clean-room validation

A clean-room check catches:

- workspace-only imports;
- undeclared dependencies;
- stale generated files;
- missing package assets;
- global tools/caches;
- environment variables inherited from development;
- artifact inclusion mistakes.

Use a fresh temp directory/container/consumer as appropriate.

## Failure reporting

Classify a gate as:

- passed;
- failed because of the change;
- pre-existing failure;
- environment-blocked;
- not applicable.

Do not convert “Deno executable not installed” into “passed under Node.” Report
the exact unrun native command.

## Completion checklist

Before saying done, confirm:

- requested behavior exists;
- obsolete replacement path is removed where required;
- current consumers/exports/docs/tests are updated;
- formatting/lint/type/tests passed at required scopes;
- real capability ran where possible;
- claimed runtimes executed;
- package/build output inspected;
- exact delivered artifact revalidated;
- no unrelated formatting/generated churn remains;
- remaining blocked gates are explicit.

Completion is an evidence statement, not an estimate of how likely the code is
to work.
