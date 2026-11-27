# Refactors and migrations

Use this reference for structural replacement, ownership changes, dependency migrations, persisted-data migrations, package reorganization, API cutovers, and requests whose success requires an old path to stop being authoritative.

A refactor is not complete because a cleaner abstraction was added. Completion means the controlling runtime path, consumers, tests, documentation, configuration, generated output, and obsolete code all agree on the new design.

## Establish the current controlling path

Trace the current public entrypoint through registration, configuration, dispatch, persistence, and downstream consumers. Search symbols and runtime identifiers, not only filenames.

Include:

- package exports and public subpaths;
- importers and re-exporters;
- dependency injection/resource construction;
- framework auto-discovery and generated registries;
- CLI/app composition;
- persistence schemas and migrations;
- feature flags and environment variables;
- generated code and source generators;
- tests, fixtures, examples, docs, and benchmarks;
- CI, build, packaging, and deployment configuration;
- file/folder names when discovery or public imports depend on them.

Draw the actual dependency direction before proposing a replacement. An implementation may differ from architecture docs. Treat tested behavior as implementation evidence and label unimplemented design material as proposed.

## Define the target and removal inventories

Write two inventories before editing.

### Required end state

List the capabilities, public contracts, supported runtimes, persisted shapes, user flows, ownership rules, failure behavior, and downstream consumers that must exist afterward.

### Removal state

List every old element that should disappear:

- old files/classes/functions;
- old exports and namespace members;
- aliases and compatibility shims;
- obsolete config/env keys;
- old schema fields and persisted data when migration is required;
- tests and fixtures for unsupported behavior;
- generated outputs;
- dependencies;
- current documentation and examples using the old concept;
- old runtime registration/discovery entries.

The removal inventory prevents the common failure where the new implementation exists but the product still routes through the old one.

## Characterize behavior before structural changes

Record observable behavior that must remain stable:

```text
inputs and accepted shapes
outputs and public types
error categories and timing
side effects
resource ownership
cancellation and disposal
ordering and concurrency
persistence and transaction semantics
permissions
time/memory/throughput constraints
```

Add characterization tests where the behavior is important but under-specified. Do not encode accidental implementation details unless consumers depend on them.

List intentional behavior changes separately. A structural change should not smuggle in product changes, new compatibility behavior, or new defaults without review.

## Choose the cutover model

Use **atomic replacement** when all current consumers can migrate together. This is the normal choice when compatibility was not requested.

Use **expand, migrate, verify, contract** for persisted data or distributed systems that cannot change in one step:

```text
expand schema/capability
migrate producers and consumers
verify mixed-state operation
migrate durable data
verify final state
remove old shape/path
```

Use an explicit **compatibility window** only when the requirement needs it. Give it an owner, deadline/removal condition, tests, telemetry if useful, and documented cost. Compatibility is not a free default.

## Preserve ownership and lifecycle semantics

Structural refactors often fail in lifecycle behavior even when return values match. Trace:

- who acquires each resource;
- whether the caller or callee owns disposal;
- how partial acquisition is unwound;
- which `AbortSignal` cancels active work;
- whether terminal state can be overwritten by a late completion;
- whether cleanup failure can erase the primary operation failure;
- whether a worker/process/connection remains alive after the new owner exits.

When moving a capability between packages, move the complete lifecycle contract, not only the function body.

## Migrate consumers completely

Change the controlling path first or in a deliberate staged order, then update every consumer. Update public exports, import paths, config, schemas, persisted data, tests, fixtures, docs, examples, benchmark harnesses, generated output, and package dependencies.

For generated files, change the generator rather than hand-editing output unless the repository explicitly treats the generated file as authored source.

For namespace APIs, update current call sites to the final compact operation names rather than preserving obsolete aliases by default.

## Remove obsolete code and prove removal

Search the repository after migration for:

- old symbols and filenames;
- old import specifiers;
- old JSON/config/env keys;
- old public terminology;
- old registration IDs;
- stale tests and fixtures;
- dependencies used only by the removed path.

Then trace the runtime again. “No text match” is useful evidence but does not prove the old implementation is unreachable if dynamic registration or generated code remains.

## Verify the final state

Run:

1. focused tests for the new/changed contract;
2. lifecycle and failure-path tests;
3. affected repository-wide gates;
4. actual user-facing verification;
5. clean-consumer or clean-environment verification for public API/package changes;
6. migration verification for persisted data;
7. artifact inspection for packaging/export changes.

Compare the result against both inventories. Report any intentionally retained compatibility residue as part of the final contract, not as hidden cleanup debt.

## Common failure patterns

- New implementation added, old dispatcher still authoritative.
- Public export changed, downstream package still imports an internal path.
- Schema changed, persisted rows or fixtures not migrated.
- Lifecycle owner moved, cleanup stayed with the old module.
- Alias kept “temporarily” with no removal condition.
- Generated registry still points at the old file.
- Benchmark compares the new path with a different workload.
- Repository-wide formatter noise hides the functional migration.
- Tests pass because they target the new module directly while the application still uses the old path.
