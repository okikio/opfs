# Genuine uncompressed WIM evidence

The historical `produce.py.snapshot` used Python 3, wimlib-imagex and 7zz/7z to create two ordinary images using native
capture `--compress=none --no-acls` followed by append. It verifies and applies both images with wimlib, then
independently extracts every authored file with 7-Zip and compares complete bytes. No candidate output supplies an
oracle. Producers/native consumers use checked subprocesses; no shell pipe hides a producer failure. Complete archive
bytes, SHA256, image/member oracles, listing and subprocess receipts are retained in `independent.json` unchanged.

The original producer ran in disposable container `opfs-wim-producer-20261105`, bounded 2 GiB/2 CPUs/256 PIDs, based on
`opfs-seven-tools:20261105` image SHA256 `527d62a5244f4fa71833b4a105a4906ec1c1c7708f64ea2967fa04d96c551dd5`. Debian
bookworm signed apt installed wimtools/libwim15 package 1.13.6-1. The actual binary reports
`wimlib-imagex 1.13.5 (using wimlib 1.13.5)`; both facts are retained, without claiming they are identical version
strings. The independent consumer identifies itself as 7-Zip 26.02. The native verification receipt warns that the WIM
has no integrity table and skips that check. It still checks individual metadata/file resources; this is not whole-file
integrity-table evidence.

Images contain shared bytes 0..255 repeated three times, duplicates under different names, an empty file, nested paths,
a Unicode filename and differing `hello.txt` bytes. Native creation times and GUIDs are not repaired, so regeneration
changes archive bytes/hashes. The script copies no external/private files. Source hashes are SHA256:

| Primary source                            | Immutable version                               | Hash                                                             |
| ----------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Microsoft Windows Imaging File Format.rtf | Official Download Center id 13096, document 1.1 | 397772cca016508194d13ac860633b56b4f2f94cbf7476e2112f557ad61cfe0c |
| include/wimlib/header.h                   | cd5e231c348c255ae5088873b5a66ee0eb96fa07        | fde17fe304b6f154b2f8398d8c245e077d6c147fb99a3c2c43654fb3af8a73cf |
| include/wimlib/resource.h                 | same                                            | 27512d0434dfb90491b5c3952f0f9f7ab4e65b3579a43294054ac530b8a90125 |
| src/blob_table.c                          | same                                            | 2903517091c356d08fc81f25bf44f8f8b6b42391a50122ea9a155a3a6aad806b |
| src/dentry.c                              | same                                            | 8956c7b2539f51bef0d725162e2789ce9782acd0bf96bccc6f61d8a030a15036 |
| src/metadata_resource.c                   | same                                            | 69def3ecd8525517c3e73a0a60579d64304008d2d23d3e587d495f1d891769ea |
| src/security.c                            | same                                            | 79ef186cb1df582b8f23fe160026ccd76f83fbf5cad501684a1a6f850d55decd |

Microsoft source:
https://download.microsoft.com/download/f/e/f/fefdc36e-392d-4678-9e4e-771ffa2692ab/Windows%20Imaging%20File%20Format.rtf
wimlib source: https://github.com/ebiggers/wimlib/tree/cd5e231c348c255ae5088873b5a66ee0eb96fa07

The pinned format research is not claimed to be the exact source used to build the Debian binary. wimlib source is
LGPL2.1-or-later; the wimlib-imagex tool reports GPL3-or-later. No implementation code is copied or linked into the
package. Test-only native tools are not runtime dependencies. Authored inputs/generator use the repository license.
Named streams, Windows security semantics, hardlinks, reparse points, compressed resources and split/ESD variants do not
have genuine interoperability proof in this first fixture.

## Current TypeScript fixture tooling

The six executable entries are now TypeScript. Historical Python sources remain inert `*.py.snapshot`, mapped with exact
byte lengths and SHA-256 in `source-map.json`. Existing genuine, authored and tail-audit JSON remain unchanged; new
executions must use new paths. No new execution is claimed to have produced a historical hash.

From the repository root, in the reviewed offline native-tools environment:

```sh
node --max-old-space-size=256 tests/fixtures/wim/produce.ts --output /tmp/new-wim.json
node --max-old-space-size=256 tests/fixtures/wim/xpress-produce.ts --output /tmp/new-xpress.json
node --max-old-space-size=256 tests/fixtures/wim/xpress-audit.ts /tmp/new-xpress.json --output /tmp/new-xpress-audit.json
node --max-old-space-size=256 tests/fixtures/wim/lzx-produce.ts --output /tmp/new-lzx.json
node --max-old-space-size=256 tests/fixtures/wim/lzx-raw-produce.ts /tmp/new-lzx.json --output /tmp/new-lzx-authored.json
node --max-old-space-size=256 tests/fixtures/wim/lzx-audit.ts /tmp/new-lzx.json --output /tmp/new-lzx-audit.json
node --max-old-space-size=256 tests/fixtures/wim/lzx-audit.ts /tmp/new-lzx-authored.json --output /tmp/new-lzx-authored-audit.json
```

Node 22.18 or later runs the erasable annotations directly. Copy this directory with `../iso/native.ts` and
`../codec.ts` when staging a disposable container. The native helper explicitly selects Linux C.UTF-8 or macOS
en_US.UTF-8 so Unicode names survive capture/apply/extraction. Producers accept `--wim`, `--seven` and `--compiler` for
explicit executable paths. The native-tools environment needs wimtools, libwim15, matching libwim-dev headers, a C11
compiler and 7zz. Package identity and the actual runtime version remain separate evidence; the historical Debian
version discrepancy described above is preserved.

`bridge.c` is a small test-only adapter to the
[wimlib public compression API](https://github.com/ebiggers/wimlib/blob/v1.13.6/include/wimlib.h). It links the
installed native library with `-lwim`; no upstream decoder source is copied, and no native dependency enters production.
It replaces ctypes mechanics, not the codec oracle. Stack buffers admit at most 64 KiB packed input and 32 KiB output.
Only XPRESS/LZX IDs, positive output sizes through 32 KiB and explicit compress/decompress operations are accepted.
Create/decode/compress failures return nonzero, zero compressed length is refused, and allocated compressor/decompressor
objects are freed on both success and failure.

Shared `native.ts` admits original file receipts from the immutable independent fixture and checks every SHA1 before
writing them. This preserves the exact random, aligned, E8 and boundary inputs without claiming Node emulates CPython
Random. Capture/append still produce genuine native WIMs; wimlib verify/apply and independent 7-Zip must match every
complete original file. Compressed resources still use the native public API for each packed chunk, then require the
complete resource SHA1, including metadata. The API belongs to the producer family; it is not another independent
algorithm.

The raw-prefix adapter remains explicitly authored, with its native-compressed successor and complete combined-chunk
check before both complete file consumers. `audit.ts` ports the research grammar with bounded bit queues and compares
every byte against pre-established native resource bodies. These audits do not become independent native conformance
claims merely by using TypeScript.

Inputs/archives are limited to 16 MiB, individual originals/resources to 2 MiB, resource tables to 256 rows, chunks per
resource to 64, bridge calls to 2048, and new JSON to 32 MiB. Native commands have a 45-second deadline and 4 MiB per
captured pipe; outer process/native memory, CPU, PID, overall time and filesystem quotas remain the runner's
responsibility. Every output uses exclusive creation; fresh temporary roots retain primary and cleanup failures
separately. A passing compiler check is not a native execution receipt. Qualify these new entries with the reviewed
native packages before replacing any historical evidence.
