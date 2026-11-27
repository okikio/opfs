# `@okikio/sparql` 0.0.2

## Contents

- Status and layers
- Values and expressions
- Graph patterns
- Query construction
- Updates
- Executor interface
- Safe public query mapping
- Federation and engine differences
- Failure signatures
- Verification
- Sources and freshness

## Status and layers

JSR reports `@okikio/sparql` 0.0.2 as the latest release on 2026-07-17. It is a type-safe SPARQL 1.1 builder for Deno, Node, Bun, browsers, and workers. Version `0.0.2` is early: pin it and inspect exports before upgrades.

The public documentation describes three layers:

1. values/terms and expressions;
2. composable graph patterns;
3. complete fluent query/update builders and execution.

Reviewed consumer utilities additionally import executor symbols from `@okikio/sparql/executor`, establishing that subpath for 0.0.2 consumers:

```ts
import { raw, select, triple, v } from "@okikio/sparql";
import {
  executeSparql,
  QueryError,
  transformResults,
} from "@okikio/sparql/executor";
```

Do not assume the executor subpath or these exports exist unchanged in another release.

## Values and expressions

Use `v("name")` for variables and fluent value expressions. Confirmed fluent/standalone capabilities include:

- comparisons: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`;
- boolean composition: `and`, `or`;
- arithmetic: `add`, `sub`, `mul`, `div`, `mod`;
- math: `abs`, `round`, `ceil`, `floor`;
- strings: `concat`, `strlen`, `ucase`, `lcase`, `contains`, `startsWith`, `endsWith`, `regex`, and standalone `substr`;
- conditionals: `ifElse`, `coalesce`;
- checks: `isNull`, `isNotNull`, `isIri`, `isBlank`, `isLiteral`, `bound`;
- aliasing: `.as("name")`;
- aggregates demonstrated through `count()` and `avg(...)`.

```ts
const finalPrice = ifElse(
  v("inStock").eq(true),
  v("basePrice").mul(0.9).round(),
  v("basePrice").add(10),
).as("finalPrice");
```

Core conversion escapes string literals and formats numbers/dates according to the package. Verify exact RDF datatype/language behavior for application values; JavaScript string conversion does not prove the desired RDF term.

Treat `raw(...)` as trusted SPARQL text. Building `IN`, `NOT IN`, range or cursor predicates by concatenating term `.value` strings can bypass escaping and datatype serialization. Use verified term/expression helpers and allowlisted fields. Never put untrusted values into raw query text.

## Graph patterns

Confirmed pattern styles compose:

```ts
triple("?person", "foaf:name", "?name");
```

```ts
node("product", "schema:Product", {
  "schema:name": v("name"),
  "schema:publisher": node("publisher", "schema:Organization", {
    "schema:name": v("publisherName"),
  }),
});
```

```ts
match(
  node("person", "foaf:Person", { "foaf:name": v("name") }),
  rel("person", "foaf:knows", "friend"),
  node("friend", "foaf:Person", { "foaf:name": v("friendName") }),
);
```

The `cypher` template tag provides visual ASCII-like path syntax that compiles to SPARQL triples. Use it only with verified pattern objects and static relation syntax; it is not a Cypher database query and must not accept arbitrary user interpolation.

Property-path helpers demonstrated by primary docs:

- `zeroOrMore(predicate)`;
- `sequence(...predicates)`;
- `alternative(...predicates)`.

Also confirmed: named graph `graph(...)`, federated `service(...)`, and nested `subquery(...)` patterns.

## Query construction

Basic select:

```ts
const adults = select(["?name", "?age"])
  .where(triple("?person", "foaf:name", "?name"))
  .where(triple("?person", "foaf:age", "?age"))
  .filter(v("age").gte(18))
  .orderBy("?name")
  .limit(100);

const text = adults.build();
const result = await adults.execute({ endpoint });
```

Confirmed fluent clauses/examples include:

- repeated `.where(...)`;
- `.filter(...)`;
- `.bind(expression.as(...))`;
- `.groupBy(...)` and `.having(...)`;
- `.orderBy(variable, direction?)`;
- `.limit(...)` and consumer evidence for `.offset(...)`;
- `.fromNamed(...)`;
- subqueries, named graphs, and services;
- `.build()` and `.execute({ endpoint })`.

The package page claims full SPARQL 1.1 support and exposes hundreds of symbols. Do not infer an exact factory name for ASK, CONSTRUCT, DESCRIBE, dataset clauses, or every update form from that claim alone; inspect 0.0.2 symbols/tests before use.

## Updates

Primary docs demonstrate `modify()` with delete/insert/where and `.done()`:

```ts
const incrementAge = modify()
  .delete(triple("?person", "foaf:age", "?oldAge"))
  .insert(triple("?person", "foaf:age", v("oldAge").add(1)))
  .where(triple("?person", "foaf:age", "?oldAge"))
  .where(filter(v("oldAge").gte(0)))
  .done();

await incrementAge.execute({ endpoint: updateEndpoint });
```

Updates require separate authorization, endpoint capability, graph ownership, idempotency, timeout, audit, and partial-failure semantics. A builder prevents some syntax defects; it does not make arbitrary graph mutation safe.

## Executor interface

The dated reference identifies these executor names. Verify each against the resolved package artifact before using it; consumer code alone does not establish a public export:

- `BindingMap` and `QueryResult<T>` types;
- `executeSparql(...)`;
- `transformResults(...)`;
- `QueryError` with `kind`, message, query, and optional status.

Separate:

```text
domain QuerySpec
  -> approved fields/predicates/operators
  -> SPARQL builder
  -> safe query text + bounded preview
  -> executor (endpoint, timeout, cancellation, credentials)
  -> media type/status parsing
  -> binding transform
  -> domain result
```

Map errors by stable kind/status. Define separate policy for a timeout, rejected upstream credentials and rate limiting; the HTTP response depends on which system owns the failure. Do not expose the full query when it can contain sensitive literals; keep a redacted, length-bounded preview.

Verify whether `.execute(...)` and standalone `executeSparql(...)` share configuration and result behavior. Pick one owner per application layer.

## Safe public query mapping

For API filters/sorts:

1. validate transport input with Zod/Standard Schema;
2. map public fields to approved variables/predicates;
3. apply server-owned tenant/graph/base patterns first;
4. map operators to builder expressions;
5. serialize values through package term/value APIs;
6. add a stable sort tie-breaker;
7. encode a cursor bound to sort/filter context;
8. bound limit, timeout, result bytes, and graph complexity;
9. keep updates unavailable unless explicitly authorized.

Never accept a predicate, service endpoint, graph IRI, variable name, raw filter, or update fragment directly from an untrusted request.

Preserve the cursor value's RDF datatype and precision. For example, a timestamp cannot be reduced to `xsd:date` without changing comparisons. Use verified typed-literal helpers; otherwise isolate the serializer and test escaping, timezones and comparison behavior against the target engine.

## Federation and engine differences

`service(endpoint, pattern)` emits federated SPARQL, but the target engine controls support, timeouts, credentials, result limits, and SSRF risk. Never let a browser/user choose arbitrary service endpoints.

QLever, Blazegraph, Virtuoso, Fuseki, and other engines differ in extensions, update support, inference, full-text search, optimizer behavior, and protocol details. Inspect the deployed engine, dataset, and endpoint. A repository README naming Blazegraph does not prove a current QLever deployment behaves the same.

Define namespace/prefix ownership and collision behavior. Preserve RDF term identity, datatype, language tags, blank-node scope, and graph provenance through result mapping.

## Failure signatures

| Signature | Likely defect | Correction |
|---|---|---|
| filters allow injected syntax | `raw` concatenates untrusted value/field | native term builder plus allowlist |
| cursor repeats/skips | order lacks deterministic tie-breaker | compound order/filter and context-bound cursor |
| query works on one engine only | extension/inference assumed standard | engine compatibility fixture |
| result loses datatype/language | binding flattened to string | typed binding/domain transform |
| authorization filter missing | base patterns applied after/optionally | server-owned mandatory scope |
| timeout leaves request alive | AbortSignal not propagated | executor cancellation test |
| logs expose secrets/query literals | raw query logged | redacted bounded preview |
| update modifies wrong graph | graph/endpoint authority unclear | explicit graph and permission contract |
| service clause reaches internal URL | user-controlled federation | endpoint allowlist/disable federation |

## Verification

- assert exact `.build()` output for triples, nodes, paths, filters, binds, groups, subqueries, graph/service, and updates;
- test string escaping, Unicode, IRIs, dates, datatypes, language tags, blank nodes, and malicious values;
- test every approved filter/operator without `raw` interpolation;
- execute against the actual QLever/Blazegraph/etc. versions;
- test empty/optional/missing bindings and transform behavior;
- test timeout, abort, 401/403, 429, 5xx, malformed media, and huge result;
- test cursor stability under concurrent changes;
- test tenant/graph isolation and federation endpoint allowlists;
- test update authorization, idempotency, and audit;
- pin 0.0.2 and rerun export/SQL goldens before upgrade.

## Sources and freshness

Reference scope: [JSR `@okikio/sparql@0.0.2`](https://jsr.io/@okikio/sparql/0.0.2), a dated experimental API reference. This refresh does not establish a newer release or verify all executor names against a current artifact. Confirm the exact export map, declarations and implementation before copying code. Test endpoint-specific SPARQL behavior against the actual engine; query construction does not establish authorization or transport behavior.
