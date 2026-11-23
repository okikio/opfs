# Admit the Netlify Blobs fixture without running it

This stage is for maintainers preparing an independent local Netlify Blobs SDK/server oracle. It acquires inert bytes
for one reviewed test-only dependency closure. It does not install the SDK, start its server, approve a production
dependency or claim that a Netlify driver exists. The next implementation decisions remain in the
[Netlify plan](../../../planning/storage/NETLIFY.md).

The root-owned isolated acquisition command is:

```sh
deno task fixtures:netlify --output /output/netlify-inert
```

Use a fresh destination and a separate resource-bounded acquisition lane. The caller owns container memory/swap, CPU,
PID and filesystem ceilings. Acquisition passed in the isolated run described below. Its network access is limited to
exact npm registry URLs and pinned callsite provenance on GitHub. No account credentials are needed. Package code,
lifecycle scripts and build tools are never executed.

`acquire.ts` is the frozen version/edge/SRI authority. Its 46 packages begin with
[`@netlify/blobs@11.1.7`](https://registry.npmjs.org/@netlify/blobs/11.1.7), gitHead
`e85a36b11c821f043ed7d9f4f0c5f79f8c599b76`. Primary registry manifests were read on 2026-11-06. The selected public SDK
and `./server` entrypoints need runtime-utils 3.0.0, dev-utils 6.0.4, otel 7.0.6 and their complete declared
runtime/optional/peer closure. Their own development dependencies are excluded.

The historical partial resolution named 47 package-version metadata records but lost its closure bytes during copyout.
This stage does not treat that receipt as an admitted lock. Each selected package and declared edge was checked again
against primary registry metadata. The intentional difference is using OpenTelemetry API 1.9.1 throughout: it satisfies
the SDK's exact pin, the retained caret ranges and the `<1.10.0` peers. The historical extra API 1.10.0 is not selected.
There is no floating version resolution, npm install, downloaded semver invocation or private SDK import.

Before downloading each archive, the stage requires exact registry identity, SRI, tarball URL and dependency/peer range
declarations. It then compares the archive's SHA512 with the frozen SRI, verifies the packed manifest against those
declarations, and checks that every declared target belongs to the reachable frozen graph. A changed range, extra
optional dependency, nonempty bundled-dependency declaration or missing target fails admission. Updating the SDK means
reviewing this data and its legal evidence again; do not bypass failures by resolving the newest matching dependency.

One ten-minute deadline covers the stage. Metadata is limited to 256 KiB per package and 8 MiB total; archives to 8 MiB
compressed each and 64 MiB total; decompressed archives to 32 MiB each and 96 MiB total. At most 12,000 files are
retained. The shared TAR admission checks checksums, exact termination, duplicates, extents, PAX/long names, canonical
paths and set-ID modes. This stage additionally requires the `package/` root and refuses every hard link and symlink. It
never follows archived links or makes acquired code executable. Five fixed supplemental GitHub responses have separate
per-response ceilings totaling at most 512 KiB. Their hashes and byte counts are retained in `closure.json` alongside
the package inventory.

The result separates original evidence from authored receipts:

| Path                           | Meaning                                                                                                          |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `metadata/*.json`              | Exact registry response bytes, separately hashed in the closure receipt.                                         |
| `archives/*.tgz.snapshot`      | Original compressed package archives with verified SRI and SHA256.                                               |
| `source/PACKAGE/PATH.snapshot` | Every admitted regular file, including manifests and scripts, retained as inert data.                            |
| `legal/PACKAGE/PATH.snapshot`  | Unmodified packaged license, notice, copying and copyright evidence.                                             |
| `supplemental/callsite/`       | Separately attributed upstream-only notice and exact source/tag relationship.                                    |
| `closure.json`                 | Exact package targets, source-file hashes, sizes, exports, main entries, scripts and remaining admission limits. |

Success publishes the staging directory by rename. Failure leaves `DESTINATION.partial` and its failure receipt for
inspection; it does not publish a complete closure. Do not overwrite an old destination or interpret partial output as
success. Metadata responses can acquire new registry fields over time, so their raw hashes are observations of this run.
The frozen package SRI, version and declared edges remain the deterministic identity requirements.

## Preserve the missing callsite notice honestly

The published `callsite@1.0.0` archive contains no standalone license notice and its manifest has no license field. Its
Readme names MIT but does not reproduce the full notice. The stage preserves those bytes and adds an authentic upstream
notice separately:

- [Annotated tag 1.0.0](https://github.com/tj/callsite/tree/1.0.0) has tag object
  `7a245ebbedda09ba425eb39a61912e3bf91c4c73`, pointing to commit `8d3927995821596148e77f4af049ab38b03d1b99`.
- Its [immediate child](https://github.com/tj/callsite/commit/8d7615a28a6507c3ef0731f072d3f1a100b3fe27) adds only
  LICENSE. The tagged and packaged `index.js` both have SHA256
  `948c9c1a2488241caafe25c4f90f5bfe06d3be0942989d74eae821828f31a35b`.
- The [pinned notice](https://github.com/tj/callsite/blob/8d7615a28a6507c3ef0731f072d3f1a100b3fe27/LICENSE) has SHA256
  `52d31bec4bb1a1d6175de0c75d50fcc3f30a5d9f360703a5ce666dc1fe8a6ec8` and Git blob
  `8d7b58570b4c52998727e12c39cfdc98318c90fb`. It carries the upstream author attribution; this repository does not
  invent a notice or insert it into the historical npm archive.

Acquisition checks and retains the tag, annotated tag, notice-only commit, tagged runtime source and license. It does
not turn this source relationship into automatic legal approval. `executableAdmission` remains false until maintainers
review every package's retained notices and explicitly qualify materialization and the offline SDK/server fixture.
Hash/SRI agreement proves byte identity, not trustworthy code, reproducible source builds or a security audit.

## Compare a separately admitted client with the public SDK

The acquisition run `1a62180a-cbeb-4346-9415-e805c4c14156` admitted 46 packages, 2,857 files and 17,973,760 expanded
bytes. Its `closure.json` SHA256 is `1b975c457b7f2a0b890f28325f041cfc5b9f9573f33a4829dc615e13422c1ec9`. After separate
test-only execution review, the SDK/server observation run `3e785505-7179-4e1f-b448-b56ff45cc800` passed. That proves
the pinned local Node SDK exchange, including empty and 128 KiB originals, Unicode GET/HEAD metadata, conditions and a
deliberately lost acknowledgement. It does not establish production service, browser or client support.

The maintained fixture is [tests/provider/netlify.ts](../../provider/netlify.ts); its assertions are in
[tests/netlify-provider.test.ts](../../netlify-provider.test.ts). It starts the reviewed Node image with no external
network, 1 GiB memory/swap, one CPU, 256 PIDs, 32 MiB data tmpfs, dropped capabilities and an unprivileged user. It
checks effective engine limits and mount flags, then awaits server stop and checks its clean exit before removing the
container. Docker transport retirement must settle; the enclosing isolated lane still owns its deadline and emergency
retirement.

The SDK-only `observe()` method needs the admitted closure. `observeCandidate()` additionally requires a standalone
bundle of `src/netlify.ts`, supplied as `{ candidate: { file, sha256 } }`. The fixture checks the complete nonempty
regular file, at most 4 MiB, before copying it to `/fixture/candidate.ts`. The bundle must retain the public client and
error exports and contain its approved dependencies; it must not resolve through the SDK's container modules. Building
the bundle and admitting its hash are separate steps owned by the qualification lane, not by the fixture.

The reciprocal test requires `OPFS_NETLIFY_ARTIFACTS`, `OPFS_NETLIFY_CLOSURE_SHA256`,
`OPFS_NETLIFY_EXECUTION_REVIEWED=11.1.7-test-only`, `OPFS_NETLIFY_CANDIDATE` and `OPFS_NETLIFY_CANDIDATE_SHA256`.
Missing candidate admission fails rather than skipping the comparison. This test passed in isolated run
`bf81a0ee-fb7e-4f89-afe9-b7daee2758e6`, with candidate SHA256
`1b9453b981d441ee74cfc4c69d388a6a40356b2d41396fd2f1ce89605709667b`. It compares SDK-written bytes read by the candidate
and candidate-written bytes read by the SDK, with separately authored expectations. It also checks conditional refusals,
deletion, credential separation and an unknown outcome after exactly one dispatched candidate PUT whose reply is lost.
Both fixture servers retired with exit zero and without Docker's OOMKilled flag. Package-consumer and CI qualification
have separate evidence below; this local profile does not establish production service behavior or a filesystem adapter.

The local server has a pinned prefix-list defect: its keyless API URL parser captures the query in the store name and
then appends another `?signature=` suffix. The test preserves the resulting empty prefix page, requires both objects in
an unfiltered control and checks safe comparisons from the public server request callback. It never logs signed query
values or bearer values. This defect is not a production prefix contract and must not change the client's query
encoding. Every receipt is printed before assertions so a failed observation remains available to the isolated lane.

## Run the same tasks as CI

Use a fresh checkout and output directory in a serial, resource-bounded qualification lane with Docker, the repository's
pinned Deno and Node, and acquired dependencies. The acquisition needs registry/GitHub access. Execution imports only
the reviewed closure inside network-disabled containers; Docker may separately need access to pull the pinned base
image. Review any changed closure inputs and notices before setting the execution grant. Computing a hash identifies
bytes; it does not review their contents.

The [Netlify CI job](../../../.github/workflows/ci.yml) runs this task sequence. Replace `.tmp/netlify-inert` with a
fresh destination if it already exists. Run the bundle and compiler work in the isolated lane, not beside workstation
tests or benchmarks.

```sh
deno task deps:ci
deno task fixtures:netlify --output .tmp/netlify-inert
DENO_V8_FLAGS=--max-old-space-size=1536 deno task bundle:netlify --output .tmp/netlify-candidate.ts

export OPFS_NETLIFY_ARTIFACTS=.tmp/netlify-inert
export OPFS_NETLIFY_EXECUTION_REVIEWED=11.1.7-test-only
export OPFS_NETLIFY_CANDIDATE=.tmp/netlify-candidate.ts
export OPFS_NETLIFY_CLOSURE_SHA256=$(node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(readFileSync(".tmp/netlify-inert/closure.json")).digest("hex"))')
export OPFS_NETLIFY_CANDIDATE_SHA256=$(node --input-type=module -e 'import{readFileSync}from"node:fs";import{createHash}from"node:crypto";console.log(createHash("sha256").update(readFileSync(".tmp/netlify-candidate.ts")).digest("hex"))')
DENO_V8_FLAGS=--max-old-space-size=256 deno task test:netlify-provider
```

Success runs two tests: official SDK observations and reciprocal candidate comparison. The output includes safe
full-byte observations, effective isolation receipts and one clean `netlifyRetirement` per fixture. A failed assertion
still prints its observation first; a failure to stop cleanly fails the test rather than becoming a passing cleanup log.
Keep the output with the candidate and closure hashes when sharing the result. Those hashes identify this execution;
they are not permanently fixed expected hashes for every later source or metadata revision.

The other gates answer different questions. `deno task test:portable`, `deno task test:node` and `deno task test:bun`
include the authored client tests. `deno task bench:netlify` compares the injected peer with an owned-array copy, not
with the SDK or production service. `deno task verify:npm` builds and installs the package into disposable consumers,
then exercises public imports, declarations and runtime behavior; run it serially in the compiler lane. An already built
tarball can instead be supplied to `deno task verify:npm:artifact /path/to/package.tgz`. The source and local-container
checks described above have passed. Extracted-package checks passed in isolated run
`7c5fc551-cd24-4730-96bb-00e645a6db2b`: all 171 exports, Node/Deno/Bun consumers, strict declarations, browser bundling,
import safety and selective adoption. The [pull request checks](https://github.com/okikio/opfs/pull/1/checks) record
exact-commit CI results; the presence of the CI job is not evidence of a passing run.
