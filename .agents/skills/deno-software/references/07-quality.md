# Deno quality, testing, CI, and benchmarks

Use this reference to design or verify the repository's quality gates. The goal
is not to maximize command count. Each gate must prove a distinct contract.

## Example shared test convention

Where the repository has selected this shared convention:

- test runner: `node:test`;
- expectations: `@std/expect`;
- same TypeScript tests executed under Deno and Node where portable;
- Playwright for real browser APIs and contexts;
- Mitata for selected cross-runtime performance benchmarks;
- Mise as task/tool-version authority when the repository selected it.

Do not migrate an established repository solely to match this default. Inspect
its actual task authority.

## Quality layers

### Formatting

Format only the files the functional change intentionally owns. Keep
repository-wide formatting/import sorting/mechanical churn separate from
behavioral changes.

### Linting

Run the selected linter(s) on the changed surface or repository-required scope.
If Oxc is the selected owner, use its real current configuration rather than
introducing a second linter for one rule without a documented gap.

### Type checking

Use the Deno/project check path and separate environment targets when runtime
globals differ. Public generic inference is part of the API: use compile fixtures
for expected inference and expected type errors where relevant.

### Unit and contract tests

Tests should state the behavior contract they protect. Include invalid inputs,
falsy/default semantics, cancellation/lifecycle, concurrency, resource cleanup,
and non-happy paths rather than mirroring implementation lines.

### Integration tests

Use real temp directories/databases/providers/servers as appropriate. Test the
public entrypoint and connected resource contract, not only mocks.

### Runtime matrix

Run actual claimed runtimes:

```text
Deno
Node
Bun
browser(s)/workers
```

Only when the package claims them. A Node-hosted TypeScript compile with Deno
ambient declarations is not Deno runtime proof.

### Browser tests

Use Playwright for Window/worker/iframe/service-worker behavior where browser
APIs are material. Probe capabilities rather than hard-code browser-brand
assumptions. Preserve fresh versus persistent-context tests when persistence is
part of the contract.

### Benchmarks

Mitata is preferred where selected. A useful benchmark records:

- exact workload and fixture;
- correctness oracle;
- baseline and candidate versions;
- warm/cold distinction;
- throughput/latency distribution;
- memory or resource counts when relevant;
- cleanup/cancellation/startup cost if part of the workload;
- enough repetitions/environment detail to interpret variance.

Do not promote a microbenchmark improvement that regresses the real workflow.

## Deno test runner features

Deno 2.9 includes newer test-runner capabilities such as snapshot and
parameterized testing. Use version-specific features only when the repository's
minimum Deno version supports them. The project's normal cross-runtime tests can
still use `node:test` when portability is part of the contract.

## CI parity

CI should invoke the same repository task authority developers use. Avoid a CI
script that reimplements task logic inline and drifts from Mise/deno tasks.

Pin or record:

- Deno/tool versions;
- dependency/lockfile policy;
- required services/containers/browsers;
- permissions;
- caches and cache keys;
- generated-output checks;
- package/publish dry-runs.

## Affected versus full validation

Use a progression:

1. narrow changed-file/unit check after the first substantive edit;
2. affected package/type/test gate;
3. integration/runtime check;
4. full repository gate when required before delivery;
5. artifact extraction/clean-consumer revalidation when shipping a ZIP/package.

Do not stop at the first green command if later gates cover different behavior.

## Coverage

Coverage is a diagnostic. Do not optimize statement percentage while lifecycle,
error, concurrency, or runtime paths remain untested. Prefer tests around
contracts and known risk.

## Documentation validation

Check Markdown links/fences, generated docs drift, examples/imports, and public
API references. Documentation is part of the implementation when it tells users
how to operate the changed capability.

## Failure signatures

| Symptom | Problem |
|---|---|
| types pass, runtime import fails | environment/runtime not executed |
| Deno test passes only with global ambient mix | target separation missing |
| browser code tested in Node mocks only | actual API/context unverified |
| benchmark faster but output wrong | no correctness oracle |
| CI and local tasks differ | duplicated task authority |
| huge unrelated fmt diff | functional/mechanical work mixed |
| package tree passes but ZIP fails after extraction | deliverable not revalidated |

## Completion evidence

Report each gate with exact command/result. If Deno/Bun/browser/provider tooling
is unavailable, mark that lane blocked and state the command/environment needed.
Never report a blocked native runtime as passed because a shimmed typecheck
succeeded.
