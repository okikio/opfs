# Validation specialist

Use this reference to assess that changed code and documentation are internally correct, instruction-compliant, and free of known technical defects before anyone claims the capability is done.

Validation is not the same as end-to-end verification. Validation checks internal contracts such as schemas, types, invariants, generated output, tests, documentation rules, and packaging structure. Actual capability execution separately checks the real user workflow.

## Evidence order

When research is needed, prefer:

1. the current repository source and tests;
2. current repository instruction files and focused architecture docs;
3. an established repository research cache when it is current and traceable;
4. current primary upstream documentation and source for external contracts;
5. secondary sources only for context.

Do not let an older handoff silently override current repository behavior or a newer governing standard. Distinguish verified implementation from proposed design.

## Constraints

- A read-only validation request does not authorize implementation edits. An implementation request may include repairs followed by rerunning the affected checks.
- Do not convert blocked native checks into passes.
- Do not validate only the happy path when cancellation, cleanup, invalid data, concurrency, or persistence are part of the changed contract.
- Do not report a check as run if it was inferred from another check.
- Keep independent validation slices parallel when practical, but review concrete evidence rather than trusting a bare pass/fail summary.
- Do not introduce a second toolchain merely to validate code when the repository already selected an owner for that concern.

## Determine the changed contract

Inspect the diff and trace affected consumers. Define what must remain true. Depending on the task, this can include:

- schema acceptance/rejection rules;
- inferred public TypeScript types;
- API entrypoints and exports;
- cancellation and cleanup order;
- resource ownership;
- transaction visibility;
- parser state and chunk invariance;
- generated output freshness;
- configuration precedence;
- package contents;
- documentation terminology and examples;
- runtime support claims.

A type-only green check is not enough for code that owns I/O, persistent state, browser APIs, process lifetime, or streaming behavior.

## Run the narrowest meaningful checks first

Start with focused checks that fail quickly and localize defects. Examples:

```text
format check for changed files
lint for changed package
strict typecheck/public inference fixture
focused node:test suite
schema regression cases
parser conformance fixture
artifact-content comparison
Markdown link/fence validation
```

Then expand to affected repository gates. The final set should cover the whole changed contract without hiding the earliest useful failure under a large aggregate command.

## Schema and public type validation

When Zod owns a project data shape:

- the Zod constant ends in `Schema`;
- project-owned data types normally derive from the schema and end in `Type`;
- important field documentation lives on the schema when authoring/editor tooling should expose it;
- the TypeScript interface is not duplicated only to carry docs;
- `z.input` and `z.output` are used deliberately when transforms/defaults change the shape;
- public generic inference gets compile fixtures, including expected type errors when useful.

Use Standard Schema only where validator interoperability is actually the contract. Do not conflate Standard Schema with JSON Schema serialization.

## Lifecycle and resource validation

For code that acquires resources or starts work, trace:

```text
acquire -> active work -> cancel/complete -> cleanup -> terminal result
```

Check partial acquisition. If resource B fails after A opened, A must be released. Check whether cleanup failure preserves the primary operation failure. Check that cancellation is carried by the intended `AbortSignal` and that disposal remains explicit.

For observers/events, confirm they report state rather than becoming hidden cancellation authority or terminal-result storage.

## Parser, storage, and concurrency validation

Important internal implementation may hold the real contract. Inspect and test parser tables, regular expressions, retry rules, generation markers, leases, caches, queue limits, commit order, and cleanup paths when they control correctness.

For streaming parsers, split equivalent input at adversarial byte locations and prove chunk-invariant results. For storage publication, test crashes/aborts before and after the visibility commit point. For queues/concurrency, test cancellation of queued and active work separately.

## Documentation validation

Check more than Markdown syntax. Important docs should explain:

- what the capability owns;
- how it fits the larger flow;
- options and their concrete effects;
- cancellation/disposal/resource ownership;
- limits and memory behavior;
- failures and unsupported cases;
- examples that use the current public API;
- whether behavior is implemented or planned.

Important internal symbols deserve comments when their invariant is not obvious from the name and local code.

## Artifact validation

If the task returns a ZIP, tarball, generated package, or build output, validate the exact artifact. A robust ZIP check is:

1. build the ZIP from the cleaned working tree;
2. test archive integrity;
3. extract it into a clean directory;
4. compare file lists and per-file hashes;
5. rerun available validation against the extracted copy;
6. confirm excluded temporary/build files are absent.

The source working tree passing does not prove the handoff artifact is correct.

## Evidence handoff

Report scope, exact checks and results, concrete findings and unrun required checks.
Distinguish a check that failed from one that could not run. Internal validation
does not establish that an unrun user workflow works. Fit the response to the task;
this reference does not impose a separate role-specific output template.
