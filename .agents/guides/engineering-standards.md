# Okikio Engineering Standards

**Status:** current cross-project engineering standard  
**Revision:** 2026-08-19  
**Applies to:** TypeScript repositories using these standards; repository-specific instructions narrow their application

**Clarified on October 14, 2026:** functional composition, service-owned contracts, Mise tasks, and CI selection.

## Apply by purpose (2026-10-14)

Treat conventions as protections for a concrete contract. Namespace imports
make coherent runtime operation families legible; direct test-runner/assertion,
schema, and type imports remain appropriate. A private test fixture is not a
public API. Document test helpers when they own a non-obvious invariant, not to
meet a mechanical comment quota. Runtime schemas own validated serialized data,
not every ephemeral local object or live behavioral interface.

When using [okikio/utils](https://github.com/okikio/utils), read `use-utils`, the
consumer's resolved public exports and the relevant implementation/tests. Source
versions and published releases are separate evidence. Preserve the existing
dependency owner when it meets the task; historical workspace aliases do not
establish a current API.

## Relationship to the compact baseline

[Software quality](software-quality.md) owns the shared obligations. The
[base reference](../references/base.md) supplies the compact engineering detail;
this guide explains the rationale and examples. Use the owning project's
requirements for runtime, toolchain, schema and naming choices. Installed
bundles carry the same required sources with local links. Do not treat an older
handoff or a copied example as a newer contract.

## Why this standard exists

The engineering style has converged across several projects. Older guides still contain useful architecture and domain knowledge, but some defaults have changed enough that repeating them in every task creates drift.

This document makes the current cross-project rules explicit. It does not replace a package-specific architecture guide. It defines the common engineering model that package and repository guides build on.

The main idea is straightforward:

> A reader should be able to understand what the system owns, how data and resources move through it, what can fail, and how the implementation was verified without reconstructing the design from scattered code and chat history.

That affects architecture, names, schemas, comments, documentation, testing, logs, tooling, and the final artifact.

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

## Authority when sources disagree

Use this order:

1. the current explicit requirement;
2. the latest repository instructions and verified current implementation;
3. this current cross-project standard;
4. focused package, architecture, or workflow documentation;
5. older handoffs, examples, experiments, and historical code.

The current implementation is the source of truth for what the software does now. A newer design document can define what should replace it, but it does not make missing behavior real.

When a newer ZIP, branch, test result, or document is supplied, verify that it is the intended source before editing. Compare it with earlier material. Do not silently merge incompatible generations of the design.

## Review before editing

Do not edit from the requested symbol alone when the repository is available.

First map the relevant system:

```text
public API
   |
   v
schemas / types / config
   |
   v
implementation
   |
   +--> live resources
   +--> persistence
   +--> queues / workers / processes
   +--> external APIs
   +--> UI / CLI consumers
   |
   v
tests / benchmarks / docs / generated artifacts
```

For a non-trivial change, inspect enough of these to understand the real effect:

- current exports and public subpaths;
- imports and downstream consumers;
- schemas, types, fields, persisted records, and serialization;
- CLI, environment, configuration, and programmatic inputs;
- runtime entry points and composition roots;
- resource acquisition, ownership, cancellation, and disposal;
- state transitions and stale or concurrent work;
- failures, retries, partial results, cleanup, and recovery;
- tests, benchmarks, documentation, and examples;
- build output, declarations, package contents, and generated files;
- adjacent systems whose contract or lifecycle can change the correct solution.

A public operation should be traceable through its important internal dependencies. Review the normal path and the paths that can corrupt state, leak resources, leave stale work active, or disagree across runtimes.

## Architecture separates ownership roles

These are ownership roles, with one possible application layout below. The
utility repository puts generic mechanisms under `packages/*`; its directory
name does not make them product capabilities. Use the existing repository's
layout and dependency graph rather than adding a second `utils/` tree.

```text
utils/
  generic programming models and mechanics

packages/
  concrete capabilities and domain semantics

registry/
  declarative definitions interpreted by packages or applications

clis/ and apps/
  executable composition, user interaction, and product policy
```

### Generic mechanics remain useful outside the product

A utility should remain meaningful outside the current domain.

Examples:

```text
context
resource ownership
workflow mechanics
retry
streams
permissions model
capacity primitives
process control
generic codec representation conversion
```

### Concrete capabilities own domain semantics

A concrete capability can be reusable without being generic.

Examples:

```text
HLS
DASH
version semantics
RDF
SPARQL
technology registry
OPFS adapters
media inspection
storage providers
```

Sharing across applications does not erase a capability's domain semantics. Name and package the actual contract; folder names alone do not decide ownership.

### Composition belongs at executable roots

Applications and CLIs own decisions that should not leak into reusable packages:

```text
argv
prompts
terminal output policy
environment discovery
application LogTape configuration
service startup
signal installation
product permissions and entitlements
routing
UI state composition
```

A reusable library can expose the capability. The executable decides how the product configures and presents it.

## Dependency direction

Dependencies should move toward more foundational code.

```text
executable composition
    |
    v
domain capabilities
    |
    v
generic mechanisms
```

Focused third-party libraries and Web APIs can enter at the layer that actually uses them.

Do not fix a cycle with `shared/`.

Avoid dumping-ground names:

```text
shared/
common/
misc/
helpers/
```

If two packages need the same contract, identify which concept owns it. If the concept is truly generic, move that concept to a focused utility. If it is domain-specific, give it a real package or module name.

## Functional code and service-authored contracts

Prefer pure transformations and completed records for domain logic. Keep I/O,
environment discovery, long-lived resources, and deployment registration in
explicit executable adapters. A class or mutation is appropriate when the
framework or resource lifetime requires it; do not prohibit syntax without
examining the behavior. Prefer static imports for unconditional modules.

Services author their own import-safe request, response, problem, endpoint, and
OpenAPI definitions. Public contract packages re-export those exact definitions
and build clients from them; they do not independently author the catalog that
the original service then imports. Validate the request at its transport entry,
propagate the parsed value, and prove every advertised response variant. Avoid
repeated validation of the same value or duplicate API documentation owners.

## Resource ownership must be explicit

A live resource has an owner.

Examples include:

- a browser process;
- a worker;
- a database connection;
- a filesystem adapter;
- a media input;
- a writable file;
- a lock;
- a network response body;
- a conversion session.

Injected resources are borrowed by default.

```text
caller creates resource
        |
        +--> package borrows resource
        |        |
        |        +--> package finishes
        |        +--> resource remains open
        |
        +--> caller still owns resource
```

Ownership changes only through an explicit option or constructor contract.

If construction acquires several resources and then fails, release everything already acquired before returning the failure. A cleanup failure must not erase the primary operation failure. Preserve both so diagnostics retain the original cause and the cleanup defect.

Cancellation and disposal are different:

```text
cancel
  asks active work to stop

dispose
  releases resources after work ends or can no longer continue
```

A task can be canceled and still require disposal. A resource can be disposed after successful completion without ever being canceled.

When the runtime supports explicit resource management, prefer `using`, `await using`, `Disposable`, `AsyncDisposable`, `DisposableStack`, and `AsyncDisposableStack` when they improve the ownership model.

## Observation is not authority

Progress events, observables, and LogTape records describe what happened. They do not automatically own the operation.

A long-running operation often has three distinct forms of information:

```text
current state
  authoritative snapshot

terminal result
  authoritative completion / failure / cancellation

events and logs
  observation for UI, debugging, metrics, and telemetry
```

Do not make a high-frequency event stream the terminal result store. Do not make a log line the durable fact another package must consume.

## Context carries scoped lifetime, not arbitrary dependencies

When a project uses an execution context programming model, keep the concept narrow. A context can carry scoped execution information such as:

```text
cancellation
deadline
clock
identity
trace/span context
child lifetime
```

It should not silently become the place where every database, client, store, logger, configuration object, or unrelated service is hidden. Pass concrete capabilities explicitly when the operation depends on them.

Use `ctx` as the parameter name when the context type and surrounding API make the meaning obvious:

```ts
await inspect(ctx, source);
await resource.create(ctx, definition);
```

Use a longer name only when several different context concepts exist at the same call site.

## Do not preserve obsolete compatibility by default

A deliberate replacement should finish the migration.

That means updating:

- current imports and call sites;
- exports and package subpaths;
- tests and fixtures;
- docs and examples;
- config and environment contracts;
- generated code;
- persisted data or migrations when affected;
- user flows and UI;
- integration adapters.

Then remove the obsolete implementation.

Compatibility is appropriate when the current requirement or an external public contract explicitly requires it. It is not the default answer to an internal refactor.

## Naming uses context before extra words

The surrounding package, module, namespace, parameter type, and return type already communicate meaning.

Prefer names in this order:

1. one precise word;
2. two words when one word is ambiguous;
3. three words when a real distinction still requires them;
4. more than three words is a reason to review the design.

Constants are exempt when a longer fixed name communicates an important invariant.

### Namespace-oriented operations

Prefer:

```ts
import * as storage from '@media/storage';
import * as codec from '@media/codec';
import * as parser from '@media/parser';

const root = await storage.getRoot();
const kind = codec.kind(value);
const events = parser.hls(source);
```

The namespace supplies the domain. The operation can stay short.

Do not turn the same API into:

```ts
getMediaStorageRootDirectory();
classifyMediaCodecKind();
parseHttpLiveStreamingManifest();
```

when the import context already contains those nouns.

### Prefer concrete verbs

Good project-owned verbs include:

```text
get
create
open
save
inspect
plan
convert
download
select
read
write
close
pause
resume
cancel
copy
move
remove
compile
resolve
```

Avoid vague verbs and nouns unless an external API requires them:

```text
generate
execute
handle
process
manager
helper
common
shared
misc
data
item
thing
```

`worker` names an actual runtime worker or queue worker. Do not use it for every object that performs work. Name the real process, browser page, thread, queue claim, lease, task, operation, or workflow activity when that is the actual concept.

Name the exact architecture concept instead of relying on a generic catch-all noun. Prefer an API entrypoint, validation seam, transaction commit, renderer context, ownership handoff, source conversion, version line, materialization point, or trust decision when that is the real concept.

`run()` can be correct when a namespace or domain type makes the operation exact. A top-level `run()` in a package full of unrelated behavior is usually not exact enough.

### `get` and `read` are different

Use `get` for addressable retrieval:

```ts
storage.getRoot();
config.get('output');
```

Use `read` when bytes, characters, records, or entries are actually consumed:

```ts
reader.read();
archive.read();
stream.read();
```

## Files and folders use their parents as context

Prefer one-word folders when the parent already supplies the missing noun.

```text
packages/media/hls/
packages/media/parser/
packages/rdf/xml/
utils/streams/
```

Use multiword kebab-case only when the concept genuinely needs more than one word.

Reserve underscore-prefixed entries for verified non-discoverable support entries inside auto-discovered trees. Do not use underscores as a general private-file convention.

## Schemas, data types, and behavior types have different jobs

A schema owns structural data.

A behavior interface owns operations.

### Zod schema names

Every project-owned Zod schema constant ends in `Schema`:

```ts
SourceSchema
TrackSchema
ProjectConfigSchema
TaskStateSchema
```

### Project-owned data types

Project-owned data types normally end in `Type`:

```ts
SourceType
TrackType
ProjectConfigType
TaskStateType
```

Infer them from the schema when the schema owns the same shape:

```ts
export const SourceSchema = z.strictObject({
  kind: z.literal('url'),
  url: z.url(),
});

export type SourceType = z.output<typeof SourceSchema>;
```

Do not maintain a second hand-written interface that can drift from the schema.

### Behavior interfaces use the concrete noun

A behavior interface does not need `Type` merely because it is written in TypeScript:

```ts
interface Writer {
  write(write: WriteType): Promise<void>;
  close(): Promise<void>;
}
```

Other examples:

```text
Writer
Task<Result>
FileHandle
Adapter
Client
Driver
Bridge
```

The noun must still be precise in the project model.

### Put field documentation on the schema that owns the field

When a Zod object schema is the authoring source for project-owned data, document important fields directly on the schema properties. This lets the schema own both the executable data contract and the field meaning that editor tooling should expose.

```ts
export const SourceSchema = z.strictObject({
  /**
   * Maximum simultaneous requests for this source.
   *
   * Higher values can improve range-read throughput but increase remote
   * request load and local buffering pressure.
   *
   * @default 4
   * @example 8
   */
  concurrency: z.int().min(1).max(64).default(4),
});

export type SourceType = z.output<typeof SourceSchema>;
```

Do not maintain a handwritten mirror interface only to hold field comments.

For repository-owned defaults and fixtures, `satisfies z.input<typeof Schema>` is a useful compile-time check when it improves contextual documentation and detects drift:

```ts
const defaults = {
  concurrency: 4,
} satisfies z.input<typeof SourceSchema>;
```

A public `defineConfig(...)`-style helper should provide schema-derived contextual typing itself. End users should not have to add `satisfies` to normal configuration authoring.

## Standard Schema is for validator interoperability

Zod is the default executable schema authoring example in this collection. Preserve a project's selected validator when it meets the contract.

A generic package should not require Zod-specific introspection merely to accept a validator. When the real requirement is:

> Accept any compatible TypeScript validation library.

use Standard Schema at that integration seam.

```text
first-party schema
  Zod v4

portable validation input
  Standard Schema

JSON Schema representation / conversion
  Standard JSON Schema
```

Standard Schema and Standard JSON Schema solve different problems. Do not use the names interchangeably.

## Project-owned fields normally use camelCase

Use `camelCase` for project-owned TypeScript and JSON fields.

Preserve another spelling when an external contract defines it:

```text
HTTP header
provider JSON
SQL column
legacy durable record
standardized file format
```

Map provider data explicitly into project data when the internal contract should differ.

Do not impose snake case on all records merely because they are serializable.

## Public exports should be intentional

Every exported runtime symbol becomes part of the support surface.

Prefer direct schema and type exports:

```ts
import { SourceSchema, type SourceType } from '@media/source';
```

Prefer namespace imports for coherent runtime operations:

```ts
import * as source from '@media/source';

const input = await source.open(ctx, request);
```

Do not use a namespace to make an incoherent module appear coherent.

Keep root entry points import-safe. Runtime-specific adapters belong behind explicit subpaths.

## Formatting should reveal structure without adding noise

Compact does not mean one line at any cost.

The default is:

> Keep a call or short literal flat when it is easy to scan. Expand it when the vertical structure explains meaningful groups, comments, or comparisons.

Prefer:

```ts
await capture({ route, context, writer, signal });
const range = { start, end };
const kinds = ['video', 'audio', 'subtitle'] as const;
```

Expand when structure matters:

```ts
await capture({
  route,
  browser: { context, page, lease },
  archive: { writer, directory },
  analysis: { extractors, pool },
  signal,
});
```

### Local callbacks and nested functions

A tiny callback can stay where it is used.

A substantial nested function should normally become a named module-level operation when it owns:

- a state transition;
- a cleanup rule;
- a parser invariant;
- a retry policy;
- a performance-sensitive loop;
- a reusable concept;
- an independently testable unit.

Do not hide the most important function in a module inside another function merely to keep it private.

### Functional and mechanical changes stay separate

Do not mix a behavioral change with repository-wide:

- formatter churn;
- import sorting;
- whitespace cleanup;
- line-ending changes;
- generated-file refreshes unrelated to the task;
- renamed files that do not support the requested change.

Format directly changed code as required. Inspect the diff and revert unrelated mechanical changes.

Never broad-format authored Markdown unless formatting is the requested task.

## TSDoc documents public and important private behavior

Documentation depth follows semantic depth, not export visibility.

Every exported symbol needs useful TSDoc unless it is a direct documented re-export.

Important non-exported symbols also need documentation when they own non-obvious behavior:

```text
functions
classes
constants
schemas
types
interfaces
fields
state machines
parsers and scanners
lookup tables
resource owners
retry/cleanup logic
performance-sensitive loops
```

A private helper can contain the invariant that prevents data corruption. Leaving it undocumented because it is private makes the module harder to maintain, not cleaner.

### A useful TSDoc narrative

A substantial reusable API should answer the relevant parts of this story:

1. What does this symbol mean?
2. Why does it exist?
3. Where does it fit in the larger flow?
4. What do the important options change?
5. What does a normal caller do?
6. Which edge case changes how it must be used?
7. Who owns live resources?
8. What does cancellation stop?
9. What must be closed or disposed?
10. What grows and what limits it?
11. What can fail or remain unsupported?
12. Which invariant must future changes preserve?

Do not turn those questions into twelve boilerplate headings. Use a smooth narrative and add a heading only when the subject materially changes.

### Comments explain rules, not syntax

Weak:

```ts
// Write the bytes.
await writer.write(write);
```

Useful:

```ts
// Keep the explicit position because the muxer can rewrite earlier container metadata during finalization.
await writer.write(write);
```

The comment tells a maintainer what must remain true.

## Plain technical English is the normal writing style

Use direct, concrete technical English.

Formal ASD-STE100 applies only when the current task explicitly requests it.

The general writing principles still remain useful:

- define unfamiliar terms;
- use one noun for one concept;
- prefer active voice;
- state concrete effects instead of vague quality claims;
- keep sentences focused;
- avoid em dashes;
- explain background before relying on project-specific terminology.

Do not apply a mechanical word-count rule or sentence-length rule to normal documentation unless the requested style requires it.

## Documentation should build a mental model

For concept and architecture material, the default story is:

```text
what it is
   |
   v
problem it solves
   |
   v
high-level behavior
   |
   v
end-to-end example
   |
   v
options and alternatives
   |
   v
failure / lifecycle / limits
   |
   v
deep implementation detail
```

Prefer transitions over headings while the topic continues.

Distinguish:

```text
verified implementation
upstream documented behavior
inference
proposal
future work
```

A package called `convert` can still contain only request validation today. Documentation must say that if it is true.

## Choose visuals from the reader's question

Do not teach every concept with the same box-and-arrow grammar.

Examples:

| Reader question | Useful representation |
| --- | --- |
| What happens over time? | sequence diagram or lifecycle walkthrough |
| Who owns each stage? | swimlane |
| Which transitions are legal? | state machine |
| How do conditions combine? | decision table |
| Which modules depend on which? | dependency/component map |
| How does data change? | data-flow diagram |
| How do exact values compare? | table or quantitative chart |
| How does quantity move? | Sankey when width meaningfully encodes flow |

Use the least complicated representation that preserves the truth the reader needs.

ASCII remains especially useful for code comments, terminals, reviews, and ownership/lifecycle flows because it is easy to diff and read without rendering.

## LogTape is the default diagnostics model when selected by the project

Reusable packages can use LogTape to record structured diagnostics. They do not configure global logging.

```text
library/package
  getLogger(category)
  emit structured records
        |
        v
application / CLI
  configure sinks
  formatters
  levels
  redaction/exposure policy
  telemetry
  file retention
  final flush
```

Use hierarchical categories that follow subsystem ownership:

```text
media.convert
media.download
app.browser.capture
app.analysis.collect
```

Avoid encoding all searchable dimensions in a message string. Keep stable properties structured. Use lazy properties for expensive diagnostic values and rate controls for repetitive hot paths when the record volume justifies them.

Keep a repository-selected formatter when it communicates its records, stages, metrics, resource trees and completion summaries clearly. Treat `@logtape/pretty` as a useful reference or fallback, not an automatic replacement. Test narrow terminals, non-TTY output, multiline values, causes, and structured property rendering.

### Logs do not replace domain authority

A log record can observe a stage, result, event, or metric without becoming the only durable representation of that information.

Keep these concepts separate when they serve different consumers:

```text
command result
domain event
workflow history
task state
artifact
metric
diagnostic record
```

Successful work is also evidence. Do not make a fingers-crossed or sampling sink the only record of success. Human output can collapse repetitive successful records into counted summaries, while a durable diagnostic route can retain the full structured records according to the configured retention policy.

### Redaction is a route-specific data policy

Redaction can remove exactly the field needed to diagnose a failure. Trace real log call sites before enabling broad patterns. Determine:

- which fields are verified secrets or personal data;
- which fields are required to debug failures;
- which sinks can leave the process;
- what stable result schemas are allowed to expose;
- whether the chosen redaction preserves useful non-secret evidence.

Do not automatically apply diagnostic redaction to stable user-requested results such as `config show`, exports, or support bundles. Those outputs need their own schema and exposure policy. Keep structured values intact until after the relevant policy runs. Add tests that prove both sides: known secrets are hidden and known diagnostic IDs, paths, causes, or URLs remain visible when they are not secret.

Use `@logtape/testing` when log behavior is part of the contract. Recorder and failure-reporting helpers are preferable to assertions against formatted console text when the structured record is the real API.

### Sinks and reusable writers stay runtime-neutral

Reusable CLI output code should accept a small writer contract instead of calling `Deno.stdout`, `Deno.stderr`, or Node streams directly. The executable adapter can bind those host streams.

Current LogTape 2.3.1 keeps a plain `Sink` synchronous. When output requires async backpressure or I/O, use `AsyncSink` plus `fromAsyncSink()`. The resulting sink uses asynchronous disposal, so configure and shut it down through the async LogTape lifecycle. Verify the installed LogTape version before copying version-specific code.

## Optique is selected per CLI, not imposed on every library

CLIs that use Optique should let Optique own command grammar, choices, aliases, typo suggestions, source-aware parsing, help, completion, and manuals instead of duplicating those systems. Use `@optique/logtape` when its logging grammar matches the CLI instead of hand-building equivalent verbosity/output options.

That does not make Optique the parser for every project. A project can deliberately own a native parser. Luchalibre is an example of the distinction:

```text
@luchalibre/cli
  owns native argv parsing

@luchalibre/optique
  optional compatibility / reference / conformance adapter
```

The reusable core must not depend on Optique parser types merely because one executable uses Optique.

As of 2026-08-19, Optique 1.2.1 is the current stable release and 1.3.0 is unreleased. Treat 1.3 documentation as future behavior until it ships. Always inspect the repository lockfile and current official docs before using version-specific APIs.

## Parsing, resolution, and execution are separate responsibilities

A parser interprets one representation that has already been supplied. It does not need to become the owner of every place a value could come from.

A resolver combines sparse values from independent sources, records precedence/provenance, and applies declared defaults at the correct stage.

Execution owns live effects and resources.

```text
representation
   |
   v
 parser
   |
   v
sparse value
   |
   +---- other sparse sources
   |
   v
resolver
   |
   v
runtime request
   |
   v
execution / live resources
```

Do not make parser inspection, help generation, or source discovery execute callbacks that acquire resources. Do not represent missing, deferred, pending, or skipped control state by inventing a fake value of the domain type.

## Configuration keeps authored layers sparse

CLI, environment, file, and programmatic sources are authoring layers. Defaults should not erase provenance before precedence resolution.

A typical model is:

```text
CLI patch
ENV patch
file patch
    |
    v
resolve precedence and explicit operations
    |
    v
resolved sparse patch
    |
    v
runtime schema applies defaults/transforms once
    |
    v
complete runtime config
```

Plain arrays normally replace inherited arrays unless the project defines explicit append/prepend/replace operations.

Discriminated union variants should replace atomically when recursive merge would create an impossible hybrid.

Record provenance during resolution. Do not attempt to infer the winning source afterward from the final value.

## Unplugin integrations belong to the build layer that uses them

When the repository already uses the Unplugin ecosystem and a maintained integration removes framework-specific glue, prefer that integration over a custom compiler plugin.

For Unplugin Icons, for example, verify:

- the selected bundler adapter;
- the selected renderer compiler;
- on-demand virtual imports;
- SSR/SSG behavior;
- custom icon collections when used;
- auto-import configuration when used;
- generated TypeScript support;
- production bundle inclusion.

Do not add an Unplugin package merely because another project uses it. Confirm it solves the current build problem and is compatible with the current framework and lockfile.

## Oxc and build tooling follow repository ownership

When a repository has selected Oxc for parsing, transforms, linting, or build work, reuse the maintained Oxc integration instead of introducing Babel or another parallel compiler stack without a concrete capability gap. The same rule applies to Unplugin and mise: reuse the owner the repository selected, verify its current API and generated output, and avoid creating a second tool graph that can drift.

Tool popularity elsewhere is not enough reason to add it. The owner must solve the exact current job and survive the repository's real runtime, bundler, type, and artifact checks.

## Web UI uses the renderer's actual lifecycle

Do not copy React lifecycle code mechanically into Solid or vice versa.

When a project uses Astro + React, Base UI, Tailwind CSS v4, cnfast, TanStack Router, Motion, and Unplugin Icons, preserve the ownership model of those tools rather than wrapping them into one generic UI abstraction.

Generated component code must be adapted to the local renderer, accessibility primitives, tokens, icons, and font ownership.

## Motion has a job

Motion should explain a state change, preserve continuity, confirm action, guide attention, or express deliberate product character.

Before adding an animation, ask:

1. What changed?
2. What should the user understand because of the motion?
3. How often will the user trigger it?
4. Can the user interrupt it?
5. What happens under reduced motion?
6. Can the real target device render it smoothly with production data?

High-frequency actions should be shorter and quieter than one-time onboarding moments.

Test origin, interruption, keyboard use, touch use, reduced motion, offscreen work, cleanup, and slower devices.

## Prefer established libraries over project-local reinvention

Before writing a custom implementation, inspect:

1. Web platform APIs;
2. `@std/*` packages;
3. existing project utilities;
4. existing project dependencies;
5. focused well-maintained ecosystem libraries.

A dependency is useful when its contract matches the problem. Do not add a dependency only to avoid writing ten lines, and do not rewrite a mature parser, storage driver, or runtime integration merely to avoid a focused dependency.

For adapters, bridges, and protocols, inspect the upstream source and official documentation. When the contract is subtle, review relevant issues, pull requests, or conformance tests too.

## Tests use `node:test` and `@std/expect` by default

Deno-first package tests should normally import:

```ts
import { describe, it } from 'node:test';
import { expect } from '@std/expect';
```

Use the same test source in Deno and Node when the behavior is portable.

Public type inference is part of the API. Compile small consumer fixtures that must type-check and fixtures that must fail with the intended type error when a generic, schema-derived authoring helper, overload, or discriminated union exposes non-trivial inference.

Use `fast-check` when generated adversarial inputs can prove an invariant.

Use Playwright for actual browser behavior.

Use Mitata for benchmarks.

A frontend application that already uses Vitest can keep Vitest. The rule is not to replace a deliberate local runner only for stylistic consistency.

## Test contracts at several levels

The exact layers depend on the capability, but a mature package often needs:

```text
schema tests
unit tests
integration tests
lifecycle tests
runtime-specific tests
browser tests
conformance tests
performance tests
consumer/package tests
```

A type-only pass does not prove media I/O, filesystem behavior, process signals, browser storage, HLS parsing, network cancellation, or SQL semantics.

### Non-happy paths are first-class

Review and test:

- empty input;
- malformed input;
- exact minimum and maximum values;
- one value beyond each limit;
- cancellation before and during work;
- partial reads/writes;
- close versus abort;
- cleanup after failure;
- stale completion;
- concurrent operations;
- bounded buffering;
- retry exhaustion;
- unsupported runtime capability;
- process or worker shutdown;
- persisted recovery where applicable.

## Property tests protect invariants

Good `fast-check` properties include:

```text
round trip
idempotence
chunk invariance
canonical path never escapes root
optimized result equals reference result
source-preserving rewrite keeps unrelated syntax
state machine never reaches illegal state
late completion never replaces terminal cancellation
```

The oracle must be independent. Do not compute the expected value by reusing the function under test.

## Benchmarks use representative workloads

Use Mitata to measure a real performance question.

Record the physical metrics that matter:

- operations or domains per second;
- bytes per second;
- p50/p95/p99 latency when relevant;
- peak and retained memory;
- allocations;
- active processes, workers, tabs, or requests;
- provider request count;
- write count;
- cancellation latency;
- startup and cleanup.

Compare the implementation against a baseline, previous version, reference implementation, or alternative when the benchmark is meant to justify a design choice.

Do not optimize against an input that bears no resemblance to production.

## Every growing operation needs a limit

Ask what can grow:

```text
buffer
queue
cache
parts
files
requests
workers
processes
browser tabs
routes
retries
response body
log retention
```

Then make the limit explicit or prove the operation is inherently bounded.

A streaming API is not memory-bounded merely because it accepts a stream. An unbounded producer can still outrun a consumer unless backpressure or admission limits exist.

## Optimizations that can change behavior need an off switch

Examples include:

- partitioning;
- caching;
- prefetching;
- native copy/move selection;
- multipart promotion;
- speculative reads;
- alternate parser fast paths.

When the optimization changes observable behavior, durable layout, consistency, request shape, or failure semantics, make it independently disableable and inspectable.

Document the physical work it changes and the tradeoff it introduces.

## Validation is layered

A substantial code change is not done after one green test command.

Run the applicable matrix:

```text
format changed code
lint
strict type checks
unit tests
integration tests
lifecycle tests
browser/runtime tests
conformance tests
benchmarks
build
package
runtime smoke tests
generated output inspection
documentation checks
consumer flow
```

Use the repository's canonical Deno tasks when available. Record every native gate as **passed**, **failed**, **blocked**, or **not applicable**. A blocked runtime check is not success. State the exact runtime/tool that was unavailable.

When Deno or JSR is unavailable in an agent host, keep production imports unchanged. A disposable host adaptation can prove only the behavior it actually exercises. Keep it in the repository-approved ignored investigation workspace, and record the native checks that remain unavailable. Do not migrate production code to Node to satisfy the validation host.

## Keep maintained guidance separate from disposable investigation

An installed `.agents/` tree contains maintained skills, guides and references.
Preserve its source ownership and complete document dependencies. Do not place
temporary shims, generated test builds or one-off scripts beside that guidance.

Use the repository's established ignored investigation directory for:

- temporary host shims;
- generated test builds;
- browser test servers;
- compatibility declarations used only by the validation host;
- investigation scripts and reports.

Verify that Git ignores the directory and that normal test discovery, package
contents, build inputs and container contexts exclude it. Do not impose a new
directory name when the project already has an appropriate location. Temporary
validation code must not become a production dependency or package export.

Keep durable regression tests and recurring tooling with their maintained
owners. Preserve useful investigation evidence through the project's recovery
process before discarding scratch files.

## `.mise/tasks/` owns repository tasks

Do not add a root `scripts/` dumping directory for normal developer
operations. Use `.mise/tasks/` for repository tasks when Mise is the selected
task runner. Prefer short shell file tasks that directly invoke the real tool
or project-owned CLI. Do not create another task planner or `.mise/lib/`
application around them. Required GitHub checks should guard failures relevant
to the changed source or artifact; benchmarking and production apply are
separate deliberate workflows.

## A deliverable is verified only after the artifact is verified

For a source change that produces a ZIP, npm package, JSR package, executable, bundle, or generated site, verify both:

```text
working tree
   |
   v
artifact creation
   |
   v
exact artifact extraction / installation
   |
   v
same relevant checks
```

For a ZIP:

1. run the available checks in the working tree;
2. inspect the diff and remove generated/validation debris;
3. create the ZIP;
4. extract that exact ZIP into a clean directory;
5. compare the expected file list;
6. recreate only validation-side host setup;
7. rerun the applicable checks;
8. inspect generated output and package manifests;
9. compute SHA-256;
10. report any runtime that remained unavailable.

A working tree passing while the delivered ZIP fails means the delivery failed.

## Completion report

A useful final engineering report states:

- what changed;
- why the change exists;
- exact changed files;
- important behavioral differences;
- commands run and their results;
- runtime/browser/provider checks that passed;
- checks that were blocked and why;
- artifact path and hash;
- unresolved issues that still affect the claim.

Do not call work complete when a claimed behavior remains untested.

## Freshness notes for selected ecosystem rules

These cross-project rules were rechecked on 2026-08-19. Repository lockfiles and current primary documentation still decide version-specific implementation details.

- LogTape: https://logtape.org/ and https://logtape.org/changelog. LogTape 2.3.1 is the current release verified for this refresh. A plain `Sink` remains synchronous; asynchronous output uses `AsyncSink` and `fromAsyncSink()`.
- Optique: https://optique.dev/ and its changelog. The earlier source snapshot used Optique 1.2.1 and treated 1.3.0 as unreleased. Check the installed version and current release evidence before applying those examples.
- Oxc: https://oxc.rs/docs/. Reuse the repository-selected Oxc parser, transform, lint, format, or resolver path when it satisfies the need instead of silently creating a parallel compiler stack.
- Standard Schema: https://standardschema.dev/. Standard Schema validator interoperability and Standard JSON Schema representation are separate contracts.
- Unplugin Icons: https://github.com/unplugin/unplugin-icons. Verify the exact bundler/framework compiler and generated SSR/SSG output rather than assuming an integration is correct because the package is installed.
