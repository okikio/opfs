# Reviewed-execution proposal: test-only MCAP wheel

Inert acquisition completed successfully; see acquisition.json, acquisition-state.json and acquisition.log. SDK
execution was separately approved after producer receipt assertions were strengthened, and completed successfully. See
producer-state.json and independent.json.snapshot. This recipe records the executed ownership and resource boundaries;
reruns need their own quiet resource window.

Use existing explicit image `sha256:4e9b1d5f2972c4b3df05c5fe56f976e02b42a535e6be46bee7c46406fa28cfee` only after cheap
availability and Python 3 version inspection. No new system package or production dependency. A changed base requires a
new receipt.

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
