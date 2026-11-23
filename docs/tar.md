# Inspect and write TAR archives

Use `openTar()` when you have a stable byte-range source and want reusable member IDs or selected ranges. Use
`readTarStream()` for a one-shot source such as a response body. The streaming reader visits entries in archive order;
it must read preceding payloads even when you only want a late member. Neither API extracts host files or follows links.

This complete example writes an archive, then consumes one member without collecting the archive or its payload:

```ts
import { createTarStream, readTarStream } from "@okikio/opfs/archive/stream";

const archive = createTarStream([
  { name: "notes/hello.txt", size: 5, body: new Blob(["hello"]).stream() },
  { name: "empty/", kind: "directory", size: 0 },
]);
const decoder = new TextDecoder();
const result = await readTarStream(archive, async (entry, body) => {
  console.log(entry.id, entry.name, entry.kind, entry.size);
  if (entry.name === "notes/hello.txt") {
    for await (const bytes of body) console.log(decoder.decode(bytes, { stream: true }));
    console.log(decoder.decode());
  }
}, {
  maxSourceBytes: 1024 * 1024,
  maxDecodedBytes: 64 * 1024,
  maxOutputBytes: 1024,
  maxEntries: 100,
  maxMetadataBytes: 16 * 1024,
  maxChunkBytes: 64 * 1024,
});
console.log(result.complete, result.work);
```

The callback receives metadata before member bytes are requested from the cursor. Producer chunks can include later
bytes already; that read-ahead is bounded by `maxChunkBytes` and charged as source work. Await each body operation
before returning from the callback. A body is a single-use async iterable, valid only during that callback. It is not a
reusable file handle. A symbolic or hard link has an empty body, and its target remains metadata.

To list names, ignore the body. To preview a prefix, stop iterating that body; the reader drains its remainder before
visiting another entry. That drain still consumes source and decoded budgets. To stop the archive scan immediately,
return `false` from the callback. The result then has `complete: false`; later members and end markers were not checked.
`bodyChunkBytes` limits each delivered body view (default 64 KiB). For a three-byte prefix, set `bodyChunkBytes: 3` and
`maxOutputBytes: 3`, consume one body chunk, then return `false`; producer read-ahead still counts separately.

## Read a selected range from a stable source

An indexed scan retains a bounded metadata array, skips payload extents, and borrows the source. It requires declared
stability, as described in [byte sources](source.md). For example, a Blob source provides immutable bytes:

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openTar } from "@okikio/opfs/archive/tar";

export async function readNote(file: Blob): Promise<Uint8Array> {
  const ledger = createArchiveLedger({ maxSourceBytes: 8 * 1024 * 1024, maxOutputBytes: 4096 });
  const archive = await openTar(createBlobSource(file), { ledger, maxEntries: 10_000 });
  const entry = archive.entries.find((entry) => entry.name === "notes/hello.txt" && entry.kind === "file");
  if (!entry) throw new Error("notes/hello.txt is missing");
  const result = await archive.read(entry.id, { offset: 0, length: Math.min(4096, entry.size), ledger });
  return result.bytes;
}
```

Names can repeat. IDs preserve archive order and distinguish duplicates; choosing the first name is application policy,
as in this example. No path normalization or traversal protection is implied by metadata inspection. The optional
read-only filesystem projection below validates names, duplicate paths, collisions and links before exposing entries; it
is not an extractor.

`openTar()` rejects an undeclared source unless `allowUnverifiedSource: true` explicitly accepts mutation risk. An
identity string alone does not prove a snapshot. Indexed reads return `integrity: "header-checksum-only"`: TAR checksums
protect headers, not payload content or authenticity. A selected range has no content checksum to verify.

## Preview logical ranges in GNU sparse files

A sparse file stores selected recorded intervals and omits zero-filled holes. `openTar()` recognizes GNU PAX sparse 1.0
using all four explicit version, name and real-size attributes. It consumes the decimal sparse map and its zero padding
before indexing file data. `entry.size` is the logical file length. Optional `entry.sparse` describes the exact
`gnu-pax-1.0` profile, physical `storedSize` including map padding, `mapBytes`, and ordered `extents`. Each extent has a
logical `offset`, a `length` and a `storedOffset` relative to the physical data after the map. Zero-length terminal
records are retained. Ordinary entries have no `sparse` property.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openTar } from "@okikio/opfs/archive/tar";

export async function sparsePreview(blob: Blob): Promise<Uint8Array | undefined> {
  const archive = await openTar(createBlobSource(blob), {
    maxSparseBytes: 64 * 1024 * 1024,
    maxSparseExtents: 4096,
    maxMetadataBytes: 1024 * 1024,
  });
  const entry = archive.entries.find((item) => item.sparse);
  if (!entry) return undefined;
  return (await archive.read(entry.id, {
    offset: Math.min(4096, entry.size),
    length: Math.min(37, Math.max(0, entry.size - 4096)),
    maxSourceBytes: 37,
    maxOutputBytes: 37,
    maxDecodedBytes: 37,
  })).bytes;
}
```

The selected result is a zero-filled owned buffer. The reader requests only the physical extents intersecting that
logical interval; a selection inside a hole makes zero source requests. Logical selected bytes count against decoded and
output policies even when no payload was stored. Header checksums do not protect the sparse map or file data, so the
result remains `integrity: "header-checksum-only"`. The existing read-only TAR filesystem view reads these same logical
ranges after its normal namespace admission.

`maxSparseBytes` limits the sum of logical lengths declared by sparse members (default 64 MiB); it does not impose a new
logical-size cap on ordinary members. `maxSparseExtents` limits all declared sparse records, including empty records
(default 100,000). `maxMetadataBytes` includes padded sparse maps and PAX/GNU extension payloads. Map bytes and a
logical 24-byte charge for each retained extent also count as decoded work. These charges bound admission, not exact
JavaScript heap use. The parser rejects unsafe integers, overlaps, out-of-order extents, extents beyond logical EOF,
nonzero map padding and a recorded-data sum different from the physical payload. A map may span several 512-byte blocks.
Decimal map fields are limited to 20 digits, including leading zeros. An entire archive or logical member is never
materialized during indexing.

The shared one-shot reader deliberately rejects sparse metadata before visiting the member; compressed-TAR helpers
inherit that refusal. The writer has no sparse-map input contract. These paths do not silently expose the condensed
physical member as if it were the logical file. GNU sparse 0.0/0.1, old GNU `S`, and other vendor layouts need separate
implementations.

Indexed TAR captures source capabilities and options before the first await. Stability must be exactly `immutable`,
`provider` or `caller` unless explicit unverified acceptance is enabled. Opening limits and any opening ledger remain
aggregate lifetime limits for subsequent reads. Additional read ledgers join that owner; the same opening ledger is not
charged twice. Opening and read abort signals are combined, including zero-length and hole-only selections. Known source
byte/request costs are admitted before selected allocation, and reservations are not refunded if a later admission
dimension or source operation fails. The borrowed source is never closed or cancelled.

Genuine GNU tar 1.34 `--format=pax --sparse-version=1.0 --sparse` fixtures include all-hole, leading/trailing-hole,
multi-block-map, empty and ordinary members. Python `tarfile` and libarchive 3.6.2 independently reconstruct every
original byte. 7zz 26.02 returns success with different bytes for sparse members; the producer receipt records that
behavior explicitly rather than counting it as interoperability evidence. Genuine 0.0/0.1 fixtures are refusal controls.
[The primary GNU manual](https://www.gnu.org/software/tar/manual/html_section/Sparse-Formats.html) describes the map
grammar; [fixture provenance](https://github.com/okikio/opfs/blob/827bdbe/tests/fixtures/tar-sparse/provenance.json)
pins its hash and tool receipts.

## Supported records and limits

The reader accepts POSIX ustar headers and PAX `x`/`g` extended headers, plus GNU header magic and `L`/`K` long-name and
long-link records. It returns regular files, directories, symbolic links and hard links. UTF-8 names remain literal. PAX
`path`, `linkpath` and unsigned decimal `size` override ordinary fields; global records persist, local records apply to
the next member, later duplicate keys replace earlier keys, and an empty local value suppresses a global override for
that member. Metadata records have byte-counted UTF-8 lengths and strict newline framing. Other attributes such as
owner, times, ACLs and xattrs are not returned or applied. Supported UTF-8 `hdrcharset` is recognized; binary/other
encodings are refused.

Indexed reads also support the exact GNU PAX sparse 1.0 profile described below. One-shot streams and writers still
refuse sparse records. GNU `S`, sparse PAX 0.0/0.1 and other sparse profiles are refused. Devices, FIFOs, non-file
payloads/linkdata, base-256 sizes without a PAX size override, split volumes, legacy/non-UTF-8 names, compression and
encryption are unsupported profiles. No link resolution is attempted. Unknown ordinary PAX attributes are ignored; their
presence is not evidence that this library interprets that extension. Exact sizes must fit a JavaScript safe integer.

Two zero blocks are required. A pending local extension without a following member is invalid. Trailing record padding
or bytes after the valid end marker are ignored; `complete: true` means this archive's member sequence ended, not that
the entire underlying response was authenticated or consumed. Stream completion cancels the remaining source.

| Policy             | Default | Effect                                                                                                                                                        |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxSourceBytes`   | 64 MiB  | Indexed reads count requested extents. Streaming reads count whole chunks acquired from the producer, including skipped data and read-ahead.                  |
| `maxRequests`      | 4096    | Indexed source reads, or stream producer reads including empty chunks and EOF attempts.                                                                       |
| `maxDecodedBytes`  | 64 MiB  | TAR needs no decompressor: this counts extension payloads and all consumed member payloads, including discarded bytes. Headers and padding do not count here. |
| `maxOutputBytes`   | 16 MiB  | Payload bytes delivered to the stream visitor, or bytes returned by one indexed member read.                                                                  |
| `maxEntries`       | 100,000 | Reader header count, including extension headers. This prevents an extension-only input from bypassing admission.                                             |
| `maxMetadataBytes` | 1 MiB   | Cumulative PAX/GNU extension payload bytes, before allocation or parsing. It bounds persistent and pending extension state.                                   |
| `maxChunkBytes`    | 64 KiB  | Stream-only producer chunk admission. Oversized chunks are rejected after receipt; the producer controls its own allocation.                                  |
| `bodyChunkBytes`   | 64 KiB  | Stream-only body delivery view size, independent of producer chunk admission.                                                                                 |

Limits are finite per operation; indexed readers additionally retain their opening limits as aggregate lifetime limits.
Share a caller-owned `ledger` to join source/decoded/output/request budgets across separate scans, reads and nested
operations. Reservations are not refunded after failure. Stream listing returns `outputBytes: 0` if no body is consumed;
it still pays to read/discard payloads. Metadata and payload copies are bounded, but there is no hard wall-clock or
CPU-time guarantee. A producer can stall or allocate before the library receives data.

The stream reader owns the reader it acquires: it cancels it and releases its lock on completion, callback `false`,
abort and failure. `signal` cancels a pending source read. Callback errors retain their identity when cleanup also
fails. Cancellation cannot force an arbitrary visitor promise or upstream cancellation hook to settle; those owners must
cooperate. A failed or stopped stream cannot be replayed or resumed automatically. Reopen a source explicitly to retry.
An indexed source remains borrowed and is never disposed by the archive.

## Write a streaming TAR

`createTarStream(entries, options)` accepts a synchronous or asynchronous sequence, consumes it once in order, and
returns a Web `ReadableStream<Uint8Array>`. Each entry supplies `name`, known `size`, optional `kind` (default `file`),
optional `link`, and an optional Web-stream `body`. Nonempty files require a body. Non-file entries require zero size
and no body. The writer detects bodies shorter or longer than the declaration. Such failure can happen after earlier
archive bytes were emitted; the destination owns rollback or publication of partial output.

The writer emits deterministic POSIX ustar records, adding PAX `path`, `linkpath` and `size` records for names/links
that need UTF-8 or exceed base fields and sizes that exceed octal fields. It uses zero owner IDs/times and ordinary file
or directory modes. It does not discover host metadata or preserve arbitrary PAX attributes, permissions, ACLs or
xattrs. There is no sparse writer. The output ends with two zero blocks, with no required 10 KiB record padding.

Output is pull-driven with a zero-size queue: a paused downstream consumer does not cause new body reads. The writer
retains the current body chunk, emits it without whole-file buffering, and validates its size and limits. It acquires
body readers lazily and owns their cancellation/release. Cancelling output cancels the current body and returns the
entry iterator. Async entry producers must cooperate with cancellation of their own pending operations; an arbitrary
pending `next()` promise cannot be forcibly stopped. Entry resources not yet acquired remain the caller's
responsibility.

Writer options use the same finite defaults, with these accounting differences: `maxEntries` counts supplied members;
source/request/decoded work counts body reads/bytes; `maxOutputBytes` includes all emitted headers, metadata, padding
and end blocks. `maxMetadataBytes` bounds cumulative generated PAX payloads. `maxChunkBytes` bounds acquired body
chunks. Share `ledger` to inspect aggregate reservations and combine writer limits with other operations. There is no
resumable TAR write checkpoint or concurrent member writer.

## Evidence and maintenance

`tests/fixtures/tar/create.py` independently produces the inert PAX/GNU archives in `independent.json` using Python
3.9.6 stdlib `tarfile`. That file records producer names, SHA-256 hashes, entry metadata and complete expected payload
bytes. `tests/tar.test.ts` checks every possible two-chunk split of the 10,240-byte PAX fixture, independently produced
payloads, corrupt/truncated metadata, budgets, backpressure, body lifetime and cancellation. `tests/tar-process.test.ts`
sends writer output to Python `tarfile` and the system BSD/GNU `tar` with bounded subprocesses; extraction goes to
stdout, not host paths. Local independent consumers were Python 3.9.6 and bsdtar 3.5.3/libarchive 3.7.4. These are
compatibility cases, not an exhaustive TAR corpus or a performance claim.

The framing follows the [POSIX pax specification](https://pubs.opengroup.org/onlinepubs/9799919799/utilities/pax.html)
and [GNU TAR format documentation](https://www.gnu.org/software/tar/manual/html_node/Standard.html). The independently
implemented [Python tarfile source](https://github.com/python/cpython/blob/v3.13.0/Lib/tarfile.py) also documents GNU
magic, long-record identities and PAX override fields. Those references describe broader profiles than this
implementation; the explicit support and refusal rules above define this API's contract.

## Browse an indexed TAR as a read-only filesystem

```ts
import { createFileSystem } from "@okikio/opfs";
import { createBlobSource } from "@okikio/opfs/source";
import { openTar } from "@okikio/opfs/archive/tar";
import { createTarAdapter } from "@okikio/opfs/view/tar";

export async function preview(file: Blob): Promise<Uint8Array> {
  const archive = await openTar(createBlobSource(file), { maxEntries: 10_000 });
  const fs = createFileSystem(createTarAdapter(archive, {
    maxSourceBytes: 4096,
    maxDecodedBytes: 4096,
    maxOutputBytes: 4096,
  }));
  try {
    return await fs.readFile("/notes/hello.txt", { at: 0, length: 4096 });
  } finally {
    await fs[Symbol.asyncDispose]();
  }
}
```

The adapter admits the entire namespace before payload acquisition. It refuses duplicate paths, absolute paths,
dot/empty components, backslashes, file/directory collisions and all symbolic or hard links. Direct reader metadata
inspection still permits these literal archive names; choosing a filtered subset is explicit application policy.
Implicit parent directories are synthesized. No entry is extracted to the host, and no link is followed.

Each selected read uses the archive's exact payload extent and clamps filesystem reads at EOF. The adapter buffers that
selected result; it does not advertise streaming or payload verification. TAR header checksums never authenticate file
content, and the filesystem's byte result does not add integrity evidence. Use the direct reader when that evidence must
travel alongside bytes. Per-read budgets join the archive's retained opening limits and any caller-owned ledger. Closing
the filesystem leaves the archive and source usable. Mutations are refused before acquiring producer bytes. Cancellation
follows the filesystem's `FileSystemError` with `code: "aborted"` and the original cause; direct adapter reads retain
the original abort reason.
