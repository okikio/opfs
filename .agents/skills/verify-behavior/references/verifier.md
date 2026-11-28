# Verification specialist

Use this reference to verify that a runnable deliverable works for the user or operator. Verification is evidence from the real capability, not a synonym for a green test suite.

## Purpose

Tests, type checks, and builds answer important internal questions. Verification answers a different question:

> Can the intended consumer run the actual deliverable and observe the required behavior?

Examples include a CLI invocation, browser flow, clean package consumer, migration, generated archive, built binary, extension package, service endpoint, or deployed application.

## Constraints

- A read-only verification request does not authorize edits. Authorized implementation can include a repair and subsequent re-verification.
- Do not stop at tests, benchmarks, type checks, or a build when the real deliverable can be run.
- Never return `verified` for an unrun capability.
- Return `blocked` when the required capability cannot be exercised in the current environment.
- Return `failed` when the capability ran and the observed behavior violated the contract.
- Separate independent verification scenarios when they can run concurrently, but require concrete evidence from each result.
- Do not infer success for another runtime, browser, architecture, registry, or deployment environment from a nearby runtime.

## Establish the verification target

Name the exact workflow before running anything. Avoid vague targets such as “the package works.” Prefer:

```text
install the generated package tarball in a clean Deno consumer and call the public parser API
run `tool inspect fixture.json` and verify exit status, stdout JSON, and generated file
open the built extension in Chromium and verify the side-panel scan flow
apply migration 12 to a seeded database, restart the service, and read the migrated record
```

Identify required inputs, credentials, browser/runtime versions, feature flags, permissions, and external services. Record whether each resource is available.

## Verify the artifact the consumer receives

When the task produces an artifact, verify that artifact rather than the source workspace.

A strong artifact flow is:

```text
working tree
   |
   v
build/package
   |
   v
inspect artifact contents
   |
   v
extract/install in clean location
   |
   v
run consumer workflow
```

For a ZIP handoff, extract the exact delivered ZIP. For a package, install the generated tarball. For a binary, execute the generated binary. For a container, run the built image. For generated code, import the generated output from the same public path a consumer will use.

## Observe all relevant behavior

A successful process exit is necessary but may not be sufficient. Capture the evidence the contract requires:

- exit code or terminal result;
- stdout/stderr or structured result;
- produced files and their contents;
- network/service response;
- database/storage state;
- cleanup and resource release;
- cancellation behavior;
- browser-visible state;
- public type behavior for clean consumers;
- artifact hashes or manifest contents when identity matters.

For destructive or stateful workflows, verify both the intended change and the absence of forbidden residue.

## Use supporting checks correctly

Internal checks are supporting evidence, not replacements for runnable verification. A useful ordering is:

1. inspect the target and prerequisites;
2. run the actual workflow;
3. inspect its output/state;
4. use focused tests, logs, or diagnostics to explain or strengthen the result;
5. compare observed behavior with the requested contract.

If the real workflow fails, do not hide it because unit tests pass. If the real workflow cannot run, do not substitute a mock and return `verified`.

## Mixed scenarios

A capability can have multiple independent scenarios. For example, a storage package may claim Window, Worker, Node, Deno, and Bun support.

Report each scenario separately:

| Scenario | Result | Evidence |
| --- | --- | --- |
| Node | verified | exact command and observed output |
| Deno | blocked | executable unavailable |
| Chromium Worker | verified | browser test and observed state |
| WebKit | failed | exact runtime failure |

The overall result cannot be `verified` when a required scenario is failed or blocked.

## Evidence handoff

State the exact capability, preconditions, actual steps, observed behavior and
remaining gaps. Keep scenario results separate: a nearby runtime cannot prove an
unrun one. Do not return verified for a required workflow that failed or could
not run. Fit the handoff to the user’s task rather than a fixed role template.
