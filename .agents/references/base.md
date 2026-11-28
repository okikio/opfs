# Shared engineering defaults

## Contents

- What this file is for
- Source and authority order
- Review before change
- Architecture and ownership
- Naming and API shape
- Data contracts and schemas
- JavaScript and TypeScript defaults
- Writing and explanation style
- Comments, docs, and TSDoc
- Logging and observability
- Performance and limits
- Validation and completion

## What this file is for

This file is the cross-project engineering baseline. More specific repository instructions, package guides, and task requirements may narrow it.

For the current compact cross-project rule set, also apply `standards.md`. This file expands the engineering rationale and review workflow; `standards.md` is the concise recurring-rule reference.

Use this file for:

- architecture and ownership defaults;
- naming and API design;
- schema and type conventions;
- documentation and comment quality;
- testing and verification expectations;
- lifecycle, performance, and delivery discipline.

## Source and authority order

Do not assume an older example is still the desired design only because it exists in a handoff or codebase.

Use this order when sources disagree:

1. the current explicit user requirement;
2. the latest repository instructions and verified current implementation;
3. the current cross-project engineering standard;
4. focused architecture or package documentation;
5. older handoffs, examples, and experiments.

The implementation is still the source of truth for what the software currently does. A newer design document can describe the intended replacement, but it does not make unimplemented behavior real.

When the user supplies a newer archive, branch, document, or test result, verify that it is the intended current source before editing. Compare it with earlier material instead of silently merging assumptions from both.

## Readability and ownership

Make every result clear enough for the user to understand, maintain, and share
with someone who has not read the chat. Essential understanding must not depend
on the author, an AI assistant, or missing conversation history. Apply this to
explanations, research, plans, progress updates, code, names, comments, tests,
interfaces, errors, documentation, commits, PRs, releases, and handoffs,
including delegated work when delegation is authorized.

Before starting, identify the intended reader, their task, the source of truth,
and the context needed to follow the work. Include an understandable explanation
and usable handoff in substantial acceptance criteria.

For work spanning a product or several components, explain three connected
views: the customer outcome and why it matters; the user's steps, visible
results, and recovery options; and the system's owners, data, state changes, and
failures. Trace one representative flow across them. Use concrete behavior
before implementation vocabulary, and connect each technical decision to its
effect on that flow. Do not substitute a list of components for the explanation.

Before finishing, inspect the actual deliverable as a reader with the expected
background who has not seen the conversation. Review words and names, sentences,
explanation order, document navigation, code and system traceability, and
ownership handoff. Lead with the concrete problem and behavior, then explain
mechanisms, reasons, constraints, tradeoffs, and failures. Preserve necessary
technical detail. The reader must be able to follow the steps, recognize the
outcome, distinguish evidence from assumptions, and maintain the behavior.

Revise essential gaps before claiming completion. Technical verification and
understandable, maintainable, shareable work are both required. Scale the review
to the task: a small answer needs a brief internal check, not a ritual checklist.
Do not claim that technical checks or an AI review prove human comprehension.

For substantial planning and review, use the
[full readability standard](../guides/readability-and-ownership.md).

Check each instruction against the available sources: does the reader actually
have the named control, record, permission, or recovery mechanism? If that is
unknown, identify the gap instead of inventing an operational step. Explain
unfamiliar terms at first use in the artifact itself. Before finishing, reread
the artifact for those terms, unsupported actions, and overstated evidence;
repair what you find. A list of topics covered is not evidence of this review.

For a coding change or other substantial task, make the two checks observable
without waiting for a reminder. In the initial work update, name the intended
reader or user, their task, the factual sources you will inspect, and what they
must be able to use or maintain when the work is done. One or two concrete
sentences suffice. Before the final response, review the actual changed code,
tests, and documentation from that reader's position. Repair essential gaps,
then report a specific review finding or explain how a concrete part of the
artifact supports use or maintenance, together with the verification limits.
A list of changed files, passing tests, or a claim that a review happened does
not establish this check. Do not invent a defect to report or add a ritual
checklist; a small coding fix needs only a short orientation and handoff.

## Review before change

Do not edit from the prompt alone when the repository is available.

Before a non-trivial change, map the affected system far enough to understand:

- public entry points and exports;
- imports and downstream consumers;
- schemas, types, persisted shapes, and external contracts;
- configuration and environment inputs;
- runtime entry points and composition roots;
- resource acquisition, cancellation, disposal, and cleanup;
- state transitions and non-happy paths;
- tests, benchmarks, docs, generated output, and package artifacts;
- connected systems whose contract or lifecycle can change the correct design.

Trace a public operation through its important internal dependencies. Review both the normal path and failure, cancellation, retry, cleanup, and concurrent paths where they matter.

## Architecture and ownership

Prefer library-first composition.

Separate generic mechanisms, domain capabilities, declarative definitions, and
executable composition. The layout below is one application example, not a
required directory taxonomy. [okikio/utils](https://github.com/okikio/utils)
provides generic source packages under `packages/*`. When selected, verify their
public exports and actual release or source resolution with `use-utils`; do not
copy their implementation into a second utility tree.

```text
utils/       generic programming models and reusable mechanics
packages/    concrete domain capabilities
registry/    declarative definitions interpreted by packages or applications
clis/        executable composition and human/process input
apps/        user-facing composition roots
```

Reusability alone does not make a capability domain-neutral. A retry policy may be generic; HLS parsing or a provider integration retains specific semantics. Package the actual contract within the repository's model rather than deciding its role from a folder name.

Do not create `shared/`, `common/`, `misc/`, or `helpers/` as dumping grounds. Move a contract to the layer that owns the concept.

Keep dependencies one-way toward more foundational code. Do not fix a cycle by moving unrelated concepts into a vague shared module.

Injected live resources are borrowed by default. Transfer disposal ownership only through an explicit contract. Cancellation asks active work to stop. Disposal releases resources. These are different operations and can happen at different times.

Partial construction must release every resource the operation already acquired before it failed. If cleanup also fails, preserve the primary operation failure and retain the cleanup failure as secondary evidence instead of replacing the original cause.

Observation streams, logs, and progress events report activity. They do not become the authoritative terminal result or cancellation owner unless the API explicitly defines that role.

When a project has an execution context programming model, use it for scoped lifetime information such as cancellation, deadlines, clocks, identity, tracing, and child lifetime. Do not turn `ctx` into an ambient dependency bag. Inject concrete databases, stores, clients, writers, and other capabilities explicitly when they are real dependencies. Use the short parameter name `ctx` when its type and the surrounding API make the concept unambiguous.

Do not preserve obsolete compatibility by default. When the requested change replaces an API or model, update current consumers, tests, exports, docs, configuration, persisted data, and user flows, then remove the obsolete path. Keep compatibility only when the user or an external contract explicitly requires it.

## Apply the convention to its actual role

Namespace imports are useful for coherent runtime operation families, not a
blanket import style. Keep direct imports for test runners/assertions, schemas,
and types when they communicate the role. Document non-obvious test helpers and
invariants; trivial private fixtures do not require public API TSDoc. A runtime
schema owns validated serialized data, not every ephemeral object or live handle.
Preserve an explicit repository requirement and explain any material conflict.

## Naming and API shape

Names should be concrete, contextual, and short.

Use this order:

1. one precise word;
2. two words when one word is ambiguous;
3. three words when a real distinction still requires them;
4. longer names are a design warning.

Constants are exempt when a longer fixed name materially improves clarity.

Let folder, package, namespace, parameter type, and return type carry context. Prefer coherent namespace call sites such as:

```ts
import * as storage from "@media/storage";
import * as parser from "@media/parser";

const root = await storage.getRoot();
const events = parser.hls(source);
```

Prefer concrete verbs such as `get`, `create`, `open`, `save`, `inspect`, `plan`, `convert`, `download`, `select`, `read`, `write`, `close`, `pause`, `resume`, `cancel`, `copy`, `move`, and `remove` when they name the real operation.

Avoid vague project-owned names such as `generate`, `execute`, `handle`, `process`, `manager`, `helper`, `common`, `shared`, `misc`, `data`, `item`, and `thing` unless an external API or protocol requires that exact term.

Avoid the generic word `boundary` in project-owned names and explanations. Name the exact concept instead, such as an API entrypoint, validation seam, transaction commit, renderer context, ownership handoff, source conversion, version line, materialization point, or trust decision.

Use `get` for addressable retrieval. Use `read` for actual reading or sequential consumption, such as a stream reader, file reader, archive reader, or cursor.

At an external integration seam, preserve protocol or provider terminology while it is still provider data. Convert it into project terminology only at the explicit mapping into the project model. Do not pretend an external field has project semantics before that conversion exists.

## Data contracts and schemas

Schemas own structural data contracts. Interfaces, classes, and functions own behavior.

For TypeScript projects:

- For a new TypeScript project without a selected validator, Zod v4 is a default candidate for executable validation or transformation. Preserve an existing validator that meets the contract.
- Every project-owned Zod schema constant ends in `Schema`.
- Project-owned data types normally end in `Type`.
- Behavior interfaces use the precise noun without `Type` when that noun describes an object with operations, such as `Writer`, `Task<Result>`, or `FileHandle`.
- Do not maintain a hand-written TypeScript data interface beside a Zod schema that owns the same shape. Infer the data type from the schema.
- Put useful TSDoc on public or reusable schema fields when the schema is the authoring source and the field's meaning, unit, default, allowed-value effect, or example is not obvious. Do not create a mirror interface only to hold field comments.
- For repository-owned defaults or fixtures, `satisfies z.input<typeof Schema>` can provide a useful compile-time drift check. Public authoring helpers such as `defineConfig(...)` should provide schema-derived contextual typing so normal callers do not have to write `satisfies` themselves.
- Prefer direct schema and type exports. Use namespace imports for coherent runtime operation families when they make call sites shorter and clearer.
- Use strict object schemas for project-owned records unless an explicit compatibility contract allows unknown fields.

Use Standard Schema when a reusable package needs to accept validators from several schema libraries. Do not depend on Zod-specific introspection in a generic validator integration merely because first-party schemas use Zod.

Standard JSON Schema is a different contract. Use it when the consumer needs JSON Schema or a standardized conversion to JSON Schema, not as a synonym for Standard Schema validation.

Project-owned TypeScript and JSON fields normally use `camelCase`. Preserve external or persisted naming when that contract already defines another form, and map it explicitly when the data enters the project model.

## JavaScript and TypeScript defaults

Assume Deno v2, strict TypeScript, ESM, explicit file extensions, and JavaScript-native TypeScript unless the local project says otherwise.

Prefer one TypeScript implementation across Deno, Node, Bun, browsers, and workers where the capability overlaps. Put runtime-specific integrations behind explicit modules or adapters instead of forking the domain implementation.

Prefer JavaScript-native constructs when JavaScript already expresses the intent clearly. Avoid TypeScript-only ceremony unless it adds real value. Prefer constant objects plus derived types over `enum` when both express the same runtime model.

Keep modules tree-shakeable and import-safe. Avoid hidden global state, provider connections, environment reads, logging configuration, worker startup, or other unrelated acquisition during module evaluation.

Prefer Web APIs, then focused standard-library packages, then existing project utilities whose stronger semantics match the need, then focused maintained third-party libraries. Review existing dependencies before adding another implementation.

In shared code, count direct Node/Deno globals and static runtime-module imports
as portability smells. Inspect existing `utils/` or focused env/file/process
owners before introducing another host dependency. Classify actual consumer
breakage separately from intentional executable adapters and test-runner
imports; see the TypeScript reference for the review and verification model.

## Writing and explanation style

Use plain technical English by default. Apply formal ASD-STE100 or a project-specific STE profile only when the task explicitly requests it.

Build understanding progressively:

1. show the concrete behavior or problem;
2. explain why it matters here;
3. show the high-level model;
4. introduce specialized terminology only when it helps;
5. deepen into options, edge cases, limits, failures, and implementation detail.

Use one technical noun for one concept. Define unfamiliar terms before relying on them. Prefer transitions when the next paragraph continues the same idea. Add a heading only when the reader is entering a substantial new topic.

Avoid self-referential filler, vague claims such as `better` or `optimized`, and metaphors when direct technical language is enough. Avoid em dashes.

Distinguish verified current behavior, proposed behavior, inference, and future work. Do not document an aspirational package name as if its implementation already exists.

## Comments, docs, and TSDoc

Documentation is part of the code contract.

Every exported symbol needs useful TSDoc unless it is a direct re-export whose source documentation remains visible and complete. Also document important non-exported functions, classes, constants, schemas, types, interfaces, fields, state machines, scanners, lookup tables, and private helpers when they own behavior a reader cannot reliably recover from the name and syntax alone.

A significant doc block should progressively teach the relevant parts of:

- what the symbol means and where it fits in the larger flow;
- why it exists;
- important options and their concrete effects;
- a realistic common-path example;
- an edge case or configuration example when useful;
- ownership of live resources;
- cancellation, cleanup, and terminal behavior;
- limits, bounded memory, concurrency, or performance consequences;
- expected failures and unsupported behavior;
- the invariant or design reason that future changes must preserve.

Do not add coverage-only comments such as `Gets the root.` or `Write the bytes.` Local comments should state the rule the code must preserve, the reason for an unusual operation, or the non-obvious effect of the next lines.

Use ASCII diagrams, tables, or lists when they make lifecycle, ownership, data shape, state transitions, retries, cleanup, or exact comparisons easier to understand. Choose the representation from the reader's question, not from the diagram tool already open.

## Logging and observability

Reusable packages may emit structured LogTape diagnostics when the repository uses LogTape. They must not configure global sinks, levels, formatters, redaction, or destinations. The application or executable composition root owns logging configuration and flush/disposal.

Use hierarchical categories that follow subsystem ownership. Keep stable result data, progress/state authority, workflow history, and domain events separate from diagnostics even when LogTape is also used to observe them.

Treat redaction as a policy that must be traced against actual fields and debugging needs. Do not enable broad redaction without checking what evidence it destroys.

## Performance and limits

Every operation whose memory, concurrency, retries, requests, queue depth, process count, or output can grow needs an explicit limit or a clear reason it is inherently bounded.

Treat non-trivial optimization as a design decision. Document:

- the physical work being changed;
- the cost it reduces;
- why the workload makes that cost important;
- the semantic or maintenance tradeoff;
- how the optimization can be disabled when it can change observable behavior.

Do not claim performance from intuition alone. Benchmark the real operation and inspect allocation, I/O, process count, requests, latency, throughput, and cancellation where relevant.

## Validation and completion

`done` means the claimed behavior has been tested and the deliverable itself has been inspected.

Run the checks that fit the repository, including as applicable:

- formatter check on changed code only;
- lint;
- strict type checks;
- unit, integration, lifecycle, browser, and conformance tests;
- benchmarks for performance-sensitive changes;
- builds and package generation;
- runtime smoke tests across required runtimes;
- generated output inspection;
- docs/TSDoc checks;
- real user-flow verification.

Do not claim unavailable checks passed. Report the exact command, result, and blocker.

When delivering a ZIP or package artifact, validate the exact artifact, not only the source tree. Extract it into a clean directory, compare the expected file set, rerun the available checks against the extracted copy, inspect generated output, and compute a hash when practical.

Keep functional changes separate from unrelated formatter, import-sort, generated-file, line-ending, or whitespace churn. Apply required formatting only to directly changed code and inspect the diff before delivery.
