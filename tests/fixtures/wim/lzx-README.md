# Ordinary WIM LZX evidence

These test-only files retain original bytes, native producer and consumer receipts, and a separately authored framing
audit. No native tool, SDK or upstream implementation is a production dependency.

`lzx-produce.py.snapshot` creates two genuine ordinary WIM images using wimlib capture/append with `--compress=lzx` and
`--chunk-size=32768`. Native verify/apply succeeds, independent 7-Zip compares every complete authored file, and
libwim's LZX decompressor supplies complete metadata/resource/chunk bytes. Original files include shared content, empty
and Unicode names, incompressible stored fallbacks, repeated content, chunk boundaries and E8 operands.
`lzx-independent.json` retains the full WIM and full original/native byte oracles.

`lzx-audit.py.snapshot` is an authored research parser, not a third independent decoder. It compares every decoded byte
with those already established native oracles. `lzx-tail-receipt.json` reports 19 genuine compressed chunks: 17 verbatim
and two aligned blocks, 304 aligned-offset uses, ten E8 translations, twelve default-size flags and seven explicit
sizes. Each chunk has one internal block. All physical extents finish exactly with 1, 3, 6, 8, 10, 11, 12 or 13 zero
bits. There is no end symbol or extra reserved word. Native size-only decompression itself does not prove tail
consumption.

`lzx-raw-produce.py.snapshot` is explicitly an authored adaptation. It prepends a five-byte raw A block to a
native-produced 32763-byte verbatim A block, preserving the decoded 32768-byte chunk. It replaces one resource chunk and
updates its physical table coordinates while preserving all original file/resource hashes and image bytes. An orphan old
resource extent remains; no whole-file integrity table claim is made. Native libwim decompresses all bytes, wimlib
verify/apply and 7-Zip extraction compare every original file. `lzx-authored.json` retains that distinct proof;
`lzx-authored-tail.json` shows blocks `[raw, verbatim]`, zero alignment, zero odd-body padding and six final zero bits.
It is not claimed that the genuine producer selected raw blocks. Terminal raw and empty-tree unit vectors are authored
structural regressions and do not add independent native interoperability claims.

## Primary grammar and selected dialect

Microsoft
[MS-PATCH revision 14.1, 2025-08-19](https://officeprotocoldoc.z19.web.core.windows.net/files/MS-PATCH/%5BMS-PATCH%5D.pdf)
is a **LZX Delta** grammar, not a complete ordinary WIM dialect specification. PDF size 1223283 bytes, SHA256
`ea17466b97c9a9d4e2c815538387bf442fb2393ed29632c6f58b2c47ef1f29fe`. It supplies the common canonical trees, length
deltas, repeated offsets and block coding. The strict nested pretree-19 symbol range follows its 0..16 rule rather than
extrapolating the native decoder's permissive range.

The WIM-specific profile is reconciled against immutable
[wimlib cd5e231c348c255ae5088873b5a66ee0eb96fa07](https://github.com/ebiggers/wimlib/tree/cd5e231c348c255ae5088873b5a66ee0eb96fa07):

| Source                           |  Bytes | SHA256                                                             |
| -------------------------------- | -----: | ------------------------------------------------------------------ |
| `src/lzx_decompress.c`           |  17369 | `3a2dc58cd3ccf2421c505f263c7a2c09bbfaab10f98a5a43ecd363fae14c9cfd` |
| `src/lzx_common.c`               |  10095 | `3ffae81b9d1b2f6b506bb20f4b19fa4f21cc392f17b664cb99cd0e0a383a211e` |
| `src/lzx_compress.c`             | 101144 | `a742de89521660922a6aa3c7fcdaea823fe81de232c7c35089b2376ce837562a` |
| `include/wimlib/lzx_constants.h` |   4031 | `b25b11d5a9005ab6f2665ebbfcb0290fb2f6823f4ec19a7afb0721ed4ebab000` |
| `include/wimlib/lzx_common.h`    |    547 | `b9aae44b7c0d69e972c52eb71d1fa18b91faecd0847d1d396a97a35730436f95` |

Ordinary WIM has no Intel stream header. Every 32 KiB chunk resets its history, recent offsets and previous lengths. The
size bit **one** means 32768; zero precedes the explicit 16-bit size. A source comment in the constants header says the
opposite, but actual pinned compressor/decompressor code and every native receipt establish the implemented rule. E8
reversal is mandatory for compressed chunks, uses chunk-local positions and fixed reference size 12000000, stops before
the last ten bytes and skips each operand whether translated or unchanged. Stored fallback chunks bypass it. Raw blocks
advance to the next coding word even when already aligned. This profile requires zero alignment and odd padding, and
exact packed termination with zero through fifteen unused zero bits. These are explicit selected writer restrictions;
there is no assertion of universal LZX/CAB/LZXD acceptance.

## Native environment and reproduction

The genuine producer ran in a disposable 2 GiB / 2 CPU / 256 PID container based on `opfs-seven-tools:20261105`, image
SHA256 `527d62a5244f4fa71833b4a105a4906ec1c1c7708f64ea2967fa04d96c551dd5`. Signed Debian Bookworm packages `wimtools`
and `libwim15` are version `1.13.6-1`; the binary reports `1.13.5`, retained as the actual binary authority. Independent
7-Zip reports 26.02. The raw adaptation ran in a separate 1 GiB / 1 CPU / 128 PID container from retained
`opfs-wim-tools:20261105` image SHA256 `d49f49a01f02986cf9b9b0a49f5279d4bc1c59b198ed070e0646df42427ced47`. No host
mounts or credentials were required. The exact historical Python sources are now inert snapshots; current TypeScript
commands are documented below.

Archive timestamps and native tool builds may change producer bytes. Compare full extracted original bytes and the
retained tool receipts rather than asserting byte-identical rebuilt WIMs without a pinned native environment.

## Retained file hashes

| File                          | SHA256                                                             |
| ----------------------------- | ------------------------------------------------------------------ |
| `lzx-produce.py.snapshot`     | `99d6d7be176f76d3abb83b967a7ee4acedfad2863a5c748c4691211d382c229a` |
| `lzx-independent.json`        | `ea4e1105d868c359a2a43d41ee3123f34a2395175da84a9579c3860b9311f8ff` |
| `lzx-audit.py.snapshot`       | `8c1ae4663cdf6e9edadc9d73abd5a59218fd41f861e24e9305b8548b6ba53a8d` |
| `lzx-tail-receipt.json`       | `27794a315b771f64fc7bf8fa9d25d8e44df6a429ff978e779dfbf803d8179878` |
| `lzx-raw-produce.py.snapshot` | `5bf25de65dce4bece870a172d6690ff1127cab721c5c6d20004d31602bde2f7a` |
| `lzx-authored.json`           | `2c02c896bfa1b3e77ef62e6e41fc3dc27e14924a8484973064c469e7cf5e195b` |
| `lzx-authored-tail.json`      | `d3d9b7c1d877c07517e7c6a18586a9ededef37fbd7f0c00d35c424025dddd90d` |

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
