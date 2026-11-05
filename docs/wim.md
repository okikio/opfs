# Preview ordinary uncompressed WIM images

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

A member source has exact range semantics, cumulative limits and a physical provenance tuple when the original source
has an identity. It does not verify a resource hash on each read. It can be passed to another archive reader for nested
preview. Identical files in different images may share one resource and physical identity; a resource does not own a
unique filename. Original methods, size, identity and stability are captured when opening. Missing stability evidence
requires explicit `allowUnverifiedSource: true` and remains unverified.

## The supported profile

`uncompressed-1.13` means ordinary `MSWIM` magic, exact 208-byte header, format version `0x10d00`, one complete unsplit
part, zero compression chunk size and uncompressed resources. It is a format profile, not a wimlib software version.
XPRESS, WIM-specific LZX, LZMS, solid ESD, split SWM, pipable WIM, write-in-progress and resource-only/metadata-only
variants are refused. CAB's existing codec is not assumed to implement WIM's distinct LZX framing or E8 behavior. There
is no fallback SDK, external-part lookup or arbitrary URL fetch.

Each ordinary resource-table record is 50 bytes. Its first 24 bytes contain a 56-bit stored size, flags, physical offset
and decoded size. Uncompressed sizes must agree. The remaining fields contain part number, reference count and SHA-1.
All extents are checked against the exact source and the fixed header. Duplicate data-resource hashes are refused rather
than resolved by an arbitrary winner. Resources retain physical ordinal IDs and declared SHA-1 values.

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
`archive.read(resourceId)` and `archive.source(resourceId)` operations expose explicitly selected stored blobs without
claiming they are a file's default plaintext stream. Windows metadata restoration and image mounting are not provided.

## Bounds and cancellation

| Policy                   | Default | Meaning                                                                          |
| ------------------------ | ------- | -------------------------------------------------------------------------------- |
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
JavaScript heap or CPU guarantees. Metadata buffers, bitmap/index strings and WebCrypto copies coexist.

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
