---
name: explore-ecosystems
description: Investigate a material library, framework, tool, protocol, service, or standard as a possible monorepo or wider ecosystem before selecting, integrating, replacing, upgrading, or recommending it. Use when sibling packages, official adapters, plugins, companion repositories, specifications, releases, or adjacent systems could change the decision. Do not use for incidental imports or a purely local edit with no dependency decision.
---

# Explore ecosystems

## Reading boundary

Minimum: read this entrypoint and the linked shared software-quality contract.
Read resources explicitly marked required for the operation; for long guides,
read the applicable sections before making that decision. Use other references
only when they resolve a decision actually in scope. Do not read an entire tree
or recursively select every companion to prove diligence. Recover truncated
required reads. Stop expanding context when the applicable rules and source
behavior are understood; report any material unavailable guidance.

## Shared obligations and companion selection

Read [software quality](../../guides/software-quality.md) before this capability's work.
Comments, docs, naming, imports, readability and correctness are explicit duties
even when no companion is separately selected. Read the applicable detailed
sources linked there before judging those decisions; recover truncated required
reads. The selected capability and real domain/runtime owners share one plan
and verdict. Read this entrypoint and the shared contract first. Read linked detail only
when its decision is in scope; stop when the applicable contract is understood.
Do not recursively load companion skills or historical material for reassurance.



## Select the complete task

Read [applying standards](../../guides/applying-standards.md) before domain work.
Select companions by the contracts being changed, with one discovery pass,
plan, and verdict. For repository work, use the shared quality contract when installed
for naming, schemas, tests, documentation, validation, and completion. Apply
rules by purpose; test-runner imports and trivial private fixtures are not
public runtime APIs. If a companion is absent, use the bundled compact defaults
and inspect local instructions rather than inventing unavailable guidance.

Treat every material dependency as an **ecosystem hypothesis**. Investigate the
hypothesis. Do not turn it into the false claim that every package belongs to a
monorepo or that every sibling should be installed.

This skill owns dependency identity, topology, capability ownership, source
strength, alternatives, exclusions, compatibility evidence, and integration
selection. the shared quality contract owns edits and completion. Domain skills own the
actual implementation semantics once a dependency choice is made.

## Outcome

Produce a source-backed decision map:

```text
exact target identity
      |
      v
canonical owner/repository/org
      |
      +--> workspace siblings
      +--> official adapters/plugins
      +--> companion repositories
      +--> standards/specifications
      +--> alternatives
      |
      v
capability ownership + constraints
      |
      v
smallest coherent selected set
      |
      v
integration and executable proof
```

Every material recommendation should state what was verified, what was inferred,
what was excluded, and what remains unresolved.

## Materiality and stopping

Use two investigation levels:

1. **Cheap identity check for every material dependency in scope.** Inspect the
   installed manifest/lockfile identity and canonical repository or organization
   metadata. Record standalone, monorepo, multi-repo ecosystem, plugin/spec
   ecosystem, or unresolved status.
2. **Deep mapping only when the decision can change.** A dependency is material
   when its selection/integration can affect architecture, runtime/host support,
   public contracts, security, operations, generated artifacts, deployment,
   licensing, or verification.

Stop when capability ownership, compatibility, deliberate exclusions, and
verification evidence are sufficient for the named decision. More browsing is
not automatically better research.

## Evidence ladder

Prefer evidence by the claim being made:

1. current installed/exported source and executable tests;
2. current official documentation/specification and canonical repository;
3. release/changelog/registry metadata;
4. issue/discussion/PR evidence for unresolved or emergent behavior;
5. reputable secondary material for context;
6. memory only as a search hint.

A README may describe an API that is no longer exported. A recently uploaded old
archive may have a new file timestamp. Use content and executable behavior, not
metadata alone, to establish freshness.

## Procedure

1. **Name the decision.** State the capability or trade-off the research must
   resolve before searching, and the customer outcome it affects. Use the
   [product experiment method](../../guides/product/experiments.md).
2. **Resolve exact identity.** Package name, repository, organization, version,
   license, runtime, manifest exports, and active consumers.
   As soon as source and docs identify a useful public operation, run the
   smallest authorized direct probe. Do not postpone all execution until the
   topology survey ends. Timebox research and experiments according to their
   cost and uncertainty, and let observed behavior change the next question.
3. **Map topology.** Discover verified workspace siblings, official adapters,
   plugins, presets, integration packages, companion repos, standards, and
   protocol implementations. Classify every edge.
4. **Map capability ownership.** Determine which component owns parser,
   transport, configuration, schema, persistence, rendering, observability,
   release, or other needed behavior. Do not choose packages by brand proximity.
5. **Inspect compatibility and lifecycle.** Runtimes, frameworks, deployment,
   resource ownership, cancellation/disposal, security, configuration, and
   operational constraints.
6. **Compare alternatives under fixed criteria.** Establish criteria first,
   rank options, gather additional evidence, then reassess the ranking using the
   same criteria to avoid recency bias.
7. **Record exclusions.** Explain why obvious siblings/alternatives are not
   selected. Exclusion is part of a trustworthy ecosystem map.
8. **Prove the material claim.** Use source/tests/minimal integration/clean
   consumer where possible. This continues the early research/experiment loop;
   it is not the first opportunity to execute. Keep documentation claims,
   observed behavior, blocked setup, and untested integration distinct. Capture
   relevant timing, resource scope, failures, and raw output using
   [metrics](../../guides/product/metrics.md). Mark unresolved claims honestly.
9. **Hand implementation a bounded contract.** Exact packages/versions,
   integration owner, configuration/resource/lifecycle seams, expected failures,
   and verification steps.

## Anti-hallucination rules

- Similar names do not establish a relationship.
- Same organization does not mean same runtime contract or recommended bundle.
- A monorepo package is not public merely because source exists.
- An adapter file does not prove a stable exported adapter.
- Type compatibility does not prove runtime support.
- Experimental/prerelease code does not become stable because documentation is
  polished.
- Do not infer support from framework branding. Verify exact renderer/runtime
  bindings.
- Do not invent a missing package or private export to make the proposed
  architecture cleaner.
- Do not search adjacent packages indefinitely after the decision is resolved.

## Integration handoff

Before a selected dependency is implemented, provide:

- exact dependency and owning package;
- version/stability evidence;
- public import/export surface;
- configuration and environment ownership;
- resource lifetime and cleanup;
- errors/retries/cancellation where material;
- runtime and deployment requirements;
- coexistence/removal plan for the current owner;
- tests/fixtures/clean-consumer checks that prove the integration.

## Reference routing

- [evidence.md](references/evidence.md): identity, source strength, freshness,
  provenance, contradictions, claim ledgers, and executable evidence.
- [topology.md](references/topology.md): monorepos, multi-repository ecosystems,
  plugins, standards, relationship taxonomy, and discovery algorithm.
- [selection.md](references/selection.md): capability ownership, alternatives,
  hard gates, comparative criteria, maturity, portability, and supply-chain cost.
- [integration.md](references/integration.md): dependency/manifests, vertical
  integration, configuration, lifecycle, failure paths, and connected surfaces.
- [failures.md](references/failures.md): research and integration failure
  signatures, false relationships, missing exports, and recovery.
- [method.md](references/method.md): reusable decision/capability/evidence
  worksheet and stopping process.

## Completion gate

Ecosystem research is complete when the requested decision can be made from
traceable evidence, material alternatives and exclusions are explicit, version
and runtime constraints are known, no public API was invented, and the selected
integration has executable verification steps. Unresolved material claims remain
listed as unresolved rather than being averaged into a confident conclusion.

## Resource navigation

The [complete resource index](references/resources.md) lists this capability’s maintained detail and assets. Use it only to
locate a decision-specific resource; it is not a reading checklist.

## Project procedures

When the project adopts this playbook, use its procedure and evidence gates: [Task prompts](../../handbook/tasks/README.md).

For any project using the pack, see [Product development](../../handbook/product/README.md).
