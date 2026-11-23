# Inspect an archive and preview one member

Use an addressable byte source to inspect an archive without extracting it into a filesystem. A ZIP directory can locate
selected members. Uncompressed TAR scanning reads headers in order and skips payload extents through the source's range
capability. These APIs return data and bytes; your application owns text, image or media rendering.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openZip } from "@okikio/opfs/archive/zip";

// The application supplies the selected File/Blob. It remains application-owned.
export async function preview(blob: Blob) {
  const ledger = createArchiveLedger({
    maxSourceBytes: 8 * 1024 * 1024,
    maxDecodedBytes: 32 * 1024 * 1024,
    maxOutputBytes: 64 * 1024,
    maxRequests: 128,
  });
  const archive = await openZip(createBlobSource(blob), {
    ledger,
    maxEntries: 10_000,
    maxDirectoryBytes: 2 * 1024 * 1024,
  });
  console.table(archive.entries);
  const entry = archive.entries.find((entry) => entry.kind === "file" && !entry.encrypted);
  if (!entry) return;

  // Planning is deterministic. It does not read bytes or construct a codec.
  console.log(archive.plan(entry.id, { length: Math.min(4096, entry.size) }));
  const result = await archive.read(entry.id, {
    length: Math.min(4096, entry.size),
    ledger,
  });
  console.log(result.integrity, result.work, ledger.inspect());
  return result.bytes;
}
```

The source must declare `stability: "immutable"`, `"provider"`, or `"caller"`. Blob sources are immutable; a remote
object source should bind all reads to its provider version. A caller assertion accepts mutation risk and is weaker
evidence than provider-bound reads. A source with no declared stability is refused before I/O unless you explicitly pass
`allowUnverifiedSource: true`; `archive.source.stability` then remains `"unverified"`. An identity string alone does not
prove stability or authenticity. Changing the source invalidates the directory and its offsets.

## Read selected ZIP bytes and understand their integrity

`openZip()` supports single-disk ZIP and ZIP64 end/directory size metadata with exact integer bounds. Directory entries
retain unique numeric IDs even when names duplicate. UTF-8 names are validated; legacy non-ASCII names need an explicit
`decodeName(bytes)` callback. The parser does not normalize names or extract paths. Directory, codec, encryption and
Unix entry kind are separate facts. Listing an encrypted entry does not mean its payload is readable.

`archive.read(id, { offset, length })` returns a decoded interval. Stored members can map directly to source ranges.
Raw-DEFLATE members decode from their beginning, so a late interval can cost much more than its returned bytes. The
default native codec is feature-tested at execution. A runtime without raw-DEFLATE must receive an explicit `inflate()`
factory returning an independently owned `TransformStream<Uint8Array, Uint8Array>`; no codec is downloaded or silently
substituted. An injected factory failure remains the original error.

Read results distinguish `checksum-pending` from `checksum-verified`. Complete member reads check size and CRC32. For a
partial interval, `verify: true` decodes the complete member and checks its CRC before returning the selected bytes.
This may exceed a preview budget and fail. CRC32 detects accidental corruption; it does not authenticate a publisher or
protect against a maliciously constructed archive. Parsed directory fields are not authenticated.

Legacy ZipCrypto STORED and DEFLATE members accept explicit password bytes; see the complete
[password preview guide](password.md). A partial read can return plaintext with a pending CRC, and even a verified CRC
provides no authentication. Strong/AES encryption profiles, split volumes, extra directory records/signatures and
unsupported compression methods return `ArchiveError` with `code: "unsupported-profile"` when requested. ZIP64 values
above `Number.MAX_SAFE_INTEGER` are refused instead of rounded. Data-descriptor members can be read using their
central-directory sizes; descriptor bytes are not independently verified. Self-extracting or offset-rebased archives
require an explicit supported profile rather than automatic offset guessing.

`maxDirectoryBytes` defaults to 16 MiB and `maxEntries` to 100,000. Each open/read also defaults to 64 MiB source bytes,
4,096 source requests, 64 MiB decoded bytes and 16 MiB returned bytes. A selected output can be smaller than actual
decode work: a native codec may produce a whole chunk before the limit is observed. A producer or codec can allocate
memory internally before OPFS receives that chunk; these counters do not bound arbitrary injected implementation
internals or provide hard CPU deadlines.

`result.work` counts one operation. Pass the same `createArchiveLedger()` value to every nested reader and read to bound
aggregate source requests, source extents, decoded bytes and returned bytes. Archive-level source extents can include
memory rereads; they are not necessarily wire bytes. Share a `budgetSource()` ledger at the actual transport boundary
when physical requests must be bounded separately. Failed attempted work consumes admitted reservations; retrying does
not restore the aggregate budget. Staging, keys, nesting depth and decoder/KDF memory need their own application policy;
this API does not implement arbitrary nested format traversal.

`AbortSignal` is cooperative. A member read retires its owned decoder reader on success, early prefix completion, abort
and failure. Cleanup errors preserve an already observed primary failure. The source remains borrowed, and opening an
archive starts no background worker, timer or connection. A custom codec must honor its stream lifecycle; OPFS cannot
preempt an indefinitely running synchronous decoder.

## Project a strict read-only filesystem

```ts
import { createFileSystem } from "@okikio/opfs";
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";
import { createZipAdapter } from "@okikio/opfs/view/zip";

export async function readFromZip(blob: Blob, path: string) {
  const archive = await openZip(createBlobSource(blob));
  await using filesystem = createFileSystem(createZipAdapter(archive));
  return await filesystem.readFile(path);
}
```

Construction validates the full projection before any member content is read. Duplicate paths, file/directory
collisions, empty or dot components, absolute paths, backslashes, links and special Unix entries are refused. Implicit
parents become synthetic directories. Exact case and Unicode code points remain distinct. This strict view deliberately
rejects archives that the raw archive API can still inspect. Recognized symbolic links are never followed.

The view verifies full-member CRC by default, including when the filesystem asks for a range. This preserves the
available checksum evidence because `readFile()` returns bytes without an integrity envelope. If the application
explicitly accepts unchecked partial content, `createZipAdapter(archive, { verify: false })` allows that policy; use the
raw archive API when you need per-result integrity status. File modification time is currently unknown and represented
as `0`; media type is empty. Streaming read is not advertised: member output is bounded and materialized. Write, remove
and directory-creation admission fails before producer consumption. Closing the filesystem leaves the borrowed
archive/source live.

## Inspect uncompressed TAR

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openTar } from "@okikio/opfs/archive/tar";

export async function readTarMember(blob: Blob) {
  const archive = await openTar(createBlobSource(blob), { maxEntries: 10_000 });
  const member = archive.entries.find((entry) => entry.kind === "file");
  return member ? await archive.read(member.id, { length: Math.min(1024, member.size) }) : undefined;
}
```

`openTar()` scans a known-size random-access source. It supports POSIX ustar headers, bounded PAX local/global metadata
and GNU long-name/long-link records. Header checksums and two terminating zero blocks are checked. Payloads are skipped
using offsets and selected regular-file bytes use ranges. It never follows links. Results say `header-checksum-only`:
TAR supplies no payload checksum or authentication.

For a one-shot `ReadableStream`, use `readTarStream()`; entry bodies are single-use within the visitor callback and
unconsumed payloads are drained under the same budget. `createTarStream()` writes deterministic ustar/PAX streams. See
the [TAR guide](tar.md) for complete examples, metadata precedence, resource ownership and exact limits. Sparse records,
base-256 numeric fields and unsupported special records remain refused. Compressed TAR needs an explicitly bounded
decompression strategy. The [ZIP writer](zip.md) creates a narrower STORED ZIP32 profile than `openZip()` reads.

Focused checks are in `tests/archive.test.ts` and `tests/view.test.ts`. Fixtures were produced with Python 3.9
`zipfile`/`tarfile` plus explicit ZIP64 record assembly; expected content is independent of the parser. Tests cover
selected ranges, duplicates, UTF-8, ZIP64, CRC/header corruption, limits, cancellation and read-only projection.
`bench/archive.bench.ts` compares native byte slicing with cold ZIP open/preview, warm preview and complete CRC reads.
Benchmark timings are workload observations, not security or interoperability certification. Broad format corpora,
browser/Worker execution and exact packed-consumer checks remain separate verification gates.
