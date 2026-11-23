# HTTP resumable upload evidence

The production client selects Internet-Draft 15 and interop 10. The primary text is
[draft-ietf-httpbis-resumable-upload-15](https://www.ietf.org/ietf-ftp/internet-drafts/draft-ietf-httpbis-resumable-upload-15.txt),
SHA256 `ca880cda78853074092913d51deec110f3b8625a5a862505278503bd4dd197ca`. Its selected structured-field grammar is
[RFC 9651](https://www.rfc-editor.org/rfc/rfc9651.txt), SHA256
`fe27f2ec8819911afbe4bd11f6fcb947580da4c49e5423a1fff960e252ced26d`. The Internet-Draft is not a final standard.

## Immutable independent implementation

`upstream.json` pins 35 runtime-source, package and notice Git blobs from
[nordvec/partial-content](https://github.com/nordvec/partial-content/tree/39a36a8970eea2652003271beb42b2d0319783b4),
commit `39a36a8970eea2652003271beb42b2d0319783b4`, package 5.0.0, Apache 2.0. `source-receipt.json` retains the
downloaded archive SHA256 and every selected file's SHA256 after its Git blob identity was independently checked. The
original license, notice and package metadata are under `source/`. Production code does not import this implementation,
and acquisition runs no upstream setup hooks.

`acquire.py` bounds compressed input, expanded TAR bytes, all member counts and declared extents before selecting files;
redirects stay on the primary HTTPS codeload origin. Initial acquisition startup on base
`f1d61877be7f1023016b35716b2424f3f3d77825a875853130311bdb0d9fe43e` exited 127: Node 26.13.0 ARM64 existed, but
`/usr/bin/python3` did not. No source was downloaded or executed. The corrected explicitly approved existing tools base
`4e9b1d5f2972c4b3df05c5fe56f976e02b42a535e6be46bee7c46406fa28cfee` contained Node 26.13.0 ARM64/Python 3.11.2.
Acquisition exited 0/noOOM and verified all 35 files. Both attempts used 1 GiB/1 CPU/128 PIDs, no mounts or published
ports. Initial and corrected logs/state remain in the task's implementation receipts.

## Native proof scope

`server.mjs` wraps unmodified upstream `createUploadHandler` and `fsUploadStore`. `baseline.mjs` is an independent raw
`node:http` client with authored original binary bytes. Neither imports the candidate client. The reviewed baseline
exited 0/noOOM on 2026-11-05 in 0.84 seconds. `independent.json` contains 13 native wire traces; its unchanged original
is `independent.json.snapshot`; its original producer SHA256 is
`45920c0a5a9353bd5c725b625968426e56df93aad8453f0089ee311229201de5`. The exact executed scripts are retained as
`baseline-*.mjs.snapshot`; the source-only tool image was
`43658f8669f6876ab0f8ec0a2e2c9a42363cd9b20e3229a862656fee65df9888`.

The baseline killed/restarted the FS-backed server and reloaded a persisted checkpoint whose acknowledgement was still
zero. The restarted server reported 32,768. The entire 131,089-byte published file equaled the authored original. Empty
completion and cancellation passed; optional replay returned 200 and valid unknown parameters returned 400. Both native
diagnostic arrays were empty. The baseline process itself survived. The separate candidate fixture below provides actual
fresh-client-process proof. Neither proves power-loss durability.

This upstream commit labels interop 10 as drafts 13/14 and only parses bare integer/boolean items. Its canonical-header
behavior is useful independent interop evidence; it does not establish full draft 15 conformance. In particular, unknown
structured-field parameters must be covered separately. Retain any native refusal rather than modifying upstream to
match the candidate.

## Structured-field grammar vectors

`structured/` retains nine unchanged primary files as `*.snapshot` (including LICENSE.md.snapshot) at
[HTTPWG commit 10781e4a59c387853c900cc06cdd8a3fd7ae4134](https://github.com/httpwg/structured-field-tests/tree/10781e4a59c387853c900cc06cdd8a3fd7ae4134).
Its receipt records each original filename, byte count and SHA256; append `.snapshot` to locate those original bytes.
The ordinary JSON files are formatting-only views. `format-receipt.json` records both hashes and an independently
checked equal parsed-JSON value for each pair. `tests/upload.test.ts` executes 159 original item/dictionary cases from
number, boolean, dictionary, item, param-dict, display-string, date and binary, preserving file and case names. List
cases are excluded because this internal API does not export list parsing. The adapter compares bare values and nested
members, discarding expected parameter retention; parameter syntax must still parse or fail as the original vector
requires. The library intentionally ignores parameter values after validation. The primary license remains unchanged and
is separate from the native server's Apache 2.0.

## Reproducible candidate process-loss fixture

`tests/upload-provider.test.ts` reconstructs only the 35 approved paths from `native/**/*.snapshot` after verifying each
original Git blob hash. These files are inert in the repository. The fixture runs the unmodified upstream source inside
the public official image
`node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68`, not a local-only
cache image. `node-image.json.snapshot` retains Docker Hub's original metadata; `node-manifest.json.snapshot` retains
the raw official registry manifest index, whose SHA256 was independently matched to that digest. The index selects
native AMD64 or ARM64. The executed server version must equal v26.13.0. The first candidate execution passed on
2026-11-05 in 10.57 seconds; actual server runtime was v26.13.0.

The fixture uses Testcontainers with 1 GiB memory, 1 CPU, 128 PIDs, internal port 8080 and an ephemeral host port. No
host filesystem is mounted and no external service is contacted. Testcontainers may acquire the public pinned image on a
fresh runner. `client.mjs` is an authored test transport around the actual production client. It kills its own process
after a remote append acknowledgement or terminal reply, before the library can return and the application can persist
that receipt. Each restart revalidates the real SHA256 source identity and parses the production `UploadSessionSchema`
from an atomically renamed checkpoint.

One case observes the native server's optional final-response replay. The other removes only the fixture's own
`.uploads/<token>` resource directory after the lost final response, modeling an unavailable/expired upload. The already
published file remains. A fresh client must report publication unknown after 404 without recreating or appending. Both
published files must independently equal all authored original bytes through the native server filesystem. These are
selected-profile process-loss tests, not general crash-consistent storage or power-loss claims.

Both candidate keys passed every original-byte comparison. Six actual client processes ran: four were killed at the
reviewed transport injection points and two fresh processes observed replay or unknown publication. The first run passed
without a fixture or production repair; its complete log is retained in the implementation receipts. These process-kill
points intentionally precede local receipt persistence; they do not simulate filesystem power loss.

## Timing observation

The three authored in-memory workloads ran on Node 26.13.0 ARM64 Linux in an isolated 1 GiB/1 CPU/128 PID/network-none
container. Actual Docker resource settings were recorded; all preflights passed and the container exited 0/noOOM. The
untimed 64 KiB append preflight checked every transmitted byte against the authored original. Median observations were
1.21 microseconds for one raw HEAD-response allocation, 2.22 microseconds for a three-member structured dictionary, and
80.71 microseconds for a cold creation+HEAD+copied 64 KiB append workflow. These are different operations, not
equivalent-operation speedups or network/storage throughput measurements.

`benchmark.json` records source input hashes, runtime, quotas, p50/p99/sample counts, and the original raw report
SHA256. The 22.84 MB raw JSON was losslessly gzip-compressed and round-trip checked; its archive remains under the
task's implementation receipts. The local cache base for this benchmark is recorded honestly and is separate from the
public reproducible provider-test image.
