# Sources, reuse decisions and verification limits

This memo explains what changed in the 5 November plan and lets another maintainer reproduce the decisions without the chat. The attached checkpoint is research input, not repository policy, implemented support or independent verification of every record. Canonical skills and repository instructions govern the workflow; source code and exact specifications govern factual claims.

## Existing personal archive work

Reviewed [bundlejs-api](https://github.com/okikio/bundlejs-api/) at `34be097f00db4bf179b1dc08fc405dcad146905f`. The [detailed source memo](bundlejs-research.md) pins its links and distinguishes source findings from executed tests. Its detection evidence, strict metadata parsers and precompiled-WASM injection are candidates for deliberate adaptation. Its application TAR plugin extracts complete members into a build VFS, and its compression facade returns whole buffers; neither is an existing selected-member preview engine.

Before adaptation, fix and test potential abandoned tee-branch retention, implicit whole-buffer materialization, instance ownership and unsupported native-codec fallback. These are source review findings, not executed regressions. Preserve licenses and provenance for copied source. The private `0.0.0` workspaces were not established as published personal packages; embedded upstream WASM remains third-party code requiring its own origin/build/digest review.

Do not import the build server, package resolver or VFS to acquire a small parser. Decide between a narrow published module, a documented attributed extraction, or a new bounded parser after measuring the actual dependency graph and testing equivalent behavior. Personal authorship is permission to evaluate reuse, not proof of streaming, security or package stability.

## Standards, packages and optional runtimes

[Deno std](https://github.com/denoland/std) is a preferred source of suitable components. [JSR](https://jsr.io/) is a registry, not an approval of every namespace on it. Pin exact selected versions and inspect their actual transitive dependencies and runtime APIs. Native Compression Streams supplies specific codecs, not ZIP containers or encryption envelopes. WebCrypto supplies primitives, not a complete streaming file format.

The inspected std TAR main manifest reported `0.1.10`; its reader documents unstable ustar support with a numeric-size extension. It must not be advertised as a complete PAX/GNU/sparse TAR implementation without additional work. Entry cancellation drains sequential content; it is not free random access. Use it for a constrained route if its supported profile and accounting fit. Main-source observations must be rechecked against the exact release selected for implementation. See the pinned source discussion and current-main links in [bundlejs-research.md](bundlejs-research.md).

The Node API recalled in the request is [`process.getBuiltinModule()`](https://nodejs.org/api/process.html#processgetbuiltinmoduleid). OPFS already resolves `node:fs`, `node:fs/promises` and `node:stream` through it in the Node driver's construction path (`src/driver/node.ts`). An isolated local Node `v26.13.0` probe confirmed the loader is available, loads `node:fs`, and returns undefined for an unknown built-in. This probe does not test the OPFS driver or establish compatibility with older runtimes.

`globalThis.process` and `globalThis.Deno` remain ambient capabilities. Pure parsers/planners must receive explicit inputs and never acquire them; an explicit runtime factory may acquire supported host APIs and pass narrow ports inward. Do not broadly rewrite the current host drivers merely to change spelling. Keep import safety, runtime acquisition and operational effects separate and test each. Type-only imports do not load host modules at runtime. Static versus dynamic optional imports is a packaging choice to verify in built consumers, not an automatic purity guarantee.

## Format constraints that change preview behavior

[PREVIEW.md](PREVIEW.md) applies the primary checks recorded in [preview-research.md](preview-research.md): ZIP indexes do not supply arbitrary decoded seeking; whole-member authenticated encryption can require reading all protected ciphertext; solid compression reuses earlier state; encrypted headers can block names; independently authenticated chunks and stateful streaming encryption differ. age and Tink have distinct chunk/segment and finalization rules. The plan now evaluates them as separate exact-profile candidates instead of treating every encrypted stream as one format.

The 136-record routing file is proposed architectural classification. A subset of material specifications was inspected; all 136 records, all 14 implementations and all 895 parent catalog records were not freshly recertified against upstreams or executed. Unsupported/unknown and legacy profiles remain visible. Before implementing a route, pin the specification version, select independent fixtures, review license/primitives and record the precise operation/runtime claims.

## What was checked in this edition

Read the current OPFS driver/adapter/bridge/stream contracts and export map; reviewed the supplied catalogs and research; compared their retained identities and original data; reviewed bundlejs source and selected primary specifications; and ran the isolated Node loader probe. Planning-artifact validation checks preservation, routes, local navigation and the portable archive. Its exact results belong in [validation.json](validation.json).

No new dependency, codec, WASM binary, archive sample, provider account or production implementation was executed. No new OPFS runtime tests, static checks, CI runs or benchmarks establish future support in this edition. The repository restricts memory-heavy local static gates; implementation must use its prescribed serial CI lanes. Earlier CI evidence is not evidence for proposed exports or behavior.
