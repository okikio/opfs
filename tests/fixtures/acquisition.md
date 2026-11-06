# Retain independent fixture inputs without running them

A fixture maintainer first admits immutable upstream bytes, then separately runs an offline producer. Downloading source
is not permission to execute it. `acquire.ts` supplies bounded HTTPS reads, fresh staging directories, SHA/Git-blob
checks and a small acquisition-only TAR inventory reader. It imports no production OPFS modules. The leaf acquisition
tools use only Node built-ins and retain source and executables as inert `.snapshot` files. No package install,
lifecycle hook or Python interpreter participates in the current tooling.

For example, review jose metadata before acquiring the package. Run these commands in separately owned, quota-limited
Node acquisition environments, with the fixture source tree copied under `/tool` and a fresh `/evidence` destination per
stage:

```sh
node /tool/jwe/acquire.ts metadata --output /evidence
# Review registry.json.snapshot and registry-receipt.json before the next stage.
node /tool/jwe/acquire.ts artifact --integrity 'sha512-REVIEWED_BASE64_VALUE' --output /evidence
```

The second command is a template: substitute the exact reviewed canonical SHA-512 SRI. Each stage must receive its own
fresh output directory. Successful admission renames `OUTPUT.partial` to `OUTPUT`. A failed stage retains its partial
files and `failure.json` under `OUTPUT.partial`; it never publishes a successful destination. Inspect or retire only
that owned partial tree before retrying. Existing outputs and partial directories are refused. This is a single-owner
publication boundary, not a concurrent-writer or power-loss durability protocol.

```mermaid
flowchart LR
  Pin[Reviewed immutable identity] --> Download[Bounded HTTPS download]
  Download --> Admit[Verify extent, hash and archive inventory]
  Admit --> Inert[Publish inert snapshots and receipt]
  Inert --> Review[Review execution recipe and exact inputs]
  Review --> Offline[Separate offline producer container]
  Offline --> Compare[Compare complete original bytes]
```

`upload/acquire.ts --pin PIN --output OUTPUT` accepts only the reviewed partial-content commit and Git blobs. It writes
`path.snapshot`, including `package.json.snapshot`. The old Python acquisition wrote active filenames; the new output
must be reconstructed explicitly after hash verification by the offline owner. The current provider test already does
that from `upload/native/**/*.snapshot`. Acquisition does not refresh that checked-in corpus or its historical receipt.

`age/provenance/age-acquire.ts cli --output OUTPUT` admits the exact age 1.3.2 Linux ARM64 release and checks selected
ELF headers without executing a binary. `vectors` instead requires the reviewed 50-vector and nine-source manifests:

```sh
node /tool/age/provenance/age-acquire.ts vectors --output /evidence \
  --manifest /tool/age-vectors.json --sources /tool/age-sources.json
```

Preserve the relative source tree: `/tool/acquire.ts` is imported by the tools under `/tool/jwe`, `/tool/upload` and
`/tool/age/provenance`. Copy the two reviewed age manifest JSON files separately to the paths above. One 120-second
budget covers all network work in a stage. Each response has an additional finite timeout and byte/chunk ceilings.
Redirects are refused for raw source and jose. Release downloads may reach only GitHub's HTTPS release-asset host;
partial-content redirects stay on HTTPS codeload. Expansion, member inventory and retained source totals have separate
caps. The reader checks TAR header checksums, bounded extended metadata, canonical paths and duplicate identities. A new
upstream archive encoding outside the admitted subset is a review failure, not permission to relax a bound.

The age vector derivation uses Node's native `inflateSync` with a 1 MiB output ceiling and the default complete-stream
finish requirement. It also requires the reported consumed input extent to equal the entire compressed wire, refusing
trailing input. See Node's [zlib options and consumed-byte API](https://nodejs.org/api/zlib.html). Original compressed
source remains a separate snapshot; derived binary wires receive their own hashes and names.

## Start only the reviewed owned container

`launch.ts` is a host-side Docker launcher shared by `age/provenance/age-run.ts` and `jwe/producer-run.ts`. It starts an
already-created container; creation, input copying and image acquisition remain separate reviewed operations. Examples:

```sh
node tests/fixtures/age/provenance/age-run.ts opfs-age-vectors-review \
  --stage vectors --output .tmp/implementation/age-vectors-launch
node tests/fixtures/jwe/producer-run.ts opfs-jwe-producer-review \
  --output .tmp/implementation/jwe-producer-launch
```

Those commands require prepared fresh containers and fresh parent-owned output paths. The launcher does not recreate
missing containers. All current stages require the official
`node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68` image and the
reviewed ARM64 image config `sha256:97000ec2e6fe65be46c887c441bb83ac6cb03d46091429bb73914a75bce6991e`. This deliberately
refuses a different platform or image configuration until its own recipe is reviewed. Acquisition uses bridge
networking; production uses none. RAM and swap are both exactly 1 GiB, CPU is one core and PID limit is 128. Mounts,
ports, added environment values, additional capabilities and device/host authority are refused.

The exact container entrypoint is `node`. Age acquisition command arguments are
`/tool/age/provenance/age-acquire.ts STAGE --output /evidence`. Age production uses `/tool/produce.ts`, copied from
`age/provenance/age-produce.ts`; its fixed owned input/work/output paths remain defined there. JWE production uses
`/tool/produce.ts /evidence`, copied from `jwe/produce.ts`; the second argument is required. Both producers still
require the explicitly admitted `/tool/evidence` tree, and JWE also requires a fresh `/tool/sdk`. Do not mount the
worktree or copy candidate library modules into a native oracle container.

The launcher retains pre-start image/container inspection, at most 1 MiB combined output, terminal state and a launch
receipt. Its execution budget is 180 seconds for age or 90 seconds for JWE. On a deadline, log fault or output overflow,
it stops only the checked owned container, waits a bounded time for the attachment, and then kills only that attachment
if necessary. Primary and retirement faults are recorded separately. The stopped container remains owned by the caller
for evidence copying and explicit retirement; a failed or incomplete retirement is never recorded as success.

These TypeScript tools are new source. They have not produced the retained historical acquisition/native receipts. The
five original Python files remain byte-for-byte `.py.snapshot` evidence, with hashes in `acquisition-source-map.json`.
Historical receipts continue to name the actual original sources and images. Current source compilation, offline helper
qualification, controlled acquisition and independent producer runs are separate verification steps; none can be
inferred from a historical receipt merely because the new tool follows the same admission policy.
