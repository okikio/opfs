# MCAP native proof recipes

For current executable commands, use the [native C++ recipe](#current-native-c-recipe). The wheel section immediately
below is a historical execution record. Its old Python paths identify inert snapshots and must not be run.

## Historical Python wheel execution

Inert acquisition completed successfully; see acquisition.json, acquisition-state.json and acquisition.log. SDK
execution was separately approved after producer receipt assertions were strengthened, and completed successfully. See
producer-state.json and independent.json.snapshot. This recipe records the executed ownership and resource boundaries;
reruns need their own quiet resource window.

The historical run used explicit image `sha256:4e9b1d5f2972c4b3df05c5fe56f976e02b42a535e6be46bee7c46406fa28cfee` only
after cheap availability and Python 3 version inspection. No new system package or production dependency. A changed base
requires a new receipt.

Acquisition container: 1 GiB RAM, 1 CPU, 128 PIDs, no host mounts or ports. Copy `acquire.py` into its owned `/tool/`;
run `python3 /tool/acquire.py /tool/acquired` with a 90-second outer deadline. The script downloads exactly the
21,955-byte PyPI `mcap==1.6.0` wheel, verifies SHA256
`7cd37fba2cf51d033f2139ca837d2ed3024dcec3cd9f8ecdf3d4d15930df6e17`, refuses every HTTP redirect before following it,
bounds ZIP member count and all declared expanded extents before extraction/inspection, restricts members to the exact
package/dist-info roots, refuses duplicate/empty/dot/parent/backslash paths, encrypted or special members and
unsupported compression methods, records every member hash, and copies only writer/reader metadata and license receipts.
No setup, pip, dependency installation or package execution occurs. Inspect actual optional codec imports in this exact
wheel before native execution; refuse execution if NONE cannot avoid the declared lz4/zstandard dependencies.

After inspection, commit only the task-owned state to an identified tool image. Execute a second container with the same
quotas and `--network none`, no mounts or ports,
`timeout 90s python3 /tool/produce.py /tool/acquired/mcap-1.6.0-py3-none-any.whl /tmp/mcap-independent.json`. Python
zipimport uses the exact wheel without installation. Capture actual Python/version/image, package metadata/licenses,
command/state/logs and resource readback. Copy output only after exit 0. Remove only task-owned stopped containers/tool
image after durable receipts.

The candidate-free producer writes uncompressed chunked, unchunked, zero-summary and empty files with native Writer.
Both native StreamReader and seeking reader compare every message byte against authored originals. Both paths also
compare complete schema and attachment bytes, channel metadata and named metadata against authored values. These are two
code paths of the same implementation, not cross-vendor proof. The harness independently computes summary CRC including
the footer prefix; when `summary_start=0`, it hashes the footer prefix alone, never the file from byte zero. Actual
native receipts must settle that edge before candidate assertions. Nanosecond timestamps exceed Number precision. Opaque
binary schema/message/attachment data and Unicode metadata remain raw byte oracles. Test-only MIT wheel; no runtime SDK
in the library. Native subprocess outputs are captured in the bounded container; this is not a streaming-output memory
guarantee.

The pinned major-0 specification is foxglove/mcap `23d6c627a27ac089d418d9e7f8cdcef9ed86dac1`, SHA256
`4197b0200bb5c657d2a97e70816b078fdb050a9027f030c342c2862a3c33b3b6`. Git LFS conformance binaries have not been resolved.
No conformance or additional compression claim follows from these fixtures.

## Current native C++ recipe

The wheel recipe above is historical evidence. Its exact Python tools remain inert `.py.snapshot` sources, bound by
`source-map.json`; the old native JSON and receipts are unchanged. The current tools acquire and use the official MCAP
C++ implementation at the same primary commit `23d6c627a27ac089d418d9e7f8cdcef9ed86dac1`. `upstream-cpp.json` pins all
13 header/inline files and the original MIT license by exact Git blob and byte count. The SDK reports C++ version 2.2.0.
No MCAP SDK is added to the production library or ordinary test dependency graph.

First copy the relative fixture tree into an owned pinned official Node container: `/tool/acquire.ts`, `/tool/group.ts`
and `/tool/mcap/{acquire.ts,produce.ts,crc.ts,native.cpp,upstream-cpp.json}`. The acquisition stage needs network access
and a fresh destination:

```sh
node /tool/mcap/acquire.ts --output /evidence/mcap-source
```

It refuses redirects, checks exact immutable Git blob/size identities, limits each response to 128 KiB (with a 1 KiB
transport/body allowance for smaller headers) and aggregate source to 512 KiB, and shares one 90-second acquisition
deadline. It never compiles or executes acquired code. Complete inputs remain `.snapshot` files; successful admission
publishes a fresh staged directory. Inspect its receipt and source closure before separately executing native code.

In a separately reviewed Linux tools image, use the same 1 GiB memory/swap, one CPU, PID128, no mounts/ports and
`--network none` producer envelope. Record the exact official Node base, admitted compiler package/version/architecture,
complete changed-package notices and any derived image ID before execution. The fixture does not install a compiler or
use an unpinned host toolchain. Copy admitted inputs into that container; do not mount them. Then run:

```sh
node /tool/mcap/produce.ts --acquired /evidence/mcap-source \
  --output /evidence/mcap-cpp-run --compiler /usr/bin/g++
```

The output directory must be fresh. The wrapper checks every acquired source against the reviewed manifest again,
reconstructs only that header closure, retains the MIT license, records compiler version and builds the authored small
`native.cpp` harness with C++17. `MCAP_COMPRESSION_NO_LZ4` and `MCAP_COMPRESSION_NO_ZSTD` keep the NONE build
independent of codec packages. Compilation has a 60-second process-group deadline, 1 MiB combined diagnostic cap and 64
MiB individual file cap; the compiler-version query has separate 10-second/64 KiB caps. Native production has a
30-second process-group deadline, 1 MiB log cap and 256 KiB individual output cap. All failed stages retain partial
evidence and retirement faults; no failed stage publishes a complete acquisition/producer directory.

The C++ writer creates four new files with the same authored original bytes and uint64 timestamps: chunked, unchunked,
zero-summary and empty. `TypedRecordReader` verifies all messages, schemas, channel metadata, attachments and named
metadata through its callback path. A separate `McapReader` checks message views and uses native summary indexes for
attachments/metadata. Chunked message iteration uses native log-time indexes; other profiles use file-order iteration.
The zero-summary profile explicitly allows native fallback scanning. Every parser status is checked after iteration;
missing or extra originals fail instead of producing a success flag. Borrowed native payloads are compared before
advancing the reader.

### Checksum evidence has a different owner

The pinned C++ reader does not validate CRCs. Its native full-byte comparisons must never be described as CRC refusal
proof. The old Python `validate_crcs=True` evidence remains independently preserved. The new `crc.ts` contains an
authored, bounded MCAP NONE framing walker, while Node's built-in
[`zlib.crc32`](https://nodejs.org/api/zlib.html#zlibcrc32data-value) provides the independent checksum primitive. That
API is available from Node20.15/22.2 onward; the current pinned Node26 environment supplies it. No production CRC
function, MCAP SDK CRC routine or third-party JS checksum dependency is used by this verifier.

The walker checks every enabled native-writer scope: DataEnd over all preceding file bytes, each uncompressed chunk,
each complete attachment body except its checksum, and summary bytes plus the 25-byte footer prefix. Zero-summary starts
at the footer prefix itself. For every scope it separately changes one covered byte and one checksum byte, then requires
the independent checksum comparison to refuse both. The original native file is unchanged. These controls prove the
authored scope check detects those alterations; they do not prove a native C++ reader rejects corrupted CRCs.
`independent.json` in the new owned output labels that distinction and records all scope offsets/control owners. This
new output must not overwrite the historical checked-in fixture or adopt its native/Python receipt identities.

Source review and primary API inspection support this recipe. A fresh compiler/native run, runtime/package tests and
recorded resource/retirement state must still qualify it before claiming current execution proof. Do not infer native
success from source compilation alone or from the unchanged older wheel receipts.
