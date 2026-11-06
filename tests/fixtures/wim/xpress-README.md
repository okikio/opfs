# Genuine ordinary XPRESS-Huffman WIM evidence

`xpress-produce.py.snapshot` authors two image trees, captures/appends an ordinary WIM using genuine wimlib
`--compress=xpress --chunk-size=32768`, verifies it, applies both images and checks every complete authored file with
independent 7-Zip. It never imports OPFS or obtains an expected payload from the candidate decoder. It also calls the
native libwim decompressor API for every compressed chunk and checks the complete decoded resource SHA1, including image
metadata. Resource oracles retain complete bytes rather than success flags alone. The API is from the producer's
implementation family; it is not described as a second independently authored decompression algorithm.

The run used disposable bounded container `opfs-wim-producer-20261105`, 2 GiB/2 CPUs/256 PIDs, based on image
`opfs-seven-tools:20261105`, SHA256 `527d62a5244f4fa71833b4a105a4906ec1c1c7708f64ea2967fa04d96c551dd5`. Signed Debian
bookworm packages identify wimtools/libwim15 as 1.13.6-1; the actual tool reports wimlib-imagex/libwim 1.13.5. The
independent consumer reports 7-Zip 26.02. Receipts retain actual version strings, checked subprocess outcomes and the
warning that no optional whole-file integrity table exists. Applying/verifying resource hashes does not replace that
absent integrity-table check. No private or external file is copied into the fixture.

The original container command retained its old output path `/tmp/wim-independent.json`; the resulting bytes were copied
to `xpress-independent.json` only after producer exit 0. Its exact Python sources are now inert snapshots; current
TypeScript commands are documented below.

Native creation times and GUIDs are not repaired; new WIM hashes will differ on regeneration. Authored files cover
100,000 deterministic random bytes stored without compression, 200,000 repeated bytes with extended match lengths,
32,767/32,768/32,769-byte boundaries, shared resources, empty files, Unicode names and differing files in two images.
The retained WIM contains 12 resources and 13 compressed chunks. Some chunks/resources are stored fallback data.

## Exact framing evidence and limits

`xpress-audit.py.snapshot` is an authored interpretation of the pinned Microsoft/wimlib writer grammar. It first
compares complete output bytes against already established native resource oracles, then requires terminal canonical
symbol 256, exact packed extent and 16 through 31 remaining zero bits. All 13 compressed chunks satisfy those
conditions; observed zero bit counts are 17, 26, 27, 28 and 30. Extended 16-bit adjusted match lengths include 508,
3387, 32756, 32760 and 32763. The full measurements remain in `xpress-tail-receipt.json`.

This audit is not a third independent native consumer. The strict termination policy describes the selected writer
profile, not universal native decoder acceptance. Pinned wimlib decoding stops after expected output size and does not
check the extra end symbol. Its compressor explicitly emits that symbol and flushes alignment plus a zero coding word.
The Microsoft encoder describes the same termination and interleaved byte locations. Its decoder pseudocode omits the
encoder's 32-bit length escape; the selected 32 KiB chunk profile cannot require a valid match that large, so it refuses
invalid short extended words rather than inventing escape semantics. Plain XPRESS, other chunk sizes, LZX, LZMS,
solid/pipable WIM and arbitrary trailing-byte compatibility are outside this evidence.

## Immutable primary sources and retained bytes

The Microsoft
[MS-XCA download](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-xca/a8b7cb0a-92a6-4187-a23b-5e14273b96f8)
resolved to the primary PDF at <https://winprotocoldoc.z19.web.core.windows.net/MS-XCA/%5BMS-XCA%5D.pdf>. Acquired bytes
identify `[MS-XCA] v20240423`, release April 23, 2024, 1,144,541 bytes, SHA256
`e7806b36adc81b75f50bf57559c55420fcaadeb98a0435e8865d2eb3512d5e9e`. Sections 2.1.4.3 and 2.2.4 govern the selected
Huffman writer/reader grammar. This acquired-byte hash pins a potentially mutable download URL; it is not a signature
verification claim. Microsoft WIM 1.1's RTF hash and the header/resource structures remain pinned in
[README.md](README.md).

All implementation research below uses immutable
[wimlib cd5e231c348c255ae5088873b5a66ee0eb96fa07](https://github.com/ebiggers/wimlib/tree/cd5e231c348c255ae5088873b5a66ee0eb96fa07).
It is not claimed to be the exact source used to build the Debian binary.

| Source or retained file              | SHA256                                                             |
| ------------------------------------ | ------------------------------------------------------------------ |
| `src/xpress_decompress.c`            | `7e0efb7f3126c1017d6d3b0e7367780238d7a3a71214d19ee2abaeb98fae6db9` |
| `src/xpress_compress.c`              | `3b224523aab9b6b70fde30a536291c7b28502e83170195aab10a2d3a8c2b3d50` |
| `src/resource.c`                     | `188feebd2d110da66e540db5f57ee00e4ae58eada9be877bed7b9f4d62fb57fd` |
| `include/wimlib/decompress_common.h` | `4d637781f162dcc6edde13df36bb492c2373389aa92624d466a7c5eb46cf42bb` |
| `src/decompress_common.c`            | `eb0f8ad3cbc57ea3048d0db7bf2594436cd11e31ee4e3f73d816fb1aff515282` |
| `xpress-produce.py.snapshot`         | `f34e793640e0670f5dec399e42263e2d4407ac7319fa7712155b1040e4b8fee3` |
| `xpress-audit.py.snapshot`           | `7cd8b9b28a2cbf3466dcad79ff298e3a3a2858a4104546d9b67efa534e809a09` |
| `xpress-independent.json`            | `ff1d38c1568fd479a1ad387c040a6877eadb55028366f8a3f2c06305c2aa552c` |
| `xpress-tail-receipt.json`           | `dcb5b144209412d69e7ea199e9f49594a0d89026298c2b8968532ced8b4a6e90` |

No upstream implementation code is copied, linked or shipped as a runtime dependency. The researched wimlib code is
LGPL2.1-or-later and the tool reports GPL3-or-later. Test-only native tools do not become production dependencies.
Authored input, generator and framing audit use the repository license. Native full-file proof does not establish
Windows restoration, named-stream semantics, signatures or unsupported codec compatibility.

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
