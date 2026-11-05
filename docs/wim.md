# Preview ordinary stored, XPRESS and LZX WIM images

A Windows Imaging (WIM) file can contain several directory-tree images that share deduplicated file resources.
`openWim()` indexes the resource table and image descriptions. `image(index)` parses one selected image's metadata.
`read(entry.id)` then returns that file's bytes without applying the image to a disk or reading other file resources.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openWim } from "@okikio/opfs/archive/wim";

export async function previewWim(bytes: ArrayBuffer, subtle: SubtleCrypto): Promise<Uint8Array> {
  const archive = await openWim(createBlobSource(new Blob([bytes])), { subtle });
  const image = await archive.image(1);
  const entry = image.entries.find((entry) => entry.path === "hello.txt");
  if (!entry) throw new Error("hello.txt is absent from image 1");
  const preview = await image.read(entry.id, { length: Math.min(entry.size, 64) });
  console.log(image.metadataIntegrity, preview.integrity, preview.work);
  return preview.bytes;
}
```

The caller supplies `SubtleCrypto` explicitly and keeps the stable source available. The digest method is bound before
source I/O. Default metadata and member reads verify each complete selected resource's SHA-1. A short preview may
therefore read and hash the entire resource. This is corruption evidence for those particular resources, not trusted
authorship, Windows bootability, or verification of the entire WIM.

`verify: false` explicitly permits pending metadata/member checks. A stored range read then requests only its selected
extent. `image(index, { verify: false })` can inspect metadata without a crypto capability; subsequent default file
reads still require one. Empty files use WIM's zero-hash sentinel and report `not-provided`; that sentinel is not
SHA1(empty). No global crypto capability or credential source is discovered.

```ts
import type { ByteSourceType } from "@okikio/opfs/source";
import { openWim } from "@okikio/opfs/archive/wim";

export async function memberSource(source: ByteSourceType, subtle: SubtleCrypto): Promise<ByteSourceType> {
  const archive = await openWim(source, { subtle });
  const image = await archive.image(1);
  const entry = image.entries.find((entry) => entry.path === "nested/data.bin");
  if (!entry) throw new Error("nested/data.bin is absent");
  return image.source(entry.id, { maxSourceBytes: 1_048_576, maxOutputBytes: 1_048_576 });
}
```

A member source has exact logical range semantics, cumulative limits and a provenance tuple when the original source has
an identity. The tuple keeps physical resource position and logical decoded offset separate; compressed logical bytes
are not claimed to occupy one contiguous physical range. It does not verify a resource hash on each read. It can be
passed to another archive reader for nested preview. Identical files in different images may share one resource and
physical identity; a resource does not own a unique filename. Original methods, size, identity and stability are
captured when opening. Missing stability evidence requires explicit `allowUnverifiedSource: true` and remains
unverified.

## The supported profiles

`uncompressed-1.13` means ordinary `MSWIM` magic, exact 208-byte header, format version `0x10d00`, one complete unsplit
part, zero compression chunk size and uncompressed resources. It is a format profile, not a wimlib software version.
`xpress-huffman-32k-1.13` additionally accepts ordinary resources using WIM XPRESS-Huffman with exactly 32,768-byte
independent chunks. `lzx-32k-1.13` accepts the ordinary WIM LZX variant with the same chunk size. Stored resources and
stored fallback chunks remain supported within both compressed profiles. Plain XPRESS, other chunk sizes, LZMS, solid
ESD, split SWM, pipable WIM, write-in-progress and resource-only/metadata-only variants are refused. CAB's existing
codec is not assumed to implement WIM's distinct LZX framing or E8 behavior. There is no fallback SDK, external-part
lookup or arbitrary URL fetch.

Each ordinary resource-table record is 50 bytes. Its first 24 bytes contain a 56-bit stored size, flags, physical offset
and decoded size. Uncompressed sizes must agree. The remaining fields contain part number, reference count and SHA-1.
All extents are checked against the exact source and the fixed header. Duplicate data-resource hashes are refused rather
than resolved by an arbitrary winner. Resources retain physical ordinal IDs, physical `offset`, logical decoded `size`,
physical `storedSize`, declared `compression` and SHA-1 values. The header resource table, XML and integrity table must
remain stored in this profile.

Image indices are 1-based. Metadata resources are assigned to images in **resource-table order**, matching the pinned
wimlib source's description of Microsoft behavior. Physical offsets, boot metadata and XML names do not reorder them.
Header count, XML image count/indices and metadata-resource count must agree. A nonzero boot image descriptor must match
its indexed metadata resource. XML is bounded UTF16LE and supplies image names; it does not authorize extraction or
choose resource identity. DTD/entity declarations, namespace ambiguity and duplicate image indices/name fields fail.

`image(index)` buffers only that image's metadata resource. It validates security-table framing and indices without
applying or claiming to validate Windows security descriptors. Directory records, extra-stream records and list
sentinels have disjoint aligned byte ownership. Cycles, overlapping lists, out-of-range child offsets, malformed UTF16
names/terminators, missing resources and duplicate exact paths fail. Names are literal metadata: no case folding, path
normalization, filesystem writes, ACL restoration or permission changes occur. The unnamed root has path `""`. Short
names are framing-checked but do not create aliases.

Directory, reparse-point and encrypted entries remain inspectable but cannot be read as ordinary files. Reparse points
are never followed. Hardlink group IDs remain decimal metadata; ordinary hardlinked entries refer to the shared resource
without following a host link. Extra-stream names and hashes are retained, bounded and checked for duplicate
names/missing resource references. **File interpretation with extra streams is deferred**: those entries reject file
reads because WIM's unnamed/reparse/encrypted stream-selection rules need a wider evidence profile. The raw resource
`archive.read(resourceId)` and `archive.source(resourceId)` operations expose explicitly selected decoded resource blobs
without claiming they are a file's default plaintext stream. Windows metadata restoration and image mounting are not
provided.

## Compressed ranges and strict writer termination

A compressed resource starts with a chunk table. There is one cumulative offset per chunk except the first, whose
implicit offset is zero. Entries are four bytes below 4 GiB decoded size and eight bytes otherwise; offsets are relative
to the end of the table, not the WIM header or resource start. The complete table is bounded and validated before any
selected payload is read. Offsets must increase, stay within the resource and describe positive chunks no larger than
the expected decoded chunk. Equal packed and decoded lengths mean a stored fallback chunk, not a compressed stream.

`verify: false` reads and decodes only chunks intersecting the selected logical range. A three-byte preview can still
read and decode 32 KiB plus the complete chunk table. A boundary-crossing range may need two full chunks. The default
SHA1 verification reads and decodes every chunk of the selected resource, then hashes all decoded bytes before returning
the requested range. `work.decodedBytes` counts table bytes, complete selected chunk output and, for verification, the
whole digest input. `xpressSteps`, `lzxSteps` and `lzxBlocks` report codec work separately; image views report the work
for their metadata decode. A zero-length pending read performs no chunk-table or payload I/O and proves nothing about
unexamined chunks.

The XPRESS kernel implements the MS-XCA LZ77+Huffman variant with 512 canonical symbols, code lengths at most 15,
little-endian 16-bit coding words, interleaved match lengths and overlapping copies. It uses bounded flat tables rather
than a 32,768-entry decode table. Match distances cannot precede this independent chunk and matches cannot exceed its
declared output. The 32 KiB profile does not need the encoding document's 32-bit match-length extension; invalid small
16-bit extensions are refused rather than guessed as another variant.

After exactly the declared decoded size, this selected writer profile requires canonical symbol 256, exact packed extent
and 16 through 31 remaining zero bits. Those bits are alignment plus the reserved zero coding word described by the
Microsoft writer and confirmed in all retained native compressed chunks. This is an explicit strict writer profile:
size-only native decoders can stop earlier and do not establish those tail conditions. No arbitrary trailing bytes,
missing end markers or nonzero padding are accepted as a compatibility fallback. These structural checks are not a
checksum; only a requested complete resource SHA1 check provides the reported resource consistency evidence.

## Ordinary WIM LZX

LZX uses independent 32 KiB resource chunks with a 32 KiB window. Each chunk resets its recent offsets to `[1, 1, 1]`
and its previous Huffman lengths to zero. Internal blocks can be verbatim, aligned-offset or raw; those blocks retain
history and tree lengths within the chunk. The decoder uses flat canonical tables: 496 main symbols, 249 length symbols,
20 pretree symbols and eight aligned symbols. Empty secondary trees are permitted only while unused. Distances must
refer to preceding bytes in this chunk and matches cannot cross a block's declared output boundary. Packed input and
output cannot alias.

This is the pinned ordinary WIM writer dialect, not a generic LZX, CAB LZX or LZX Delta decoder. Its three-bit block
type is followed by a one-bit size flag: **one means 32768 bytes**, zero introduces a 16-bit size. There is no stream
Intel header. Raw blocks align to the next 16-bit boundary even when already aligned, carry three nonzero little-endian
recent offsets, and have one zero padding byte after an odd-length body. This strict profile requires zero alignment.
Compressed blocks finish when the exact declared output size is reached: no end symbol or reserved extra word follows.
The packed extent must end exactly with zero through 15 unused zero bits. This differs from XPRESS termination above.
Native size-only decoding alone does not establish these strict tail conditions.

After a compressed chunk is decoded, the mandatory inverse E8 transform uses chunk-local positions and the fixed
12,000,000-byte reference size. It scans only positions before the last ten bytes and skips each four-byte operand
whether changed or unchanged. Stored fallback chunks bypass both LZX and E8. A selected range must therefore decode and
transform its entire intersecting chunk before selecting bytes; it cannot apply E8 to a sliced prefix. Resource SHA1
verification covers the final transformed logical bytes, not their intermediate coding representation.

`lzxSteps` charges bit reads, Huffman work, copying and the E8 scan. `lzxBlocks` counts all internal blocks across all
required chunks in one operation, including raw blocks. The implementation also has a hard local ceiling of 1 Mi work
steps and 256 blocks per chunk. These are finite CPU policies, not format limits. Typed Huffman state is below 16 KiB
per synchronous decoder invocation, in addition to its already admitted 32 KiB output chunk. There is no retained
cross-call history or decoded chunk cache. Signal and admission checks also run after E8 and before returning bytes.

## Bounds and cancellation

| Policy                   | Default | Meaning                                                                          |
| ------------------------ | ------- | -------------------------------------------------------------------------------- |
| `maxChunkTableBytes`     | 256 KiB | Per-resource retained chunk table; hard 2 MiB                                    |
| `maxXpressChunks`        | 65536   | Per-resource chunk count; hard 262144                                            |
| `maxXpressSteps`         | 16 Mi   | Per-read codec work across selected chunks; hard 64 Mi                           |
| `maxLzxChunks`           | 65536   | Per-resource LZX chunk count; hard 262144                                        |
| `maxLzxSteps`            | 16 Mi   | Per-read LZX work across selected chunks; hard 64 Mi                             |
| `maxLzxBlocks`           | 8192    | Per-read LZX internal blocks across chunks; hard 65536                           |
| `maxImages`              | 128     | Includes each image description                                                  |
| `maxResources`           | 50000   | Physical blob table entries                                                      |
| `maxResourceIndexBytes`  | 16 MiB  | Estimated 256 bytes per retained resource                                        |
| `maxTableBytes`          | 4 MiB   | Hard 8 MiB, admitted before table allocation                                     |
| `maxXmlBytes`            | 1 MiB   | Hard 8 MiB UTF16LE bytes; markup token cap 20000                                 |
| `maxVerifyBytes`         | 1 MiB   | Hard 16 MiB per whole-buffer SHA1 input                                          |
| Buffered resource read   | 16 MiB  | Hard selected return or full verified resource                                   |
| Image `maxMetadataBytes` | 8 MiB   | Hard 16 MiB, independent of whole-hash policy                                    |
| Image `maxEntries`       | 10000   | Includes the unnamed root                                                        |
| Image `maxDepth`         | 32      | Hard 64 directory levels                                                         |
| Image `maxStreams`       | 32      | Extra stream records per entry                                                   |
| Image `maxSecurity`      | 4096    | Opaque security descriptors                                                      |
| Image `maxNameBytes`     | 4096    | One UTF16LE filename, short name or stream name                                  |
| Image `maxPathLength`    | 4096    | Full path in UTF16 code units                                                    |
| Image `maxIndexBytes`    | 4 MiB   | Occupancy bitmap + 256/entry + UTF16 path bytes + 128/stream + stream-name bytes |

`ArchiveLimitsType` separately bounds requested source bytes, requests, decoded/internal verification work and returned
payload bytes. Opening limits are cumulative across later operations; image limits also span that image's metadata read
and subsequent file reads/sources. Explicit caller ledgers span composed readers. Metadata parsing produces an index, so
its internal metadata buffer is charged as source/decoded work, **not returned payload**. File/resource reads charge
only returned payload length as output, even when complete verification costs more. Source requests are reserved against
cumulative ledgers before collection buffers are allocated. Limits are finite estimates and admitted work, not exact
JavaScript heap or CPU guarantees. Metadata buffers, bitmap/index strings and WebCrypto copies coexist. A compressed
read also holds the bounded chunk table and at most 513 selected-range records (the buffered return is at most 16 MiB).
One chunk needs at most 32 KiB packed input, 32 KiB decoded output and less than 4 KiB typed canonical tables. The
internal kernel additionally caps one chunk at 1 Mi work units. These are implementation safety bounds, not format
maxima or process-RSS guarantees. Aggregate selected source bytes, requests, decoded work and returned bytes are
reserved before the result buffer; pre-reserved source credits are consumed once during chunk reads. No decoded chunk
cache is retained between calls.

A pending prefix, including a zero-length suffix request, never becomes verified evidence for unseen bytes. Whole
verification can reject a tiny preview when the complete resource exceeds `maxVerifyBytes`; increase the finite policy
or explicitly choose pending verification. Injected crypto and source failures remain failures; no unverified bytes are
returned on a requested verification failure. WIM's optional integrity table is reported only as `absent` or
`present-unverified`; it is never confused with individual resource SHA1 checks.

The source is borrowed and is never closed. Opening and image signals remain cancellation authority for subsequent
operations. More local operation signals compose with those parent signals; a fresh signal cannot revive an aborted
archive or image. A returned source combines all captured parent signals with its per-read signal. No background tasks
or native codecs are acquired. Abort remains failure rather than checksum success.

## Independent evidence

The [LZX receipt](../tests/fixtures/wim/lzx-README.md) retains two genuine wimlib LZX images, complete metadata and
resource bytes from native libwim, and independent 7-Zip full-file comparisons. The 19 genuine compressed chunks contain
17 verbatim and two aligned blocks, 304 aligned-offset uses and ten E8 reversals. A separately authored
raw-plus-verbatim adaptation was accepted by native libwim, wimlib verify/apply and 7-Zip against every original file.
It proves that particular raw/multiblock profile; it is not claimed to be a genuine producer-selected raw block. The
authored tail audit compares all decoded bytes against the pre-established native oracles, not candidate output. Primary
MS-PATCH LZX Delta grammar and immutable wimlib WIM-dialect sources are pinned with hashes in the receipt.

The [XPRESS receipt](../tests/fixtures/wim/xpress-README.md) adds two genuine XPRESS images. Native wimlib verifies,
applies and supplies complete decoded metadata/resource bytes through its decompressor API. Independent 7-Zip compares
every authored file byte, including stored random data, extended matches, shared resources, multiple chunks and
32,767/32,768/32,769-byte boundaries. The separate authored framing audit checks all 13 genuine compressed chunks
against those already established bytes and retains their exact termination measurements. It is not claimed as a third
independent native decoder. Its source and primary grammar are pinned with the receipt.

The [retained fixture](https://github.com/okikio/opfs/blob/6e0df56/tests/fixtures/wim/README.md) contains two genuine
uncompressed images produced by Debian wimtools in a disposable bounded container. Native capture/append/verify/apply
succeeded. Every authored file was also extracted with independent 7-Zip 26.02 and compared byte-for-byte, including
shared binary content, nested paths, empty files, UTF16 names and different versions of `hello.txt` in two images.
Native verification explicitly warned that no whole-file integrity table was present; that warning remains in the
fixture. Ordinary metadata mutation tests exercise refusals, not independent interoperability for named streams, ACLs,
hardlinks or reparse points.

The Microsoft source is the official
[Windows Imaging File Format 1.1 document](https://www.microsoft.com/en-us/download/details.aspx?id=13096), RTF SHA256
`397772cca016508194d13ac860633b56b4f2f94cbf7476e2112f557ad61cfe0c`. The implementation evidence is pinned to
[wimlib revision cd5e231c348c255ae5088873b5a66ee0eb96fa07](https://github.com/ebiggers/wimlib/tree/cd5e231c348c255ae5088873b5a66ee0eb96fa07),
including `header.h`, `resource.h`, `blob_table.c`, `dentry.c`, `metadata_resource.c` and `security.c`. Their exact
hashes and producer/package identity limits are recorded with the fixture. No upstream implementation code was copied
and no native tool is a production dependency.

`bench/wim.bench.ts` measures cold stored/XPRESS/LZX image indexing, complete resource SHA1 verification and pending
early or late ranges, including genuine E8 data and separately authored native-accepted raw blocks. Every complete
authored file is checked before timing; selected ranges are also compared with their original bytes. Labels show source
bytes, requests, decoded work, returned bytes, codec steps, LZX block counts and hash scope. Warm index reuse has an
explicit finite 64 GiB/10-million-request sampling lifetime allowance; per-read limits stay unchanged. The predecoded
Blob baseline only copies existing plaintext and supplies a lower bound. Different fixtures, output sizes and integrity
scopes do not establish a general codec or checksum speed ranking.
