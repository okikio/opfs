# List a cabinet and preview a stored file

`openCab()` lists a standalone Microsoft Cabinet (CAB) and reads selected ranges from uncompressed folders. A CAB folder
is a compression unit containing file bytes, not a pathname directory. Files can share one physical data block, so a
verified preview may need bytes belonging to neighboring files.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openCab } from "@okikio/opfs/archive/cab";

export async function preview(archiveBytes: ArrayBuffer): Promise<void> {
  const archive = await openCab(createBlobSource(new Blob([archiveBytes])), {
    maxSourceBytes: 4 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxFolders: 256,
    maxEntries: 10000,
    maxBlocks: 10000,
    maxNameBytes: 256,
    maxMetadataBytes: 1024 * 1024,
  });
  const entry = archive.entries.find((entry) => entry.name === "report.txt");
  if (!entry || !archive.folders[entry.folderId]?.readable) return;
  const result = await archive.read(entry.id, {
    length: Math.min(4096, entry.size),
    maxSourceBytes: 65536,
    maxDecodedBytes: 65536,
    maxOutputBytes: 4096,
  });
  console.log(result.bytes, result.integrity, result.blocks, result.work);
}
```

The Blob source supplies immutable bytes. Other sources must declare snapshot `stability` or use the explicit
`allowUnverifiedSource: true` opt-in. An identity string alone is not evidence of stable contents. A changed source
requires a new index; old folder offsets must not be applied to new payloads. The reader borrows the source and never
closes it. It creates no files, follows no paths, runs no archived programs and starts no background work.

## Exact supported profile

The reader accepts a cabinet starting at byte zero with version 1.3, a declared size equal to the full source, at least
one folder, bounded file/folder/block metadata, and no cabinet-set continuation. It validates physical folder extents
and file ranges inside their logical folders. Folder extents may not overlap, and the last extent must end at the
declared source end. Embedded/SFX CABs, trailing signatures/data outside the last folder, previous/next cabinets,
continuation file markers and split/zero-output data blocks are unsupported.

Listing understands NONE, MSZIP, Quantum and LZX compression identifiers but provides payload reads only for exact NONE
compression with no per-CFDATA reserved area. `folder.readable` exposes that distinction. There is no MSZIP, LZX,
Quantum, native encryption or signature-verification claim. Compression parameters remain visible in `compressionCode`
without implying a decoder. Uncompressed blocks must have equal stored/plain sizes and at most 32 KiB plain data. Each
physical block's identity, size, logical folder offset and source payload offset remain inspectable.

Header and folder reserved areas are bounded opaque metadata. They do not become signature evidence. Per-block reserved
bytes can be listed, but `blockReserveBytes > 0` makes the folder unreadable even with `verify: false`. Microsoft's
checksum wording and the independent cabextract implementation differ on whether those reserved bytes participate in
checksum computation. This initial profile refuses that unresolved payload case instead of treating one consumer's
behavior as a universal format rule. Header/folder reserves do not trigger that block-specific refusal.

Entries retain their original IDs, names, folder references, logical offsets, DOS date/time fields and attributes.
Duplicate names stay distinct. ASCII names are accepted without a UTF flag; non-ASCII names require the UTF-8 attribute
and strict UTF-8 decoding. Ambient locale decoding is unsupported. Backslashes, absolute names and traversal components
remain metadata, not host paths. No filesystem view or implicit separator normalization is supplied by this reader.

## A checksum covers a block, not one member

`read(id, { offset, length })` requires a nonnegative exact range inside the file. With the default `verify: true`, each
covering block with a nonzero checksum is read and checked in full. Only the requested interval is retained in the
output array. CAB uses an XOR parity checksum with specific remainder-byte rules, not CRC32 or cryptographic
authentication. The calculation covers the stored payload and the fixed `cbData`/`cbUncomp` header fields. A zero stored
checksum explicitly means absent, even if the computed value could also be zero.

`result.blocks` reports `checksum-verified`, `checksum-absent` or `pending` for each covering physical block.
`block-checksum-verified` means every covering block had a present matching checksum. A checksum-absent block prevents
that aggregate claim. `verify: false` reads only the selected intersections and reports skipped present checksums as
`pending`. Empty ranges read no blocks, return no block evidence and report `none`. No result authenticates the cabinet
directory, filenames, publisher or unexamined blocks.

A three-byte prefix of a small file may read a whole 32 KiB block shared with a neighbor. Corruption in that neighbor
can therefore fail the preview. A late range in a stored folder can skip preceding blocks without replay or full-folder
materialization. There is no full-archive decode and no buffered copy of an entire folder. Returned bytes stay bounded
by `maxOutputBytes`; the complete known local source/request/decode costs are admitted before output allocation. An
explicit shared ledger still reserves aggregate work as each extent is read, so concurrent or nested operations cannot
evade the aggregate limit by resetting per-call policies. Failed reservations are not refunded.

## Budgets, cancellation and recovery

Default per-operation limits are 64 MiB source bytes, 4,096 source requests, 64 MiB inspected/decoded bytes and 16 MiB
returned bytes. Opening also defaults to 256 folders, 100,000 entries, 100,000 total data blocks, 256 encoded bytes per
filename including NUL, and 1 MiB structural metadata. The 256-byte name limit is also the selected format profile's
maximum. Metadata charges include bounded look-ahead within the file table as well as opaque reserved bytes. Listing
reads structural records and skips data bodies in valid cabinets.

`work` separates source bytes, requests, inspected bytes and returned bytes. Checked reads count complete covering
blocks; unchecked/absent-checksum reads count selected intersections. Source counters mean requested archive extents,
not hidden transport allocations or requests inside a custom source. Share `createArchiveLedger()` through open/read
options to bound aggregate operations.

An `AbortSignal` reaches each acquired source read and is checked again afterward, including before empty output. The
archive owns no persistent reader or cleanup handle. Source failures retain their original identity. `ArchiveError`
separates malformed structures, unsupported profiles, checksum failures and exhausted budgets. A caller can reopen a
stable source, select a readable folder, reduce output, explicitly choose unchecked evidence or raise a known work
limit.

## Independent format evidence

The primary references are Microsoft's
[MS-CAB format specification](https://download.microsoft.com/download/4/D/A/4DA14F27-B4EF-4170-A6E6-5B1EF85B1BAA/%5BMS-CAB%5D.pdf)
and [Cabinet Format reference](https://learn.microsoft.com/en-us/previous-versions/bb417343(v=msdn.10)). The
[libmspack CAB reader](https://github.com/kyz/libmspack/blob/master/libmspack/mspack/cabd.c) provided an independent
comparison for the reserved-checksum discrepancy. No upstream implementation source is copied into production.

`tests/fixtures/cab/create.py` invokes genuine gcab v1.5 to produce STORED and MSZIP archives and cabextract v1.9 to
independently consume every original input payload. The corpus includes shared/crossing blocks, a 128 KiB binary file,
empty files, a late member and a UTF-8 filename. Debian bookworm packages were `gcab 1.5-1` and `cabextract 1.9-3` in
the disposable arm64 runner. The
[producer receipt](https://github.com/okikio/opfs/blob/9f2db24/tests/fixtures/cab/provenance.json) pins archive, script
and JSON digests. Its local base image is not publicly pullable; apt modified the producer environment, so the base ID
is not a complete immutable producer image.

`vectors.py` constructs four original mathematical vectors for payload remainder lengths 1, 2, 3 and 0. cabextract must
consume each complete payload successfully. The separate 24 reserved-area diagnostics record both checksum conventions,
consumer success/failure and stderr. Failed cases are not accepted golden format fixtures. Tests list those bounded
records but refuse their payload reads. Local structural adaptations also exercise multiple folders and header/folder
reserve placement; these are explicitly not additional independent producer profiles.

Focused source/runtime tests, installed package/type gates and benchmark timings prove different things. This reader
does not claim browser/provider performance or support for an untested codec from directory recognition alone.

`bench/cab.bench.ts` checks every stored payload against the original input before registering 14 lanes: cold
STORED/MSZIP directory scans, and native preindexed Blob ranges versus warm unchecked, warm block-checked and
cold-index-plus-read operations for small prefixes and a late range in the 128 KiB member. Labels record
source/decoded/output bytes and distinguish the native baseline's missing integrity/budget work. Untimed preflight
validates bytes and work counts; no latency, throughput, scaling or memory result follows from registration alone.
