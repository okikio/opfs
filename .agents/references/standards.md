# Current software engineering standards

## Purpose

This reference collects shared conventions for software libraries, services,
applications and developer tools. It exists so a task does not need to restate the same naming,
documentation, schema, lifecycle, formatting, and verification rules.

A project-specific requirement, current repository behavior, or explicit user
instruction can narrow these rules. Do not use this file to overwrite a more
specific source of truth.

## Source authority

Use this order when sources disagree:

1. The user's latest explicit requirement.
2. The latest supplied or checked-out source tree and its executable tests.
3. Repository-local instructions and focused project handoffs.
4. This cross-project standards reference and the focused skill for the task.
5. Current primary upstream documentation and source.
6. Older handoffs, examples, remembered APIs, and historical notes.

A document that describes a target design is not proof that the repository
implements it. Keep `verified current`, `target`, `benchmark-gated`, and
`unverified` claims distinct when the difference matters.

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

## Apply the convention to its actual role

Namespace imports are useful for coherent runtime operation families, not a
blanket import style. Keep direct imports for test runners/assertions, schemas,
and types when they communicate the role. Document non-obvious test helpers and
invariants; trivial private fixtures do not require public API TSDoc. A runtime
schema owns validated serialized data, not every ephemeral object or live handle.
Preserve an explicit repository requirement and explain any material conflict.

## Naming

Prefer the shortest concrete name that remains exact at its definition and every
call site.

- Prefer one concrete word when the package, module, type, or namespace supplies
  the rest of the meaning.
- Use two words when one word is ambiguous.
- Use three words only when a real distinction still requires them.
- Treat more than three words as a design warning. Constants are exempt.
- Do not abbreviate unless the abbreviation is established and unambiguous.
- Avoid generic architecture nouns when a concrete concept is available. Name the actual API, process edge, trust zone, transaction scope, module interface, network hop, or ownership point.
- Avoid vague project-owned names such as `generate`, `execute`, `handle`,
  `process`, `manager`, `helper`, `common`, `shared`, `misc`, `data`, `item`,
  `thing`, and `worker` when a more exact concept exists.
- `worker` is valid only for the actual runtime concept, such as a Web Worker,
  Deno Worker, or queue worker. Otherwise name the real process, thread, page,
  task, claim, lease, or operation.

Prefer concrete verbs such as `get`, `create`, `open`, `save`, `inspect`,
`plan`, `convert`, `download`, `select`, `write`, `close`, `pause`, `resume`,
and `cancel`.

Use `get` for addressable retrieval. Reserve `read` for consuming files,
streams, readers, cursors, archive entries, or other sequential sources.

`ctx` is acceptable for one well-typed execution context when the surrounding
operation makes its role clear. Do not create a universal context bag that
contains unrelated services, state, configuration, logging, storage, and
runtime resources merely to shorten parameter lists. Name distinct contexts
when they carry different lifetimes or responsibilities.

### Namespaces and imports

Use namespace imports for coherent operation families when the namespace makes a
short operation precise:

```ts
import * as csv from '@okikio/format/csv';
import * as result from '@okikio/result';

const document = csv.parse('name\nSam\n', { headerRow: 1 });
const parsed = result.ok(document);
```

Prefer direct imports for schemas, schema-derived data types, individually
meaningful constants, and types that should remain self-identifying:

```ts
import { SourceSchema, type SourceType } from '@media/source';
```

Do not use a namespace to hide an oversized or incoherent public surface.
Re-export a namespace only when the complete runtime module object is an
intentional public API.

## Schemas, types, interfaces, and fields

Use runtime schemas as the source of truth for project-owned serializable,
persisted, configuration, transport, and cross-process data when the project
has selected Zod or another executable schema system.

### Zod naming

- Every Zod schema constant ends in `Schema`.
- Project-owned schema-derived data types normally end in `Type`.
- Infer schema-owned types from the schema. Do not duplicate the same data shape
  in a hand-written interface.
- Use `z.output<typeof NameSchema>` when callers consume the parsed output shape.
  Use the input type only when the pre-parse shape is itself part of the API.

```ts
export const SourceSchema = z.discriminatedUnion('kind', [
  UrlSourceSchema,
  BlobSourceSchema,
  StreamSourceSchema,
]);

export type SourceType = z.output<typeof SourceSchema>;
```

### Behavior contracts

Interfaces and classes that model behavior, live resources, or provider
capabilities use the concrete domain noun without a `Type` suffix:

```ts
export interface Writer extends AsyncDisposable {
  write(chunk: Uint8Array): Promise<void>;
}
```

Do not put executable functions, live handles, loggers, fetch functions, or
other runtime resources inside stable data schemas solely to avoid defining a
behavior contract.

### Field documentation

Document public fields individually when their meaning is not completely
obvious from the field name and primitive type. Include the information that can
change caller behavior, such as:

- units and scale;
- defaults and when defaults apply;
- `null`, missing, unknown, and invalid semantics;
- ownership or whether a resource is borrowed;
- source, authority, or provenance;
- lifecycle state and terminal conditions;
- limits, boundedness, and memory implications;
- version or compatibility meaning.

Apply the same rule to important internal state. A private field that controls a
state machine, cache invalidation, sequence number, lease, parser cursor,
retirement generation, or cleanup invariant can need more documentation than a
thin public wrapper.

## Comments and TSDoc

Document every exported symbol that represents a real contract and every
important non-exported symbol whose purpose, invariant, lifecycle, data meaning,
or failure behavior is not obvious from its name and local code.

This includes important private/internal:

- functions and methods;
- classes and behavior interfaces;
- schema constants and schema-owned data types;
- fields and state records;
- parser tables and token maps;
- regular expressions;
- constants with domain meaning;
- resource factories and disposal paths;
- concurrency, cache, queue, retry, checkpoint, and state-machine helpers;
- benchmark fixture builders when they define the workload being measured.

Skip comments only when the complete behavior is already obvious from the name,
types, and a quick read of the implementation.

A useful comment or TSDoc block builds the reader's mental model in this order
when the information applies:

1. What the concept means.
2. Why it exists or what problem it solves.
3. What owns it and what it owns.
4. The important lifecycle or transformation.
5. The invariant that must stay true.
6. Cancellation, disposal, retry, or recovery behavior.
7. Limits, performance, memory, or boundedness.
8. Expected failures and what is deliberately not guaranteed.
9. A concrete example when behavior is not obvious.

Do not make comments self-referential or dependent on hidden project history.
Avoid phrases such as "this module exists to", "the code above", "as discussed
in the README", or "our new approach" when the same meaning can be stated as a
portable domain fact.

Comments must match current behavior. Do not document a proposed future state as
if it already runs.

## Documentation

Use plain English by default. Apply ASD-STE100 or the project's controlled
Simplified Technical English mode only when the user explicitly requests it or a
formal document requires it.

Long-form technical documentation should orient the reader before mechanics:

```text
problem and user/caller need
  -> mental model
  -> ownership and major concepts
  -> normal lifecycle
  -> concrete usage
  -> failures and non-happy paths
  -> limits and performance
  -> verification and operational consequences
```

Use progressive disclosure. Explain a term when it first becomes necessary.
Prefer transitions over many small headings. Use examples, tables, lists, and
ASCII diagrams when they make the behavior easier to understand rather than
merely decorating the document.

A package README should normally answer:

- What capability does the package own?
- What does it deliberately not own?
- What is the smallest useful call site?
- What data contracts does it accept and return?
- Which resources are owned or borrowed?
- How do cancellation, cleanup, retries, and recovery work?
- Which limits and runtime constraints matter?
- Which failures should callers expect?
- Which runtimes are supported and how was that verified?
- Which tests, benchmarks, or conformance suites prove important claims?

Keep reference material, conceptual explanation, tutorials, and troubleshooting
focused by question. Do not build one master document or diagram that mixes every
concern.

## Formatting

Formatting communicates structure. It is not a line-count competition.

- Keep function calls compact when their arguments remain easy to scan.
- Keep extra-short object literals, arrays, tuples, and signatures flat.
- Expand declarations and configuration objects more freely when vertical
  structure makes comparison, ownership, comments, or public contracts clearer.
- Expand calls when nested conceptual groups, comments, or long expressions need
  structure.
- Do not force every argument or property onto its own line.
- Do not force a dense one-line form merely to reduce vertical space.

Keep functional and formatting-only changes separate. Format only directly
changed code unless the task explicitly authorizes wider formatting. Inspect the
diff and revert unrelated whitespace, import sorting, line-ending changes, or
generated-file churn.

## Repository ownership

Use repository placement to preserve ownership. The example below describes
one application layout; it does not reserve `packages/` for domain code. The
[okikio/utils](https://github.com/okikio/utils) workspace owns generic source
packages under `packages/*`. A consumer may adopt their verified public entries;
source versions alone do not establish available registry releases.

```text
utils/
  generic reusable programming models and primitives

packages/
  concrete capabilities, domain implementations, and provider integrations

registry/
  declarative definitions interpreted elsewhere

clis/ and apps/
  executable grammar, host adapters, dependency selection, and composition
```

Do not fix a dependency cycle by creating `shared/`, `common/`, `misc/`, or an
oversized universal `core`/`runtime` package. Move the contract to a named
foundational owner only when it can be described without the concrete domain;
use the owning repository's package layout.

Libraries must remain import-safe. Importing a package must not configure
logging, read project configuration, install signal handlers, start timers,
launch processes, or acquire unrelated resources.

Do not preserve obsolete compatibility paths unless the user explicitly asks
for compatibility. A replacement is complete only after current consumers,
tests, exports, docs, configuration, persisted data, generated artifacts, and
user flows use the new path and the obsolete path is removed.

## Functional design and contract authority

Prefer pure functions and complete immutable records for domain decisions,
validation plans, and derived data. Keep environment reads, process signals,
network I/O, storage, service startup, and resource registration in explicit
adapters or composition roots. Avoid post-declaration mutation of shared
registry records when a complete definition is simpler to inspect. Classes and
mutable state are appropriate when a framework contract or real resource
lifetime requires them; the syntax alone is not a standards violation.

For a service-owned API, author import-safe endpoint definitions, request and
response schemas, known problems, and documentation in the service or owning
capability. A published `packages/contracts/` entry point re-exports those
*same* pure definitions and may expose generated OpenAPI or clients. It must
not author a second set of endpoints that the service imports back from the
published package. Keep handlers, connections, credentials, and resource
construction out of contract-module imports. Trace the import graph and the
packed consumer to prove this dependency direction without cycles.

Validate untrusted input once at its owning entry point, then pass the parsed
value to typed domain functions. Validate again only for a different semantic
contract, another untrusted source, or a documented runtime guarantee. Every
advertised response variant must match its declared status, body, headers, and
problem schema. Generate API documentation from the registered definitions;
do not maintain a separate handwritten copy of the route and security policy.

Prefer static ESM imports for unconditional dependencies. Use `import()` for
actual lazy loading, optional capabilities, deliberate runtime selection, or
tests of module loading. Prefer `.ts` for project-owned executable logic when
the selected runtime supports TypeScript; keep JS/MJS where the host
contract requires them. Do not convert syntax solely to satisfy a scanner.

Before adding a class, helper, adapter, registry, script, or validation layer,
name its independent caller, failure mode, or lifecycle responsibility. If an
existing supported operation already provides the contract, reuse it instead.

## Runtime ownership and cancellation

Name ownership directly.

- `AbortSignal` communicates cooperative cancellation.
- `Disposable`, `AsyncDisposable`, `using`, `await using`, and disposal stacks
  communicate cleanup and resource ownership.
- An injected resource is borrowed unless ownership transfer is explicit.
- An observable/event stream communicates observation, not ownership,
  cancellation, durability, or authoritative state by itself.
- A Promise for one terminal fact should not be replaced by an event that a late
  subscriber can miss.

Document who closes the resource and what happens when cancellation races with
completion, retries, writes, or disposal.

## Established tool choices

These are strong defaults only where the repository or capability has selected
that ecosystem. They are not reasons to add dependencies to unrelated projects.

### Deno and Web APIs

Prefer the same production TypeScript source across supported runtimes. When
semantics are equivalent, prefer:

1. Web platform APIs.
2. `@std/*` packages.
3. Existing focused utility contracts verified from the consumer's resolved exports. Use `use-utils` for the public `okikio/utils` source and verify publication separately.
4. Established focused third-party libraries.

Keep Deno-specific process, permission, filesystem, and stdout/stderr behavior
behind adapters when a library is intended to work in Node, browsers, workers,
or Bun too.

### LogTape

When LogTape is the repository logger:

- libraries emit structured records; applications configure sinks, filters,
  formatters, and routing;
- preserve structured properties instead of interpolating away machine-readable
  data;
- retain successful evidence when it is useful for diagnosis or audit; summaries and rate controls can reduce noisy diagnostic rendering without erasing the underlying record policy;
- use rate controls and lazy expensive properties for hot paths;
- treat redaction as a route-specific data policy: audit the actual logger call sites and the output's audience before applying it; over-redaction can remove the exact non-secret value needed to debug a failure;
- give stable user-requested results, exports, and support bundles their own schema and exposure policy instead of blindly inheriting diagnostic-sink redaction;
- use `@logtape/testing` for logger assertions where applicable;
- keep durable record writers separate from transient diagnostic sinks;
- keep reusable result and diagnostic writers runtime-neutral when code can run outside Deno; do not bake `Deno.stdout` or `Deno.stderr` into a reusable CLI contract;
- retain a project formatter that already communicates the domain well rather than replacing it with `@logtape/pretty` only for ecosystem conformity; treat the pretty package as a useful reference or fallback, not an automatic replacement;
- in current LogTape 2.3.x, a plain `Sink` is synchronous; use `AsyncSink` with `fromAsyncSink()` when reusable output requires asynchronous I/O or backpressure, and close it through the asynchronous logging lifecycle.

### Optique

When Optique owns a CLI, let it own token grammar, choices, aliases, typo suggestions, help, completion, manuals, and parser-visible source composition. Use `@optique/logtape` when its logging grammar fits the repository instead of duplicating level, verbosity, destination, or format parsing in a second option system. Optique is project-selected rather than a universal runtime dependency; a project that deliberately owns a native parser keeps that parser authoritative.

### Unplugin and build-tool ecosystems

Treat Unplugin, Oxc, and similar tool families as ecosystems to inspect before building custom adapters. When a repository has selected Oxc for parsing, transforms, linting, or build work, reuse that maintained owner instead of introducing Babel or another parallel compiler stack without a concrete capability gap. Reuse maintained Unplugin integrations when they match the actual host and behavior. Do not add either ecosystem solely because another project uses it. Verify generated output and the actual runtime/build path.

### mise

When a repository uses Mise as its task/CI authority, prefer small shell
file tasks that directly invoke the selected tool or a real project-owned CLI.
Use Mise dependencies for composition, not a second Python/JavaScript task
planner. Keep substantive reusable logic in its owning TypeScript package or
focused CLI instead of growing `.mise/lib/` or a parallel `scripts/` tree.

Each required GitHub Actions check must name the concrete change-induced failure
it prevents. Keep ordinary type, focused behavior, and relevant artifact gates
separate from optional performance experiments and production apply/approval.
A green source-preview task does not prove a published package or deployment.

## Tests, benchmarks, and completion

A green type check is not completion.

Use the repository's canonical gates. For the current Deno-first projects, the
complete changed-surface review can include:

- formatting;
- linting;
- strict type checks;
- `node:test` tests with `@std/expect` where that is the repository test model;
- Deno runtime tests and permission checks where Deno behavior matters;
- browser/worker/Node/Bun probes for claimed runtimes;
- conformance and differential suites for parsers/protocols;
- `mitata` or repository benchmark suites for performance claims;
- builds, bundles, compiled artifacts, package tarballs, and clean consumers;
- generated output and documentation validation;
- runtime smoke tests and the actual user flow;
- resource cleanup, cancellation, retry, recovery, and retained-memory checks
  when the change affects lifecycle.

For large-scale data or crawler work, test the representative data shape and
volume, not only tiny fixtures. Keep benchmark correctness oracles and raw
samples when the benchmark can influence architecture.

Report each check as `passed`, `failed`, `blocked`, or `not applicable`. Do not
collapse blocked verification into success.
