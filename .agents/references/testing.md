# Testing rules

## Canonical tools

For Deno-first TypeScript libraries, default to the same source tests across runtimes:

```ts
import { describe, it } from "node:test";
import { expect } from "@std/expect";
import * as fc from "fast-check";
```

Use:

- `node:test` for `describe`, `it`, lifecycle hooks, and the normal test runner contract;
- `@std/expect` for Jest-style expectations;
- `fast-check` for high-value properties and adversarial generated inputs;
- Playwright Test for real browser capabilities and browser lifecycle behavior;
- Mitata for benchmarks.

Preserve a repository's established runner when the project deliberately uses another one, such as Vitest for a frontend application. Do not create duplicate test implementations just to satisfy Deno and Node.

Runtime-specific tests are appropriate when they prove a capability that cannot exist in the other runtime, such as OPFS, WebCodecs, a Node filesystem adapter, or a Bun-specific API.

## Apply the convention to its actual role

Namespace imports are useful for coherent runtime operation families, not a
blanket import style. Keep direct imports for test runners/assertions, schemas,
and types when they communicate the role. Document non-obvious test helpers and
invariants; trivial private fixtures do not require public API TSDoc. A runtime
schema owns validated serialized data, not every ephemeral object or live handle.
Preserve an explicit repository requirement and explain any material conflict.

## Test the contract, not the current line structure

A test should state which contract or regression it protects.

Before adding or moving a test, identify the failure it would catch, the
selected runner, the real fixture it needs, and why an existing test cannot
already cover it. Choose the smallest set of tests that exercises the changed
risk. The lifecycle list below is a set of scenarios to *consider*, not a
requirement to run every scenario on every PR.

Prefer tests near their owning package or capability. Do not create mirrored
`tests/unit/src/` trees, duplicate cross-runtime suites, or custom service
supervisors merely to match a reference layout. Use separate browser or
integration tests when the runtime or resource is itself part of the contract.
An assertion can be imported under an alias or executed by a helper; trace the
call before reporting a missing assertion from source text alone.

Prefer public behavior over private implementation state. Internal unit tests are appropriate for a complex parser, planner, state machine, or algorithm when that internal operation is itself a stable reasoning unit, but do not mirror private lines merely to increase coverage.

Tests are executable documentation. Keep the setup visible when it explains the scenario.

Tests must be deterministic and independent unless the test deliberately models shared state. Avoid order dependence, ambient wall-clock dependence, and shared mutable fixtures. Use a direct Arrange -> Act -> Assert story when it makes the protected contract easier to read. Do not over-abstract setup merely to remove repeated lines.

Public type inference is also part of the API. For schema-derived config helpers, generic APIs, overloads, discriminated unions, and adapter factories, compile small consumer fixtures that must succeed and fixtures that must fail. Check the inferred call-site surface directly instead of assuming implementation type checks prove caller ergonomics.

## Cover the lifecycle, not only the happy path

For a non-trivial capability, inspect and test the relevant layers:

- valid common path;
- invalid schema or malformed input;
- empty and minimum-size inputs;
- maximum configured limits and one step beyond;
- cancellation before start and during active work;
- cleanup after success, failure, and cancellation;
- close/abort or commit/rollback exclusivity;
- retries and exhausted retry policy;
- concurrency and stale/out-of-order completion;
- bounded memory and producer cancellation;
- partial reads/writes and range behavior;
- resource ownership and explicit disposal;
- real runtime behavior where the capability depends on runtime APIs.

Do not assume a type check proves I/O, streaming, browser storage, process signals, media behavior, or provider semantics.

## Diagnose a test process that will not finish

Find the live resource and its creation owner: a listener, pool, worker, timer,
subscription or unjoined task. Register cleanup immediately after acquisition,
make it run after setup/body failure, and await shutdown. Rerun the isolated
scenario and its affected checked lane. Use runner diagnostics available in the
installed version; Node-only handle diagnostics are optional and do not replace
Deno sanitizers. Do not hide ownership with process.exit, arbitrary sleeps or
forced shutdown. A finite timeout makes failure observable; it does not fix it.

## Property-based tests

Use `fast-check` for invariants where many equivalent inputs or operation sequences can reveal defects.

High-value properties include:

- parser chunk invariance;
- round-trip stability;
- canonicalization idempotence;
- no virtual-root escape after path normalization;
- schema acceptance/rejection stability;
- equivalence between optimized and reference implementations;
- state-machine legality under generated operation sequences;
- source preservation when an editor changes an unrelated field;
- no stale completion replacing a terminal canceled/failed state.

A property needs an independent oracle or invariant. Do not generate the expected result by calling the same logic under test.

## Browser tests

Use Playwright for actual browser APIs instead of reproducing browser policy in Node.

Probe capabilities rather than hard-code browser brand assumptions. Test fresh and persistent contexts when persistence matters. Use real workers, iframes, service workers, user activation, storage, media, or permission flows where those are part of the contract.

Keep portable algorithms in `node:test`; do not move path math, record adapters, or pure planners into Playwright merely because the final application runs in a browser.

## Benchmarks

Benchmarks answer performance questions; tests answer correctness questions. Keep them separate.

Use Mitata with representative inputs. Measure the physical work that matters, such as throughput, latency, allocations, heap growth, requests, writes, process count, or cancellation latency. Compare against a baseline or alternative when the result is meant to justify an optimization.

Do not tune implementation on a tiny benchmark that does not resemble the production access pattern.

## Cross-runtime validation

When a package claims Deno, Node, Bun, browser, or worker support, use separate type/runtime views so one environment cannot accidentally provide globals for another.

The normal goal is:

```text
same deterministic TypeScript source
        |
        +-- Deno runtime tests
        +-- Node runtime tests
        +-- Bun runtime tests
        `-- browser tests where Web APIs require a browser
```

If the current host lacks a runtime, record that check as blocked. Do not replace production imports with host-specific shims merely to make an agent environment green. Keep disposable host adaptations in the repository-approved ignored investigation workspace, outside normal test discovery and shipped artifacts. Installed `.agents/` guidance is maintained source, not scratch storage. Keep durable tests in their normal owning package or test tree.

## Artifact tests

For a release or ZIP deliverable, rerun the relevant validation against the exact extracted artifact.

At minimum:

1. build or create the deliverable;
2. extract it into a clean directory;
3. compare expected source/package file lists;
4. recreate only validation-side host setup when needed;
5. rerun the applicable type, test, build, and package checks;
6. inspect generated ESM/declarations/manifests or other produced output;
7. compute and report a hash when practical.

A source tree passing while the delivered archive fails is a failed delivery.

## Anti-patterns

- tests that only execute code without meaningful assertions;
- generated expected values that reproduce the implementation;
- giant snapshots for contracts better expressed structurally;
- timing-sensitive sleeps when an explicit signal/state transition can be awaited;
- hiding the scenario behind generic test helpers;
- marking browser or Bun behavior passed from type checking alone;
- using a compatibility shim as the only proof that the intended runtime works.
