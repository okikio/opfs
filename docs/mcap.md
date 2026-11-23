# Inspect recorded messages without decoding their payloads

`openMcap` reads channels, schemas and physical message records from an explicitly supplied stable byte source. Select
the `mcap0-uncompressed` profile: this first slice handles MCAP major version 0 with ordinary messages and uncompressed
chunks. It does not load a ROS, Protobuf or other application decoder.

```ts
import { openMcap } from "@okikio/opfs/dataset/mcap";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function previewRecording(source: ByteSourceType, signal: AbortSignal) {
  const recording = await openMcap(source, {
    profile: "mcap0-uncompressed",
    signal,
    maxMessages: 100_000,
    maxMetadataBytes: 8 * 1024 * 1024,
  });
  const first = recording.channels[0];
  const page = recording.messages({
    ...(first ? { channelId: first.id } : {}),
    limit: 64,
    maxScanned: 8192,
  });
  const selected = page.messages[0];
  if (!selected) return { channels: recording.channels, next: page.cursor };
  const preview = await recording.read(selected.id, {
    offset: 0,
    length: Math.min(256, selected.size),
  });
  return {
    channels: recording.channels,
    logTime: selected.logTime.toString(),
    bytes: preview.bytes,
    integrity: preview.integrity,
    work: preview.work,
    next: page.cursor,
  };
}
```

The caller supplies transport, credentials and snapshot stability. The reader borrows the source and never closes it. A
source must carry `immutable`, `provider` or `caller` stability evidence; `allowUnverifiedSource: true` explicitly
accepts its absence. An identity string alone is not stability evidence. Replacing bytes during indexing or verification
invalidates the composition contract.

Opening scans every admitted physical record header, including record headers inside uncompressed chunks. It skips
message and attachment payload extents during indexing; schema bytes and literal metadata are retained within finite
limits. Optional indexes and statistics never determine whether a message exists. A recording with messages outside
indexed chunks still exposes those messages. Compressed chunks refuse opening rather than yielding a silently incomplete
view. Opening's default summary CRC verification does read the complete summary and footer prefix.

## Page and select

`recording.messages()` returns physical file order, without a hidden timestamp sort. `id` is a snapshot-local ordinal.
`sequence` is the writer's counter and can repeat. Both nanosecond timestamps remain exact `bigint` values, including
values larger than Number can represent; their epoch is defined by the recording's application. Time filters use an
inclusive start and exclusive end.

Pagination has two independent bounds: `limit` controls returned messages (default 256, hard 4096), and `maxScanned`
controls descriptors examined (default 8192, hard 65536). A sparse filter can return an empty page with a continuing
numeric `cursor`. Reuse that cursor with the same recording and filter. An absent cursor means the physical message list
has ended; it is not a statement about recordings that were never supplied.

`read(id, { offset, length })` returns an owned message-relative interval. `readAttachment` does the same for
attachments. An out-of-range interval refuses instead of clamping. Attachment names, topics, encodings, schemas and
metadata are literal data. The reader never follows a path or URL, renders HTML, executes a schema, or applies
attachment metadata to a host filesystem.

`recording.source(id)` and `attachmentSource(id)` expose raw payload `ByteSourceType` views for composition with another
reader. They retain the original stability evidence, unambiguous physical tuple identity when an identity exists,
opening/view/read signals and all distinct ancestor ledgers. They **do not verify a checksum**. Their read results are
owned copies. Opening cancellation cannot be overridden with a fresh child signal. Source callbacks and their resources
remain caller-owned.

## Know which bytes were checked

CRC 32 detects accidental corruption; it does not authenticate the recording or its producer. Every result names a scope
and status:

| Scope        | Covered bytes                                                                      | Default behavior                                                                               |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `summary`    | Summary and summary-offset bytes, then the footer opcode, length and both offsets  | Opening verifies an available CRC unless `verifySummary: false`                                |
| `chunk`      | Entire uncompressed chunk's record bytes                                           | A selected chunked-message read verifies an available CRC, even for an empty selected interval |
| `attachment` | Attachment fields and payload preceding its CRC, excluding its outer record header | A selected attachment read verifies an available CRC                                           |
| `data`       | File start through the byte before DataEnd                                         | Explicit `verify({ scope: "data" })`; ordinary unchunked message reads leave this pending      |

`status: "not-provided"` means the stored CRC is zero. `pending` means a CRC exists but the operation did not check it.
`verified` names only that complete unit. It does not validate optional index contents, application serialization,
timestamps' real-world truth or unrelated CRC scopes. `read(..., { verify: false })` provides an explicit unchecked
interval; a raw payload source is always unchecked.

Use `verify({ scope: "summary" | "data" })`, or `verify({ scope: "chunk" | "attachment", id })` to request a complete
unit. Verification reserves the complete source-byte/request cost before acquiring scratch or returning selected output,
then reads in at most 64 KiB intervals. It does not materialize a whole chunk. Failed attempts retain reserved work;
there is no refund that lets repeated failures evade quotas. Selected reads count both whole-unit verification and the
subsequent selected interval, including overlapping bytes.

With no summary, the selected writer profile computes an available summary CRC over the footer prefix alone. The
independent native zero-summary fixture confirms CRC 1875167664 over that 25-byte prefix. It never means hash from file
byte zero when `summary_start` is zero.

## Admission, costs and refused profiles

The following are local implementation safety limits, not MCAP format limits. Policies can be lowered, and hard ceilings
cannot be raised.

| Policy                             |   Default | Hard ceiling |
| ---------------------------------- | --------: | -----------: |
| Messages retained                  |   100,000 |    1,000,000 |
| Physical plus nested record visits | 1,000,000 |    4,000,000 |
| Metadata/descriptor reservation    |     8 MiB |       64 MiB |
| One opaque schema                  |     1 MiB |        8 MiB |
| One UTF8 field                     |    64 KiB |        1 MiB |
| One map's entries                  |      4096 |       65,536 |
| One uncompressed chunk             |    64 MiB |      256 MiB |
| One complete verification unit     |    64 MiB |      256 MiB |
| One returned interval              |     8 MiB |       64 MiB |

Flat message columns are acquired in groups of at most 256 rows,44 typed-array bytes per row, before insertion. Metadata
reservation additionally counts strings conservatively at twice their UTF8 bytes, schema and extension bytes, and fixed
descriptor/map-entry allowances. It is a conservative policy count, not a precise JavaScript heap measurement. Repeated
definitions count repeated parsing work. Public schema byte copies count opening output bytes; caller mutation cannot
change the reader's retained definition authority.

Generic `maxSourceBytes`, `maxRequests`, `maxDecodedBytes` and `maxOutputBytes` and an optional external `ledger` apply
too. Opening's local ledger is a lifetime owner: later reads cannot reset its quotas by passing new options. Each
operation adds its own finite local limits. The same external ledger is deduplicated by identity when passed again, with
at most 16 total inherited owners including generated local owners. Counts reserve before source callbacks and before
result allocation. Zero-copy transport and allocations inside a supplied source callback are outside this reader's
control. `work` reports requested source bytes, requests, returned bytes, metadata reservation and record visits; no
decompression occurs in this profile.

Repeated Schema/Channel IDs must agree, and their definitions must precede references. Map key order may differ, but
duplicate map keys refuse this profile. UTF8 is fatal and preserves a literal leading BOM. Unknown nonzero opcodes and
extensible fields have admitted physical extents; opaque records are visible, with no semantic-validity claim. Zero
opcode, unsafe uint64 address arithmetic, section framing errors, nested chunks and attachments inside chunks refuse.
LZ4, Zstandard, index-driven random lookup and payload decoding are pending separate implementations. This API does not
claim complete MCAP conformance.

## Evidence and reproduction

The normative binary grammar is
[MCAP specification at foxglove/mcap 23d6c627](https://github.com/foxglove/mcap/blob/23d6c627a27ac089d418d9e7f8cdcef9ed86dac1/website/docs/spec/index.md),
SHA256 `4197b0200bb5c657d2a97e70816b078fdb050a9027f030c342c2862a3c33b3b6`. MIT license and immutable source receipts
belong with the fixtures.

Authored tests exercise framing, bigint timestamps, scopes, duplicate authority, bounded paging, inherited cancellation
and byte-slot admission. The separately reviewed recipe in `tests/fixtures/mcap/native-recipe.md` proposes the test-only
Python `mcap==1.6.0` wheel, exact SHA256, NONE writer and two native consumer paths with independently authored original
payloads. The exact wheel was acquired without installation or setup and executed offline under 1 GiB/1 CPU/128 PID
quotas. Native uncompressed chunked 2689 B, unchunked 1842 B, zero-summary 1348 B and empty 322 B files retain all
original message bytes, exact timestamps, schema bytes, attachment bytes and metadata receipts. Raw producer JSON SHA256
is `2606def430cd78c19ac9098b0fd8f294cabd0b52b004a3bf2fb9668ff2c6eb8d`; `independent.json.snapshot` preserves those
bytes. The wheel has no bundled LICENSE member; its METADATA declares MIT and the pinned repository MIT license is
retained separately. Both reader paths are from one implementation, so they will not prove cross-vendor
interoperability. Upstream conformance binaries represented by Git LFS pointers have not been resolved and are not
claimed as coverage.

## Measured workload

The six lanes in `bench/mcap.bench.ts` use the genuine 2689-byte uncompressed chunked fixture with seven messages in
five chunks. Untimed preflight compares all original payload bytes and exact timestamps, the selected 32-byte interval,
scoped verified/pending states, and the empty sparse page's scanned count and continuing cursor. The borrowed-range
lower bound, cold index, sparse page, verified interval, unchecked interval and whole-data check perform different work.

One quiet offline run used Node 26.13.0 on ARM64 Linux with 1 GiB RAM, swap disabled,1 CPU and 128 PIDs. Median observed
costs were5.00 µs for a raw 32-byte borrowed range,685.71 µs for cold physical indexing,0.68 µs for an empty sparse
page,22.45 µs for a32-byte interval plus its whole299-byte containing chunk check,8.11 µs for the unchecked32-byte
interval, and 37.22 µs for the complete 1730-byte data CRC. Cold indexing's p99 was 18.20 ms; distributions are workload
observations, not stable throughput guarantees or an equivalent-operation speed comparison.

`tests/fixtures/mcap/benchmark.json` records all lane names, work counts, p50/p99, sample counts, exact
runtime/image/resource facts and input hashes. Raw Mitata JSON was 19,766,657 bytes, SHA256
`be6375ad76f14f5756fc99a0156226d7c4728e16fd807e59351a936b452c0a7a`; its verified lossless gzip was 62,316 bytes, SHA256
`f0ec8714d41f363a217f540ed0230c17b37f312976f65be99615af82bc28f3b1`. Warm sampling has explicit64 GiB/10 million-request
lifetime allowances; ordinary per-read defaults remain finite. Fixture acquisition, SDK execution and base64 decoding
are outside timing.
