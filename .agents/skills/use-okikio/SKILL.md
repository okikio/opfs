---
name: use-okikio
description: Research, select, integrate, review, or debug standalone Okikio libraries including Undent, Observables, SPARQL, Wikitext, OPFS and related RDF/media packages. Verify versioned exports, source, maturity, runtime and ownership before using an API. Use use-utils for the separate okikio/utils workspace and its Context, Task, Workflow, Server, HTTP, Schema and resource packages.
---

# Use verified Okikio libraries

Read [software quality](../../guides/software-quality.md) and the applicable
[standards](../../guides/applying-standards.md). Select only the reference needed
for the current decision. This skill supplies package knowledge; the domain
skill owns the implementation and final verification.

## Establish identity and status

Resolve the exact spelling, repository, version or source commit, public export,
license, runtime and consumers. Start with [package evidence](references/packages.md).
Remembered names, target designs and old examples are discovery leads.

Keep these evidence classes distinct:

- **verified release:** registry version and artifact exports were inspected;
- **verified source:** implementation exists at an immutable source revision;
- **experimental:** the implementation or owner declares incomplete behavior;
- **documented target:** a plan describes behavior not yet established in code;
- **historical or unresolved:** the source is old or unavailable for this task.

A public repository does not prove publication. A successful type check does not
prove runtime compatibility. Inspect generated artifacts before describing
consumer exports, and recheck dated version observations before upgrading.

The standalone `@okikio/observables` package supplies Observables and EventBus.
The separate [okikio/utils workspace](https://github.com/okikio/utils) reuses it
for Context state and input observation. Use [use-utils](../use-utils/SKILL.md)
for that workspace's packages; the shared scope does not merge their ownership.

## Integrate the smallest useful capability

1. Trace exports through implementation, tests and a real consumer. Mark
   internal helpers and unimplemented design proposals explicitly.
2. Compare the consumer's existing schema, logging, configuration, resource,
   workflow and packaging owners. Replace an owner only when the task requires it.
3. Preserve ownership of injected resources. Trace cancellation, unsubscribe,
   disposal, partial construction and cleanup errors separately.
4. For parsing, choose the least expensive useful representation: text/bytes,
   tokens/events, retained tree, then findings. Do not build a full tree for a
   question that source spans or events can answer.
5. For storage, inspect actual provider capabilities, limits, partitioning,
   durability and lifecycle. An adapter name does not establish filesystem parity.
6. For RDF/SPARQL, separate data model, serialization, query building, transport
   and engine execution. Keep trusted raw fragments away from untrusted values.
7. Exercise import/type inference, success, failure and cleanup in the required
   runtime. Check built packages when availability or distribution is claimed.
8. If source is unavailable, identify the missing inspection and give a bounded
   plan without inventing imports or claiming the integration is complete.

## Read by contract

- [packages](references/packages.md): identity, evidence, release and integration checks.
- [undent](references/undent.md): interpolation, newline and display-width behavior.
- [observables](references/observables.md): subscriptions, errors, backpressure and interop.
- [sparql](references/sparql.md): query construction, safe mapping and execution ownership.
- [wikitext](references/wikitext.md): tokens/events/trees, source spans and maturity limits.
- [opfs](references/opfs.md): provider capabilities, adapters and lifecycle.
- [rdf](references/rdf.md): RDF/SPARQL package composition, conformance and streaming.
- [media patterns](references/mediad.md): media parser costs and explicit ownership.
- [backend composition](references/backend.md): combine standalone libraries with current utility contracts.
- [workflow composition](references/workflows.md): distinguish observations, local work and durable execution.
- [resource index](references/resources.md): conditional navigation.

Report the exact evidence checked, behavior exercised and remaining limits.
Do not present an Observable as a durable event log, a query builder as a database
engine, or a source-only package as an installed release.
