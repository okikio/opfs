# OPFS expansion: implementation plan and review handoff

Updated 5 November 2026 for the OPFS maintainer, contributors and independent extension authors. This edition plans
implementation; it adds no production support, dependencies, exports or benchmark results. It retains the previous
storage/provider program and expands archive, encryption and third-party extension contracts.

A representative outcome is: upload a large archive to GCS, resume after an app restart, browse its entries, then
preview one member under an explicit byte/memory budget. The application can use first-party storage with a third-party
archive reader or codec. It sees when the source must be scanned, a key is missing, authentication requires more work,
or a format is unsupported. No hidden full extraction or download is allowed.

## Read and decide

| Document                           | Task                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [PLAN.md](PLAN.md)                 | Follow the ten delivery waves, native GCS/Azure/S3/tus decisions, ownership and first vertical proof        |
| [EXTENSIONS.md](EXTENSIONS.md)     | Design an independent driver, adapter, reverse bridge, codec or format package using public seams           |
| [PREVIEW.md](PREVIEW.md)           | Understand listing, prefixes, selected ranges, authentication, recovery and shared budgets                  |
| [ENGINEERING.md](ENGINEERING.md)   | Implement source layout, pure/effect boundaries, comments, examples, tests, benchmarks and release evidence |
| [RESEARCH.md](RESEARCH.md)         | Check reuse decisions, primary sources, the Node loader finding and evidence limits                         |
| [validation.json](validation.json) | Inspect the checks performed on this planning artifact                                                      |

Start implementation with wave0: revision-bound byte sources, read-only admission, operation ownership/budgets, transfer
checkpoints and independently usable extension contracts. Prove those seams through the GCS/upload/ZIP workflow before
broad provider expansion. External-author examples and conformance fixtures must work against the packed public package,
with no private imports. Proposed API names remain proposals until that proof settles them.

Three decisions guide the expansion:

- Keep optional subpath exports and explicit composition. No automatic plugin registration, credential discovery, codec
  download or eager provider import. Independently useful native protocol clients sit below drivers and filesystem
  projection.
- Treat archive preview as independent operations with measured work and exact integrity scope. Listing is not
  extraction; a small plaintext prefix can require full-member authentication. The default encrypted-preview path
  releases no unauthenticated plaintext.
- Prefer Web APIs, suitable `@std` components and reviewed personal code, while retaining the option to implement
  missing protocol/format mechanics. Every selected dependency, copied implementation and WASM binary still needs
  provenance and an inspectable graph. From-scratch cryptographic framing requires independent interoperability and
  security review.

## Coverage without inflated support claims

The unchanged parent [catalog.json](catalog.json) has **895 records**. [routing.json](routing.json) and
[routing.csv](routing.csv) preserve their provisional owners and delivery waves. These include providers, protocols,
behaviors, views, tools and references, rather than 895 drivers.

The new focused input [formats.json](formats.json) contains **136 archive/encryption/related records**;
[implementations.json](implementations.json) contains **14 implementation comparisons**.
[crosswalk.json](crosswalk.json) preserves their relationship to the parent catalog.
[preview-routing.json](preview-routing.json) retains each focused source record verbatim and assigns proposed access,
trust, ownership and test routes. These counts must not be added together as unique supported backends. Routing is
architectural triage, not an interoperability certification.

The attached reviews are retained as [archive-research.md](archive-research.md),
[catalog-research.md](catalog-research.md) and [protocol-research.md](protocol-research.md). Newly researched
qualifications are in [preview-research.md](preview-research.md) and [bundlejs-research.md](bundlejs-research.md). Newer
qualifications in this edition govern the plan where supplied research is broader or older; source records themselves
are unchanged.

## Evidence and ownership

The original handoff's source baseline is `14967334aee6b0f1815eecc1437fa9f174b97bb5` on `codex/release-2026-10-06`. The
planning inputs are now tracked in this repository, so a clone contains the handoff. This baseline identifies the
historical proposal; current source and capability guides establish implemented behavior. The TypeScript validator
replaces the old Python command; its unchanged predecessor remains inert as `validate.py.snapshot` for provenance.

The OPFS maintainer owns public contracts, conformance suites and first-party releases. Each extension publisher owns
its dependencies, exact protocol/profile claims, fixtures and compatibility window. Applications own credentials, key
policy, installed extension choices, rendering, host capabilities and accepted budgets. The caller must be able to
distinguish unsupported, not yet verified and verified-under-specific-conditions behavior.

Completion of planning means the work is routed, sequenced and reviewable. Completion of implementation requires the
focused, runtime, packed-package, interoperability, recovery and applicable live-service gates in the plan. Artifact
checks do not prove those future behaviors, security or performance.

To check an unpacked handoff, run `node validate.ts` from this directory. It uses only Node built-ins and checks counts,
identities, crosswalks, proposed-status labels and local Markdown links. Optional original-input comparisons are
documented in [validate.ts](validate.ts). [validation.json](validation.json) records the original-input comparisons
performed for this edition and file digests; it does not certify remote URLs, source behavior or security.
