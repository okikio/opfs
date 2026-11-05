# List a cabinet and preview a file

`openCab()` lists a standalone Microsoft Cabinet (CAB) and reads selected ranges from NONE or MSZIP folders. A CAB
folder is a compression unit containing file bytes, not a pathname directory. Files can share one physical data block,
so a verified preview may need bytes belonging to neighboring files.

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
or MSZIP compression with no per-CFDATA reserved area. `folder.readable` exposes that distinction. LZX, Quantum, native
encryption and signature verification are unsupported. Compression parameters remain visible in `compressionCode`
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
required block with a nonzero checksum is read and checked in full. For NONE this means covering blocks; MSZIP also
requires every earlier block in the folder to reconstruct its dictionary. Only the requested interval is retained in the
output array. CAB uses an XOR parity checksum with specific remainder-byte rules, not CRC32 or cryptographic
authentication. The calculation covers the stored payload and the fixed `cbData`/`cbUncomp` header fields. A zero stored
checksum explicitly means absent, even if the computed value could also be zero.

`result.blocks` reports `checksum-verified`, `checksum-absent` or `pending` for each required physical block, with
`role: "covering"` or `"history"`. `block-checksum-verified` means every required block had a present matching checksum.
A checksum-absent block prevents that aggregate claim. For NONE, `verify: false` reads only selected intersections and
reports skipped present checksums as `pending`. Empty ranges read no blocks, return no block evidence and report `none`.
No result authenticates the cabinet directory, filenames, publisher or unexamined blocks.

A three-byte prefix of a small file may read a whole 32 KiB block shared with a neighbor. Corruption in that neighbor
can therefore fail the preview. A late range in a stored folder can skip preceding blocks without replay or full-folder
materialization. There is no full-archive decode and no buffered copy of an entire folder. Returned bytes stay bounded
by `maxOutputBytes`; complete known local and aggregate source/request/decode/output costs are admitted before output
allocation or payload I/O. Actual reads consume that admission without charging it twice. Failed reservations are not
refunded.

## MSZIP replays folder history

MSZIP uses RFC 1951 DEFLATE blocks with a `CK` prefix, but its 32 KiB dictionary survives between CFDATA units. Opening
still skips their payloads. Reading a late range decodes from the start of its folder through the last covering unit,
even with `verify: false`. No persistent decoded cache is created. A one-byte preview near the end of a large folder can
therefore exceed default request or decoded-work limits; raise those policies deliberately or choose a smaller preview
earlier in the folder. Empty ranges perform no replay.

The internal decoder reads stored, fixed-Huffman and dynamic-Huffman DEFLATE blocks directly. Web
`DecompressionStream("deflate-raw")` has no preset-dictionary parameter, and native EOF alone is not used as evidence of
exact compressed consumption. Each packed unit must be at most 32,780 bytes including `CK`, decode to its declared
1..32,768 bytes, terminate with BFINAL and leave no whole trailing byte. RFC-defined unused bits in the final byte are
ignored. Invalid trees, absent end markers, reserved symbols, impossible backward distances and output overruns fail
without returning partial bytes. No salvage mode exists.

Decoding retains at most 32 KiB of preceding folder bytes and one current block of at most 32 KiB. Packed input is
bounded separately. Huffman tables have at most 288 literal/length and 32 distance symbols; the code-length alphabet has
19 symbols. These are implementation scratch bounds, not user-selectable output budgets. `decodedBytes` includes each
decoded block and each retained-history copy needed by a subsequent block; `sourceBytes` includes original packed
payloads, and `outputBytes` includes only returned selected bytes. These known totals are admitted before output
allocation or payload I/O. Parity is checked on original packed bytes before they influence the dictionary. This parity
is not authentication and does not validate CAB directory metadata.

`read(id, { maxDeflateBlocks })` also bounds CPU work that produces little or no output. It defaults to 8,192 raw
DEFLATE blocks across the complete required folder replay, with an implementation maximum of 65,536. This is a local
safety policy, not an MSZIP format maximum. Every raw block counts before stored-data handling, fixed-code lookup or
dynamic Huffman-table construction, including empty blocks. A single CFDATA unit may contain many raw blocks, so its 32
KiB byte limit does not replace this policy. `result.deflateBlocks` reports the processed count; NONE and empty reads
report zero. Raise the policy deliberately for a known archive, within the implementation maximum. No partial result is
returned when the limit is reached.

## Budgets, cancellation and recovery

Default per-operation limits are 64 MiB source bytes, 4,096 source requests, 64 MiB inspected/decoded bytes and 16 MiB
returned bytes. Opening also defaults to 256 folders, 100,000 entries, 100,000 total data blocks, 256 encoded bytes per
filename including NUL, and 1 MiB structural metadata. The 256-byte name limit is also the selected format profile's
maximum. Metadata charges include bounded look-ahead within the file table as well as opaque reserved bytes. Listing
reads structural records and skips data bodies in valid cabinets.

`work` separates source bytes, requests, inspected bytes and returned bytes. Checked NONE reads count complete covering
blocks; unchecked/absent-checksum NONE reads count selected intersections. MSZIP counts required replay and history
copies. Source counters mean requested archive extents, not hidden transport allocations or requests inside a custom
source. Share `createArchiveLedger()` through open/read options to bound aggregate operations.

Opening limits also establish a lifetime allowance shared by indexing and every subsequent read. Per-read limits remain
independent local ceilings; raising them does not reset or raise the opening allowance. An opening external `ledger`
stays active for later reads. A distinct operation ledger is charged too; passing the same ledger at both levels charges
it once. Source descriptors and opening options are captured before the first source read, so later mutation cannot
replace the read function, source identity, stability evidence, signal or opening policy. Stability must be exactly
`immutable`, `provider` or `caller`; an optional identity is limited to 8,192 UTF16 code units and supplies no stability
proof by itself.

The opening and operation signals compose: a fresh operation signal cannot override an aborted archive. Cancellation
reaches each acquired source read and is checked again afterward, between blocks and before empty output. The archive
owns no persistent reader or cleanup handle. Source failures retain their original identity. `ArchiveError` separates
malformed structures, unsupported profiles, checksum failures and exhausted budgets. A caller can reopen a stable
source, select a readable folder, reduce output, explicitly choose unchecked evidence or raise a known work limit.

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

`deno task bench:cab` preflights complete native fixture payloads and selected intervals before sampling 23 workloads.
STORED compares native preindexed Blob reads with unchecked/CRC previews and cold indexing. MSZIP compares warm
unchecked, warm block-checked and cold-index-plus-read operations at prefixes and a late range in the 128 KiB member.
Labels record actual source/decoded/output bytes and required blocks. The native Blob baseline exists only for STORED;
compressed lanes have no independent native-codec timing baseline and establish no speedup claim.

Warm samples share one index with an explicit finite sampling allowance of 64 GiB source/decoded work, 1 GiB output and
ten million requests, while each read keeps its ordinary operation ceilings. Local Node 26.13.0 on arm64 macOS completed
all workloads; CI retains raw Mitata JSON. Timings describe these fixtures and host, not every CAB size, remote
provider, runtime or memory usage.

MSZIP framing follows Microsoft's
[MS-MCI section 2](https://learn.microsoft.com/en-us/openspecs/exchange_server_protocols/ms-mci/3048c471-f739-4d30-bcb3-a962cfe84a69)
and [RFC 1951](https://www.rfc-editor.org/rfc/rfc1951). The
[Compression Standard](https://compression.spec.whatwg.org/#dom-decompressionstream-decompressionstream) documents the
native API's format-only constructor; this decoder does not depend on host dictionary or consumption behavior.

[`mszip.py`](../tests/fixtures/cab/mszip.py) separately constructs CAB framing around Python zlib 1.2.12 streams. The
[fixture receipt](../tests/fixtures/cab/mszip.md) identifies retained `mszip.json`, which includes complete original
payloads, packed blocks, archive hashes, native 7zz 26.02 receipts and dictionary-dependence checks. Dynamic,
fixed-Huffman, stored and overlapping-copy profiles pass native full-byte consumption. The genuine gcab MSZIP fixture
also passes complete-byte reads, but its blocks happen to decode independently and do not prove dictionary support. The
new zdict profiles fail independent raw decoding without prior history and supply that proof. A three-short-block
history vector passes Python zlib but native 7zz rejects its CAB; that negative receipt is retained and is not a
native-interoperability claim. MS-MCI permits each block to contain at most 32 KiB, so the reader retains cumulative
history across those short units without silently imposing 7zz's observed restriction.
