# BinHex native fork-preservation evidence

`independent.json` contains 32 unchanged genuine BinHex outputs: sixteen authored two-fork cases through macutils
`binhex` and Perl Convert::BinHex. Native C `hexbin` and the Perl decoder reproduce every original data/resource byte; C
extraction also yields exactly the expected `.info`, `.data` and `.rsrc` files. Cases include empty forks, markers,
runs, tail sizes, a 65,537-byte payload and a Python-standard-library ZIP nested in a data fork. No candidate module is
imported by the producer.

`negative.json` is separate: six authored wire mutations, not genuine producer outputs. A literal re-encoding baseline
first reproduces all original bytes with native C. Mutations then change header type/CRC, data byte/CRC and resource
byte/CRC. Every mutation produces native C exit 1 with an explicit CRC mismatch diagnostic. Candidate tests reject those
same controls with `checksum-mismatch`. Perl is a full-byte oracle only, not our negative checksum oracle.

## Run the current TypeScript producers

`create.ts` keeps macutils and Perl Convert::BinHex as reciprocal independent BinHex producers and consumers.
`native.pl` is unchanged. Run from the repository root in a disposable runner with Node 26, macutils, the Perl module,
Perl and util-linux `prlimit` installed:

```sh
node tests/fixtures/binhex/create.ts --harness tests/fixtures/binhex/native.pl --output /tmp/binhex-new.json
node tests/fixtures/binhex/negative.ts --fixture /tmp/binhex-new.json --output /tmp/binhex-negative-new.json
```

Both commands require new output files and refuse to overwrite existing evidence. Native children retain the old 2 MiB
per-file limit through `prlimit`, plus a 60-second deadline with SIGKILL and a 2 MiB captured-output budget. Each
producer removes only its owned temporary tree. These are per-file and per-command bounds, not a filesystem quota. The
negative command can also take the existing `independent.json`; it checks the selected fork blobs and their hashes
before requiring full-byte baseline acceptance and checksum-specific native refusal.

The new producer replaces Python zipfile's nested input with explicitly authored, single-member STORED ZIP framing,
fixed at DOS date 1980-01-01. The authored CRC32 recurrence checks the standard `123456789` vector. This is a changed
nested input profile, not an independently supplied ZIP writer or a claim that the old ZIP bytes are reproduced. The
native C and Perl consumers still compare every original BinHex fork byte, including that nested image.

These TypeScript commands have not yet run. Qualify them offline with fresh source/tool hashes and native results before
admitting new fixture output. The existing JSON, native outputs and historical receipts remain unchanged. The exact
executed Python producers remain inert `create.py.snapshot` and `negative.py.snapshot`; the old filenames inside their
receipts retain their original identity. Do not reattribute old evidence to the TypeScript port.

## Historical bounded native workflow

The public base is
`python:3.13.12-slim-bookworm@sha256:a58daefb915e1e03ad48f3ca4df8832065412c5c35cacb9d39f4229184de12b6`. The inspected
arm64/v8 platform manifest is `sha256:34b27ac66ecf318887b55ea3c71f0db9307895efe631210231a66cc3fa130cf9`, with actual
local image `sha256:5ae62b8a656b92aebda2441c1b4b872da0799b4deabca9f6c476f5940624ebef`.

Acquire and produce in separate containers. Each has 1 GiB memory and swap, 1 CPU, 128 PIDs and no host mounts. Use
Docker create → copy → start, overriding entrypoints explicitly, and inspect exit/OOM/resource state after each stage.
Only acquisition has network access. Copy `acquire.sh` to `/acquire.sh`, then run `sh /acquire.sh` in the pinned public
base. It uses inherited signed Debian bookworm APT sources and installs macutils and the Perl package without upstream
setup scripts, CPAN installation or compilation. Retain actual downloaded deb SHA256, package versions, source/keyring
and signed InRelease receipts, binary hashes and licenses. Copy `/receipts` before retiring the container.

The successful acquisition installed macutils 2.0b3-17 arm64, libconvert-binhex-perl 1.125-3 all and Perl
5.36.0-7+deb12u4 arm64. Python is the image's `/usr/local/bin/python3`, version 3.13.12; it is not attributed to Debian
APT. Acquisition requires that exact version and records its resolved binary, selected standard-library files and
installed CPython license hashes. Missing or mismatched provenance fails acquisition.

Snapshot the successful stopped acquisition and inspect the new exact tools image before offline use. This run's tools
image is `sha256:ea631438f481f11103ff77da86c4912da33fe13ee602908425f520122736f9e3`. This derived local image is an
observed identity, not a public pullable reproducibility pin; future APT versions may differ and must be recorded
separately.

In the recorded historical run, a separate `--network none` container from that exact derived image received the
original `create.py` as `/produce.py` and `native.pl` as `/native.pl`. It ran:

```text
/usr/local/bin/python3 -I /produce.py --harness /native.pl --output /tmp/independent.json
```

The authored Perl harness invokes the installed library, not a downloaded source archive. Every extraction path comes
from the fixed fixture script. Each subprocess has a 60-second timeout, a 2 MiB file limit and capped file-backed
stdout/stderr, in addition to the container memory ceiling. Require exit 0/no OOM and exact full-byte/file-set parity
before copying the JSON. Preserve all first failures; tool help/version, empty-file or filename behavior must not be
silently normalized to fit the reader.

The historical `negative.py` ran separately offline under the same quotas, with the original genuine JSON at
`/independent.json`:

```text
/usr/local/bin/python3 -I /negative.py --fixture /independent.json --output /tmp/negative.json
```

The negative harness requires both a successful baseline and CRC-specific native refusal. Setup errors or unrelated
nonzero statuses are not counted as checksum proof. It preserves its exact genuine input SHA256 and script hash.

## Wire qualifications and integrity scope

The macutils producer emits a different identifying comment from RFC 1741. Its unchanged output requires the reader's
explicit `preamble: "rfc1741-or-macutils"`, which reports `preambleProfile: "macutils"`. No banner is rewritten. The
Perl harness uses the documented `NoComment` option after seeking to the original colon line, so its byte oracle does
not claim banner validation.

Convert::BinHex's encoder pads packed bytes to a multiple of three. Twelve genuine cases contain one or two complete
zero bytes after the resource CRC; four have none. Default canonical terminal parsing refuses those extra bytes. The
explicit `padding: "convert-binhex"` profile requires the exact observed literal-zero alignment, no pending RLE repeats
and a full packed quantum. Terminal evidence exposes policy and actual padding count. CRCs exclude that padding.

The inspected Perl `_read_fork` path uses an unassigned comparison variable; it is not used to establish negative CRC
parity. Native C supplies the independent rejection evidence. Header/data/resource CRCs and terminal framing are
separate scopes: data-only preview cannot establish the resource CRC or terminal padding. The candidate suite also
exercises real `openZip(archive.member("data"))` decoding against every original nested member byte.

## Primary references and exact receipts

The canonical format description is [RFC 1741, Appendix A](https://www.rfc-editor.org/rfc/rfc1741.html), an
Informational RFC. Official text SHA256 is `5c8c672b4b7dc708796e786039813778fa4627af3f86683407346167423f9643`. Inert
primary implementation references inspected before implementation:

- [Debian-retained macutils 2.0b3 upstream archive](https://deb.debian.org/debian/pool/main/m/macutils/macutils_2.0b3.orig.tar.gz),
  SHA256 `43970ae3c82bc5a9f125a27d980d422b886b9e2cb322f7bf36685197c77781ef`.
- [Convert-BinHex 1.125 release](https://cpan.metacpan.org/authors/id/S/ST/STEPHEN/Convert-BinHex-1.125.tar.gz), SHA256
  `513591b4be46bd7eb91e83197721b4a045a9753a3dd2f11de82c9d3013226397`.

No upstream implementation was copied into production. Candidate CRC logic uses an authored bit recurrence, while unit
controls use an independent table recurrence. Genuine native bytes, authored mutations and candidate-only grammar
controls are distinct proof sources.

[provenance.json](provenance.json) records exact source members, images, containers, quotas, scripts, packages, debs,
licenses, observed framing and raw/formatted JSON hashes. The unchanged compact native output is 565,934 bytes with
SHA256 `3a67496d2c4d1e91f1df4296bcbc9f0e4389c385a4337dae817941bb3ec4c4f1`; compact negative output is 12,241 bytes with
SHA256 `21a46d527761e3eee57756b03f36f55fea81fda6f579448713b6f955f3210c19`. Formatted checked-in JSON is semantically
equal, with its own byte hash retained. Actual command/status/diagnostic records are embedded in the fixtures.

An earlier signed acquisition succeeded against local inherited tools images later removed during Docker recovery. Its
original receipts remain historical evidence and are distinguished in provenance; those unavailable images did not
produce the final fixtures above. Both final acquisition and offline jobs exited successfully without OOM. These checks
prove the stated fork/layout/CRC profiles, not historical BinHex variants, encryption, host extraction or publication
authenticity.

## Focused runtime and timing evidence

Nineteen candidate cases passed in each of Deno (runtime-only `--no-check`), Node and Bun. They include all genuine fork
bytes, mandatory header/fork CRC failures, strict and explicit padding, source-window splits, borrowed scratch,
opening/nested budget retention, abort callbacks, backpressure and reentrant cancellation retaining provider failure.
Runtime tests are separate from the parent's static, published-entrypoint and installed-package checks.

The seven-lane benchmark passed full-original-byte preflight and sampling in Node 26.13.0 Linux arm64, in an offline
container with 1 GiB memory/swap, 1 CPU, 128 PIDs and no mounts. The measured closure has eight files; input tar SHA256
is `8f3240a2f4e7a36f87547c032202b9f1244cf6ff32d76a16d1780ab16d098667`. The decoded-Blob lane omits encoding, replay and
CRC, so its timings are not an equivalent-contract ratio. Work labels record actual source/decoded/output/request counts
independently of elapsed time.

Native Mitata raw distributions were 16,777,192 bytes, SHA256
`3aea6dea3b4bca54991b679046a1b386d7d1ff0656570cd7deba344816c5d01d`. They were losslessly compressed to 68,736 bytes,
SHA256 `50a45758178ed0d42171bf6373698323238b254d88272b2f3efa85532eaed79f`, and round-trip verified before raw removal.
Exact environment, resource, work and scalar observation receipts are in provenance. An unrelated external runner was
observed at 0.00% CPU before timing and 0.05% afterward, without modification; these start/end snapshots do not prove
continuous inactivity. Samples remain a qualified single observation, not a universal speed or isolation guarantee.
