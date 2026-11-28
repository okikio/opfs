# RDF and SPARQL Architecture

Use this reference for the recurring RDF, RDF-star, SPARQL, JSON-LD, RDF/XML, canonicalization, triplestore, and query-client architecture developed in recent Okikio work.

## Core rule

Build the standards-facing core independently. External engines and comparison libraries may be used for adapters, differential tests, conformance comparison, and benchmarks, but must not become hidden runtime dependencies of a from-scratch implementation unless the package is explicitly an adapter.

This distinction is essential:

```text
core RDF/SPARQL package
  no comparison-engine runtime dependency

adapter package
  intentionally wraps an external engine

test / benchmark
  may compare against maintained alternatives
```

## Namespace-oriented APIs

Use coherent namespace imports to keep operations short where the package design supports it:

```ts
import * as rdf from '@okikio/rdf';
import * as sparql from '@okikio/sparql';
```

Avoid repeating the package noun in every function name. Schemas/types follow the normal `Schema`/`Type` roles.

## Standards and representations

Keep separate packages or modules for genuinely distinct standards/capabilities rather than one giant RDF utility module. Candidate concerns include:

- RDF data model and terms;
- N-Triples/N-Quads/Turtle/TriG parsing and serialization;
- RDF/XML;
- JSON-LD;
- RDF Dataset Canonicalization;
- SPARQL syntax/query construction;
- SPARQL protocol/client behavior;
- local triplestore/indexes;
- optional query engines/adapters.

The exact package graph must be derived from current source, not assumed from this list.

## Streaming and data-oriented parsing

For syntax-heavy formats, favor staged representations:

```text
bytes / code points
      |
      v
tokens / events / spans
      |
      v
RDF terms / quads
      |
      +--> streaming consumer
      +--> serializer
      +--> store/index
      `--> higher-level model
```

Avoid building an AST/tree when an event or quad stream answers the caller's need. Preserve spans/diagnostics for malformed input where practical.

Internal scanner tables, escape handling, namespace/base state, blank-node state, recursion limits, and recovery rules need documentation because they carry protocol invariants.

## Blank nodes and process identity

Blank-node labels that must not collide across independent parser/store processes need a scope/entropy strategy. Do not assume an input-local counter provides global uniqueness when values can be merged across process instances.

State the exact scope promised by the API.

## Stores and atomic publication

For persistent stores, distinguish body writes from the metadata/commit point that makes them authoritative. Avoid a failure mode where a torn write permanently blocks later progress.

When old generations are retained for in-flight readers, model retirement and collection explicitly. Do not delete data still reachable by active readers merely because a new generation published.

## SPARQL clients

Network clients need bounded response bodies and streaming-aware limits. Applying a byte limit only after buffering the whole response does not protect memory.

Keep query construction separate from execution when that improves reuse and testability. Preserve typed/structured result handling rather than making every query return an untyped JSON blob.

## Conformance

Standards implementations need official or recognized conformance suites where available. Record:

- suite revision/commit;
- number of discovered tests;
- pass/fail/skip counts;
- unsupported feature categories;
- parser/store/client layer responsible for each failure;
- comparison implementation results when used.

Do not modify expected results or normalize away failures merely to improve a pass rate. Runner correctness is part of conformance correctness.

## Differential tests and benchmarks

Comparison libraries are useful for:

- output equivalence;
- parse/serialize round trips;
- query result comparison;
- canonicalization results;
- malformed-input behavior;
- performance baselines.

Ensure comparisons use the same inputs and semantics. If one library eagerly materializes a graph and another streams quads, report the semantic/cost difference instead of publishing a misleading single throughput number.

## Public inference and generated contracts

If schemas generate public types or Standard Schema-compatible interfaces, test consumer inference with compile fixtures. Generated artifacts must have one source authority and a freshness/reproducibility check.

## Verification

A mature RDF/SPARQL change can require:

- parser/serializer unit and round-trip tests;
- malformed/adversarial input tests;
- official conformance suites;
- differential tests against maintained alternatives;
- store atomicity/recovery/concurrency tests;
- network byte/cancellation tests;
- type-inference fixtures;
- Mitata benchmarks and memory measurements;
- Deno, Node, browser/worker runtime checks where claimed;
- exact package artifact/consumer verification.

Compilation alone is not a meaningful completion signal for a standards implementation.
