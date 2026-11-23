# Acquire inert Vercel Blob test artifacts

This recipe prepares evidence for a later, separately admitted local SDK/emulator test. It acquires exact npm archives,
checks their SHA-512 SRI and both registry and packed dependency declarations, and retains original bytes without
installing or executing them. No Vercel client, driver, adapter, SDK interoperability or production-provider result is
established by this stage. The proposed public-store profile and its remaining gates are in
[the Vercel plan](../../../planning/storage/VERCEL.md).

The two roots are the public SDK [`@vercel/blob@2.8.2`](https://registry.npmjs.org/@vercel/blob/2.8.2) and the
separately authored local service [`@emulators/vercel@0.13.0`](https://registry.npmjs.org/@emulators/vercel/0.13.0).
Their [`artifacts.ts`](artifacts.ts) inventory freezes 33 package versions and every declared runtime edge. Registry
manifests reviewed on 2026-11-06 had no optional or peer edges; any newly observed edge fails admission. The source
declarations retain ranges as evidence and map each edge to one explicit target. No resolver, package manager, workspace
install, alias, lifecycle hook or package CLI participates.

Two `jose` versions are intentional: the SDK's `@vercel/oidc@3.6.1` requires `^5.9.6`, while emulator core requires
`^6.2.2`. They are distinct artifacts and distinct dependency targets. A later materializer must preserve that mapping;
placing one `jose` at the root and ignoring the other is not this closure. OIDC also brings CLI execution/configuration
packages and their dependencies. Their bytes are retained inert, including scripts and `bin` declarations for review;
the acquisition never invokes them. The first profile does not use OIDC or discover workstation credentials.

## Run in the isolated acquisition lane

Use Node 26 with its built-in TypeScript support, a fresh output destination, registry-only network access and a bounded
runner. The repository owner runs this stage serially; it is not an instruction to start a second workload beside
compiler, package or provider checks. For example, inside the existing isolated runner:

```sh
node --max-old-space-size=256 tests/fixtures/vercel/acquire.ts --output .tmp/vercel-inert
```

The surrounding runner must bound total process memory, CPU, disk and elapsed time; the JavaScript heap flag alone does
not bound native buffers or filesystem usage. A 1 GiB memory ceiling, one CPU and an outer deadline slightly above the
recipe's ten-minute deadline are the intended acquisition budget. The command requires public registry access but no
Vercel account, bearer token, paid service, Docker socket or host credential mount. It performs no native test.

`acquire.ts` uses the existing candidate-free [`../acquire.ts`](../acquire.ts) primitives. Fetch refuses redirects and
uses one whole-stage ten-minute deadline with a maximum twenty seconds per request. Each registry manifest is bounded to
256 KiB; the aggregate is bounded to 8 MiB. Each compressed archive is bounded to 8 MiB, with 64 MiB aggregate
compressed bytes. TAR admission bounds one expansion to 32 MiB, all expansions to 96 MiB, one archive to 6,000 members
and the acquired files to 12,000. It checks canonical paths, checksums, duplicate identities, entry modes and
termination through the shared TAR reader, and rejects hard links, symbolic links, special files and files outside
`package/`. Retained license and README evidence has a 256 KiB per-file and 4 MiB aggregate ceiling. The two root
registry attestation responses have a separate 1 MiB ceiling each. These are fixture admission limits, not Vercel
service limits.

The output appears only after every artifact passes, through a fresh-stage rename. An existing output or staging path is
refused. Failure leaves `DESTINATION.partial/failure.json` and the evidence admitted before failure; that partial
directory is not a successful closure. Inspect the failure and choose another fresh destination before retrying. Do not
edit a retained snapshot or substitute a different tarball to make the recipe pass.

## Inspect what was retained before granting execution

The successful directory contains:

| Path                                 | Retained content                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `closure.json`                       | Exact dependency targets, manifest/archive/member hashes and extents, notices, scripts, exports, entrypoints and unresolved review flags |
| `metadata/NAME@VERSION.json`         | Original exact-version registry manifest                                                                                                 |
| `archives/NAME@VERSION.tgz.snapshot` | Original SRI-checked npm archive, never extracted as runnable files                                                                      |
| `source/NAME@VERSION/PATH.snapshot`  | Every original regular-file member, including packed `package.json`                                                                      |
| `legal/NAME@VERSION/PATH.snapshot`   | Original license, notice, copyright and README evidence, without generated replacement text                                              |
| `provenance/NAME@VERSION.json`       | Original root registry attestation responses, retained without signature verification                                                    |

Scoped names replace their one slash with `__`: for example `@vercel__blob@2.8.2`. SHA-256 hashes identify retained
bytes; SHA-512 SRI compares archive bytes to the explicit reviewed registry identity. Neither grants permission to run
code, establishes a license conclusion, proves that published code matches a source revision, or proves the absence of a
supply-chain attack. A new pin requires primary-manifest review and an explicit recipe update, rather than a floating
version refresh.

The plan records source-revision observations from decoded root provenance statements: SDK
`5425e1611f65799a02ffa0033086a56e8d280dd5` and emulator `1566b8e38177bd606f1b4415b7da047ae653a8b7`. This recipe retains
the statements and their hashes but does not verify Sigstore signatures, certificate identity, provenance trust chains
or reproducible builds. Registry `gitHead` fields, where present, are also retained as observations.

Read every package's retained notices, including bundled third-party notices. `missingStandaloneNotices` explicitly
lists archives without a recognized standalone notice file; their README and all other source bytes remain available for
investigation. No license or copyright text is invented for them. Successful inert acquisition keeps
`executableAdmission: false`, `legalReview: pending` and `productionDependencyApproved: false`. The repository owner
must record a separate test-only execution decision before any later materializer loads these packages. There is no
production dependency approval. A source-ready fixture launcher is described below; strict and native qualification
remain separate gates.

The local emulator targets its own declared SDK development version, 2.8.1, while this oracle candidate is 2.8.2. A
later test must qualify their actual common behavior and document exclusions. Emulator behavior, including its public
URL authentication and missing multipart implementation, cannot certify the hosted Vercel service. Acquisition
completion does not remove the plan's wire-contract, independent-byte, reciprocal-consumer, cleanup or packed-package
gates.

## Qualify the public SDK against the local emulator

`create.ts` and `programs.ts` contain the Testcontainers fixture and two authored programs. The pinned
SDK/local-emulator run passed on 2026-11-06 in receipt `4e5f407c-b707-4c83-b4d9-42608d07943d`, retained with its
`output.log` under `.tmp/implementation/vercel-native/4e5f407c-b707-4c83-b4d9-42608d07943d/`. It passed one test with
one step and retired without OOM. This qualifies the exercised SDK/emulator fixture, not the in-progress OPFS client or
hosted Vercel behavior. For a fresh run, review the exact acquisition and record a separate execution decision before
supplying:

```sh
export OPFS_VERCEL_ARTIFACTS=/absolute/path/to/reviewed/vercel-inert
export OPFS_VERCEL_CLOSURE_SHA256=EXACT_REVIEWED_CLOSURE_JSON_SHA256
export OPFS_VERCEL_EXECUTION_REVIEWED=2.8.2+0.13.0-test-only
deno test --no-check --allow-all tests/vercel-provider.test.ts
```

This focused invocation belongs in the isolated runner. It does not replace strict checks or claim an existing CI task.
Deno's permissions authorize host-side Testcontainers/Docker control inside that isolated runner, matching the existing
provider-test command pattern. The actual SDK and emulator run in a private container with `network: none`, no published
ports, no bind mounts, UID/GID 65534, all capabilities dropped, `no-new-privileges`, 1 GiB memory/swap, one CPU and 256
PIDs. The current recipe requires a read-only root filesystem and two 32 MiB `noexec,nosuid` tmpfs mounts: `/fixture`
for admitted code and `/data` for the address rendezvous and scratch data. Engine readback requires
`ReadonlyRootfs:
true`; mountinfo checks both effective mounts and their byte ceilings before foreign code can load. The
retained passing run records these restrictions and bootstrap. The exact Node26 image is pinned in `create.ts`.

The reviewed image first runs a bounded shell bootstrap, with a two-minute deadline to receive `/fixture/ready`.
Testcontainers uses a successful `true` command to admit that bootstrap. Only after effective isolation readback does
the fixture copy at most 24 MiB of hash-admitted package and authored program bytes. A fixed Node-built-in-only writer
receives bounded JSON through Docker exec stdin: at most 32 MiB serialized, 12,002 unique canonical relative names, and
a SHA-256 identity for every body. It validates all names, namespace conflicts, canonical base64, byte extents and
hashes before its first write. It creates directories only under `/fixture` with mode 0700, creates files exclusively
with mode 0400, then reads each file back and verifies its full length and SHA-256. Only after every readback succeeds
does it create `/fixture/ready`. The writer has a 60-second native deadline, 128 MiB Node heap, 75-second host deadline
and 128 KiB output ceiling. It imports Node built-ins only; it loads no acquired module. The bootstrap then replaces
itself with the Node server. A single native `timeout 60s` command awaits the server's address file. No package code
runs while copying or isolation review is incomplete. The writer transports admitted code only; none of the oracle's
original values or expectations come from it.

Docker archive extraction was tried both at `/` and directly at `/fixture`. The latter also failed despite verified
writable tmpfs mounts: Moby's archive writable-path check recognizes managed mount points but not the legacy
`HostConfig.Tmpfs` destination before rejecting a read-only root. The fixed stdin writer uses ordinary filesystem writes
inside the already inspected tmpfs and avoids that archive-extraction policy.

The server has a 128 MiB Node heap. Its fixed oracle has a 30-second native timeout, 45-second host bound, 128 MiB heap
and 2 MiB output ceiling. It admits at most 128 requests, 256 KiB per request body and 1 MiB per oracle response. No
arbitrary package script, CLI or program can be selected through the fixture API. The materializer rechecks the closure
hash, package identities, graph, paths/extents and each member hash. It copies separate SDK and emulator `node_modules`
roots without symlinks, preserving their different `jose` versions.

The authored programs use only public exports: `createServer`/`serve` from `@emulators/core`, the default plugin from
`@emulators/vercel`, and `put`, `get`, `head`, `list` and `del` from `@vercel/blob`. Packed-source review found real
import side effects. Core synchronously reads its bundled fonts/favicon and debug environment settings. SDK import
starts a small Blob feature-probe Promise and imports Undici, which initializes a process-global dispatcher/Agent if
absent. No portable import-safety claim is made for these test packages. `createServer()` constructs app/store state;
`serve()` explicitly acquires the HTTP listener. Shutdown closes connections/listener, checks effective exit/OOM state,
then removes the owned container. Partial startup and cleanup failures remain visible alongside a primary failure.

Every SDK call supplies a synthetic read-write token. The pinned `resolveBlobAuth()` returns directly for that option,
before OIDC discovery. No OIDC/CLI support function, package script or `bin` is invoked. Only the pinned SDK test
overrides `VERCEL_BLOB_API_URL` and `VERCEL_BLOB_RETRIES=0` enter its oracle process; they are not first-party API
promises. No host home directory, real account or Vercel credential is granted.

The oracle writes empty and 128 KiB originals with the SDK and reads them through unauthenticated HTTP, then writes
different originals through literal API13 requests and reads them with the public SDK. Host assertions compare full
bytes, metadata, create-only/stale/current conditions, two list pages, public cache 304, deletion and pre-abort
readback. The SDK sends its bearer on public GET; this observation is separate from the proposed first-party policy that
omits it. Safe traces retain header presence, payload extents/hashes and statuses, never tokens. Receipts are printed
before assertions and include the exact closure hash and unresolved notice gap. These are local-model checks with
retries disabled, not production credential validation, CDN consistency, multipart, ranges, restart recovery or
filesystem proof.

The first inert pass, receipt `897ff16b-b4d4-4a91-9b18-6ec0dfd6cc73`, retained 33 packages, 1,457 files, 1,720,475
compressed bytes and 9,527,296 expanded bytes. Its closure SHA-256 was
`7643177856724a3005e02fe8a54427aa02520416c1ac0a1ad89f9631f0103176`. That historical receipt remains unchanged. Later
source review strengthened notice classification to duplicate `THIRD_PARTY_NOTICES.md` into `legal/`; those original
bytes were already retained under `source/` with hashes. Fresh inert receipt `3d0d790d-502f-4c51-9c56-9a1357b043af`
passed with the same archives, package/file counts and expanded/compressed extents, plus 252,439 retained legal/README
bytes. Its closure SHA-256 is `d30d27e3cef8dad193541a3efb3c92cf231d5231e2fc34fbe1e03685135c73fc`. Use that fresh
inventory for execution review; the earlier receipt remains historical evidence. No native pass is implied by either
acquisition.

The exact upstream `is-node-process` tag `v1.2.0` points to commit `8a6152c795d8705be97166bd5167e70ac6efc67c`. Its
complete GitHub tree contains no standalone license/notice file; the packed manifest declares MIT and its original
README has no full notice. There is no authenticated supplemental notice at that revision. Preserve the gap rather than
inventing an MIT copyright statement. Both emulator packages do contain complete `THIRD_PARTY_NOTICES.md` with Hono's
copyright and MIT text.

Native attempt `a77da628-03f6-4e36-85c1-5c3c112896ec` completed all SDK/raw operations and retired with exit 0 and
`OOMKilled: false`, but its host test failed. The authored assertion expected `size` on a PUT acknowledgement; the
pinned SDK `PutBlobResult` and the emulator's PUT response have no such field. The corrected probe retains that original
acknowledgement, independently obtains HEAD metadata for size/ETag, and still compares every original byte. That failed
receipt remains unchanged. The corrected test and read-only-root-filesystem restriction passed in the later receipt
above. Before that pass, read-only attempt `940b5bb2` failed before upstream imports when Docker refused Testcontainers'
pre-start archive extraction at `/`. That failure prompted the bounded post-start mount-targeted transport above. Its
original receipt remains retained; it supplies no additional SDK behavior evidence.

Native attempt `33b7877d` retained the mount-targeted archive refusal after successful read-only-root and both tmpfs
readbacks; clean retirement reported exit zero and no OOM. The stdin-writer replacement subsequently passed in receipt
`4e5f407c-b707-4c83-b4d9-42608d07943d`. That result retains the closure hash and unresolved notice gap; it does not
grant production dependency approval or add multipart, ranges, restart recovery or filesystem guarantees.
