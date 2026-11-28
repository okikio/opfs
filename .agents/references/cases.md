# Delivery decision cases

Use these cases to choose the delivery mode before editing. Many poor software changes start because the agent correctly solves the local code problem while solving the wrong class of task.

## Complete replacement

Use a complete replacement when the requested end state makes the old implementation obsolete and compatibility was not requested.

Before editing, create two explicit inventories.

**Required end state** describes what must exist:

- public APIs and exports;
- runtime behavior;
- persisted shapes and migrations;
- CLI or application flows;
- tests and fixtures;
- documentation and examples;
- generated artifacts;
- package dependencies and configuration.

**Removal state** describes what must no longer participate:

- old implementations and files;
- obsolete exports and aliases;
- compatibility shims;
- stale flags and configuration;
- tests that only protect the old path;
- old generated output;
- old terminology in current docs;
- dependencies that no remaining consumer needs.

Trace the controlling entrypoint through every consumer. After migration, search symbols, paths, public names, config keys, persisted identifiers, and runtime registration. Passing tests does not prove that the obsolete path is unreachable.

## Behavior-preserving migration

Use this mode when ownership, structure, or dependency changes but externally observable behavior should remain stable.

Characterize the current behavior before editing:

- inputs and outputs;
- errors and error ordering;
- side effects;
- cancellation and cleanup;
- persistence and transaction behavior;
- concurrency and ordering;
- public types and inference;
- permissions and environment requirements;
- performance constraints where they are contract-relevant.

Keep intentional behavior changes in a separate list. If the migration reveals an old defect, do not silently fix it unless the task authorizes the behavior change or the defect prevents the migration. This makes review possible and keeps regressions attributable.

## Additive feature

Use this mode when the existing capability remains valid and a new path must coexist.

Map extension points and shared contracts first. Decide whether the new capability belongs in an existing package, a new concrete package, a generic `utils/` primitive, a declarative `registry/` definition, or executable composition. Do not create a generic abstraction only because two call sites look similar today.

Prove both the new path and the unaffected old path. Add failure tests for invalid input, cancellation, cleanup, unsupported runtime behavior, and partial acquisition where applicable.

## Bug fix

Start from a reproducible failure. Find the earliest state where actual behavior diverges from the expected contract. A downstream symptom is not automatically the correct fix location.

Add or strengthen a regression test that fails for the defect for the correct reason. Fix the owning implementation, then rerun adjacent lifecycle and consumer flows so the local fix does not create a broader state inconsistency.

For concurrency, cancellation, storage, parsing, or streaming defects, trace resource lifetime and state transitions rather than testing only the final output.

## Diagnose only

Use read-only inspection and reproducible checks. Do not repair the repository when the request is diagnosis, review, or explanation only.

A useful diagnosis records:

```text
observed symptom
earliest confirmed divergence
controlling implementation
reproduction command or fixture
supporting evidence
remaining uncertainty
complete correction strategy
```

If reproduction is blocked, say which runtime, credential, service, or fixture is missing. Do not turn a hypothesis into a confirmed root cause.

## Review only

A review reports findings without silently changing the repository. Trace public APIs through internal dependencies far enough to establish actual behavior. Prioritize lifecycle defects, resource leaks, cancellation defects, unsafe persistence, data loss, security problems, API divergence, and user-visible failures above stylistic preference.

Each finding should state the concrete behavior, why it matters, the conditions that trigger it, and how to prove a correction.

## Dirty worktree

Assume existing uncommitted work is intentional until inspection proves otherwise. Review status and relevant diffs before editing. Preserve unrelated changes. Do not run repository-wide formatting or generated refreshes that obscure the user's work.

If your requested change overlaps existing user edits, integrate only when the intent is clear. Otherwise return the best safe checkpoint and identify the exact overlapping files or symbols.

## Validation versus verification

**Validation** proves internal contracts. Examples include schema checks, type checks, lint, unit tests, invariant tests, generated-file checks, and package-content inspection.

**Verification** proves the real capability. Examples include running the CLI, opening the browser flow, executing the migration, installing the package from its artifact, starting the built application, or using the published service.

A task can be internally valid and still fail verification because wiring, packaging, permissions, environment setup, generated files, or runtime behavior differ from the test harness.

## Connected systems

Expand inspection whenever an adjacent system controls correctness. Examples include:

- a browser API that determines lifecycle or storage availability;
- a framework compiler that rewrites source behavior;
- a database or queue whose transaction semantics affect the design;
- an external package whose current API controls type/runtime behavior;
- a deployment platform that changes file layout, environment, or concurrency;
- a downstream package whose public types expose the changed API.

Use current primary sources for version-sensitive external contracts. Keep implemented repository behavior distinct from aspirational docs and proposed architecture.

## Authorized external mutations

Treat these as separate authorization scopes:

```text
inspect / explain
review
diagnose
plan
edit local files
run local validation
commit
push
open or modify a pull request
publish package
deploy
send message
mutate external service state
```

Authorization for an earlier line does not imply authorization for a later line.

## Reference loading

Open a reference to answer a concrete decision. Do not load every reference into every task. Browser UI work starts with web semantics and then loads the renderer-specific material selected by actual imports/configuration. Release prose does not govern commit prose. Benchmark guidance does not replace correctness testing. Specialized references add detail to the shared delivery contract; they do not override the current repository or task requirements.
