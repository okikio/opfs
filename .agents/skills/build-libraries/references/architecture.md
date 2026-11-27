# Library architecture and programming models

Use this reference when creating a new library, extracting reusable code from an
application, reviewing a public API, or deciding whether an abstraction is a
library, framework, application service, or internal module.

## Outcome

Produce a programming model that lets a consumer perform meaningful domain work
without constructing the originating application. The public surface should be
smaller than the knowledge and implementation it hides.

## Start from the desired consumer

Write concrete call sites before designing generic machinery:

```ts
import { analyzeDomains } from "@example/analysis";

const result = await analyzeDomains(
  { domains: ["example.com"] },
  { collector, detector, factRepository },
  { signal },
);
```

Add at least one common-case call and one advanced composition call. Read them as
consumer code. The API should communicate domain intent, ownership, cardinality,
async behavior, failure shape, and resource lifetime without requiring knowledge
of the implementation flowchart.

Do not begin with names such as `Runtime`, `Context`, `Stage`, `Executor`,
`Plugin`, or `Manager`. Those names are sometimes justified, but they must earn
their place by describing a product capability rather than hiding unresolved
ownership.

## Use-case first, not chronology first

A CLI or application often performs:

```text
parse -> configure -> acquire -> collect -> verify -> detect -> persist
```

Those are execution phases. They are not automatically module seams. A
chronology-first extraction tends to preserve shared context, hidden sequencing,
and temporal coupling.

Prefer module splits around domain knowledge and change axes:

```text
Domain analysis
  request, result, failures, events, orchestration

Observation collection
  targets, browser/archive adapters, observation contract

Detection
  rule compilation, indexes, batch evaluation

Fact resolution
  evidence combination, contradictions, freshness, confidence

Persistence
  repository contract, artifacts, receipts
```

A module should hide a design decision or body of knowledge that other modules
do not need to understand. Processing steps can remain implementation details or
observable events.

## Place generic mechanics and concrete capabilities deliberately

Use repository context to decide whether reusable code is generic mechanics or a concrete capability. Reusability by itself does not make something a utility.

```text
utils/
  generic programming models and mechanics

packages/
  concrete domain capabilities

clis/ and apps/
  executable composition and product policy
```

A generic retry, resource, stream, context, or capacity model can belong in `utils/`. HLS, RDF, version semantics, a technology registry, or a storage provider remains a concrete package even when several applications use it.

Do not repair ownership problems with `shared/`, `common/`, `misc/`, or `helpers/`. Move the contract to the layer that owns the exact concept.

Use surrounding context to keep APIs short. Project-owned Zod schema constants end in `Schema`; project-owned data types normally end in `Type`; behavior interfaces use the concrete noun. Use Standard Schema only when validator interoperability is the actual generic requirement.

## Separate application and library ownership

A reusable library normally should not own:

- argv, environment, current working directory, project config discovery, or
  interactive prompts;
- terminal formatting, colour, progress bars, stdout, stderr, or process exits;
- application logging configuration, sink selection, or telemetry consent;
- process signal installation;
- deployment-specific dependency selection;
- global singleton lifecycle.

It may accept resolved values and focused capabilities produced by those owners.
It may emit structured domain events and library diagnostics. The application
composition root chooses concrete adapters and owns process lifecycle.

## Design only the contracts the consumer needs

Start with the request and result the caller actually uses. Add typed failures
when callers need to distinguish failures. Add domain events only when there is
a real observation consumer or durable progress contract. A pure function that
returns a value does not need a public event stream, session, registry, or
lifecycle framework merely to satisfy a four-part template.

For an analysis operation that really supports all four concerns, the contracts
might be:

```ts
export interface AnalyzeDomainsRequest {
  readonly domains: readonly string[];
}

export interface AnalysisResult {
  readonly runId: string;
  readonly targets: readonly TargetResult[];
  readonly artifacts: readonly ArtifactReference[];
}

export type AnalysisFailure =
  | InvalidTargetFailure
  | CollectionFailure
  | PersistenceFailure
  | CancellationFailure;

export type AnalysisEvent =
  | AnalysisStarted
  | TargetCompleted
  | CheckpointCommitted
  | AnalysisCompleted;
```

The interfaces above illustrate a conceptual typed-only operation, not a
requirement to define four new records. Simple function parameters and return
types may suffice. For serialized or persisted requests and results, author
project-selected runtime schemas and infer the data types instead of maintaining
parallel interfaces. Do not expose internal stage objects, queues, mutable
contexts, or adapter options merely because the first implementation uses them.

## Deep modules and layered surfaces

A good library commonly offers:

```text
Convenient named use cases
  analyzeDomains()
  analyzeArchive()
  verifyObservations()

Independently useful capabilities
  collectDomains()
  evaluateObservationBatches()
  resolveFactCandidates()
  writeArtifacts()

Private mechanisms
  queues, indexes, buffers, lease schedulers, retries
```

The facade owns a supported composition for common consumers. Lower-level
capabilities remain available where independent use is real. Private mechanisms
remain private so they can change.

Do not create dozens of shallow wrappers whose public surface equals their
implementation. Prefer modules with small interfaces and substantial hidden
knowledge.

## Avoid temporal coupling

This contract hides a state machine:

```ts
await runtime.initialize();
await runtime.collect();
await runtime.verify();
await runtime.commit();
await runtime.finalize();
```

Prefer a named operation:

```ts
const result = await analyzeDomains(request, capabilities, { signal });
```

When lifecycle states are genuinely public, model them as domain operations on a
run or session:

```ts
const run = await client.startAnalysis(request);
await client.inspectAnalysis(run.id);
await client.cancelAnalysis(run.id);
```

Do not make all consumers manually traverse an internal lifecycle.

## Frameworks are valid when the framework is the product

A stage framework, plugin host, compiler pipeline, UI renderer, workflow engine,
or dependency-injection runtime can be the correct library when consumers are
supposed to define execution units and the framework's lifecycle is the public
capability.

Require evidence:

- multiple independent consumers need to define or reorder units;
- third-party extension is an explicit requirement;
- ordering, lifecycle, compatibility, and failure semantics are documented;
- the framework offers meaningful leverage beyond ordinary functions;
- the framework surface is versioned and tested as the product.

Do not create a framework merely to organize code controlled by one repository.

## Justify architecture decisions

Do not defend an architecture split with slogans such as “library first,” “composable,”
“tree-shakable,” or “best practice.” Show the path from the situation to the
decision.

For a material architecture choice, state:

1. the objective or failure condition being protected;
2. hard constraints separately from preferences;
3. the diagnosis and causal mechanism creating the problem;
4. credible alternatives, including inaction, delay, a partial extraction, and a
   reversible pilot where applicable;
5. the exact requirement, risk threshold, or evidence that rejects each weaker
   option;
6. costs, risks, and trade-offs accepted by the chosen design;
7. assumptions and defeaters that would change the decision;
8. whether the result is necessary, conditionally necessary, prudent, or merely
   preferred.

For example, “split every module into a package because libraries should be
tree-shakable” is not a justification. A defensible conclusion may instead be:

```text
Given two independent consumers, a measured cold-start budget, and an optional
browser dependency that dominates the core bundle, expose the browser adapter
through a separate subpath. Keep the remaining internal modules private because
package-level separation would not satisfy another consumer or constraint.
```

Prefer the least disruptive and most reversible dependency split that still satisfies
the protected objective. Record what evidence would invalidate the choice.

## Public compatibility discipline

Treat these as compatibility surfaces:

- exported names and subpaths;
- type relationships and accepted structural values;
- result ordering and cardinality;
- error identity and error timing;
- import-time effects;
- resource ownership and cleanup timing;
- cancellation behavior;
- emitted events;
- serialization formats;
- performance characteristics explicitly promised by the project.

Keep internal types internal. Add an export only when a consumer contract needs
it and the project is prepared to support it.

## Decision questions

Before accepting an abstraction, ask:

1. Which concrete consumers need it?
2. What domain knowledge does it hide?
3. What can change behind it without breaking consumers?
4. Can one capability be used without constructing the whole system?
5. Is the abstraction organizing knowledge or merely restating control flow?
6. Does the common case remain simple?
7. Is advanced composition possible without importing private machinery?
8. Which observable behaviors become compatibility commitments?

## Failure signatures

- a `core` package still reads argv, discovers config, formats terminal output,
  or exits the process;
- every function accepts one giant context containing unrelated capabilities;
- public classes represent phases rather than domain concepts;
- consumers must call methods in an undocumented order;
- the library exports internal queues, stages, and concrete adapters by default;
- a facade is absent, forcing consumers to reconstruct the implementation;
- a framework is created before a second independent extension scenario exists;
- moving files into packages is presented as successful modularization.

## Verification

- compile at least two realistic consumer call sites;
- exercise common and advanced use without application globals;
- test failures and cancellation through the public entrypoint;
- ensure the CLI or service is a client of the same public API;
- remove an internal mechanism or replace an adapter without changing unrelated
  consumer code;
- inspect the published exports rather than source folders alone.

## Sources and freshness

- Library-first guidebook, reviewed 2026-07-23.
- David Parnas, "On the Criteria To Be Used in Decomposing Systems into
  Modules," information-hiding basis.
- Swift API Design Guidelines, clarity at the point of use.
- Semantic Versioning, explicit public API and compatibility discipline.
