# Preview a UDF 1.02 image

Open the UDF directory and read selected file bytes without mounting the image or copying its complete contents. UDF is
an optical-disc filesystem format; it is separate from an ISO 9660 directory that may coexist in the same image. The
reader follows UDF descriptors and never falls back to the ISO namespace.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openUdf } from "@okikio/opfs/archive/udf";

export async function preview(image: Blob): Promise<Uint8Array> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 16 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  const archive = await openUdf(createBlobSource(image), {
    ledger,
    maxEntries: 10000,
    maxDirectoryBytes: 2 * 1024 * 1024,
    maxNamesBytes: 256 * 1024,
    maxExtents: 20000,
  });
  console.log(archive.revision, archive.partition, archive.metadata);
  const entry = archive.entries.find((entry) => entry.kind === "file" && entry.name === "large.bin");
  if (!entry) throw new Error("The UDF directory has no regular file named large.bin");
  const result = await archive.read(entry.id, { length: Math.min(4096, entry.size) });
  console.log(result.integrity, result.work);
  return result.bytes;
}
```

Entries use index-local numeric IDs, not host paths. `parentId` identifies a directory entry; root children have `-1`.
`recordOffset` is the physical byte address of the file identifier descriptor, and `icb` is the partition-relative block
address of its file entry. Distinct names for one file retain distinct IDs while sharing checked allocation metadata.
Names preserve OSTA compressed Unicode 8-bit or 16-bit characters without case conversion or normalization. NUL,
separators and surrogate code units are refused. No name is used for extraction, a host lookup or source identity.

`read(id, { offset, length })` returns an owned array containing exactly that interval. Its default is the entire
selected file. Reads address only intersecting recorded extents; a range crossing an extent boundary issues the
corresponding physical requests. A late offset does not require reading the preceding file bytes or unrelated files.
Directory reads are not exposed as file payloads.

## Metadata checks and exact profile

The reader accepts one read-only physical partition, one volume and one file set, with 2048-byte physical sectors and
logical blocks. The OSTA domain revision is exactly 1.02 and the recognition sequence is BEA01/NSR02/TEA01. ISO bridge
recognition descriptors may precede it. The reader uses anchor sector 256 and the main volume descriptor sequence; it
does not attempt alternate-anchor or reserve-sequence recovery.

Descriptor tags must have version 2, the correct location in their volume or partition coordinate system, a valid tag
checksum and a valid body CRC16 covering every interpreted variable field. ECMA permits descriptors without CRC
coverage; this narrower profile refuses them. `metadata: "descriptor-crc16-verified"` describes the parsed descriptor
bodies, including file identifiers and allocation arrays. Opaque implementation-use areas and extended attributes are
not interpreted as additional capabilities.

The main descriptor extent contains at least sixteen sectors and a terminator. There is one primary, physical-partition
and logical-volume descriptor. Duplicate prevailing versions, descriptor-pointer continuation, multiple partition maps,
open/chained integrity state and continuation file sets are refused. The checked logical-volume integrity descriptor
must be closed. That state is a recorded declaration, not a new stability or authenticity proof.

Files use direct-entry ICB strategy 4, ordinary file entries, and short or same-partition long recorded allocation
vectors. Extents must fit the physical partition and sum exactly to the declared file information length. Directory
identifier framing, implementation-use lengths, zero padding, version, kind and parent references are checked before
traversal. Parent links are validated against the known traversal parent and never followed. Directory cycles and
multiple directory parents are refused; regular-file aliases are allowed.

This profile does not support UDF 1.50–2.60, Secure UDF, virtual/sparable/metadata partition maps, strategy 4096,
indirect or extended file entries, embedded allocation, sparse/unrecorded allocation or allocation-descriptor
continuation. Symbolic links and special file kinds are refused, rather than converted to regular files or followed.
This is a selected read profile, not a claim of complete UDF implementation conformance. In particular, mandatory
features of broader UDF readers remain explicitly unsupported here.

UDF supplies descriptor checks, not a dedicated checksum for each ordinary file payload. `read().integrity` is `"none"`.
A successful descriptor CRC cannot establish that file bytes are intact or identify a publisher. Applications that need
those properties must verify an independent content digest or authenticated envelope.

## Bounds, nested readers and cancellation

Opening defaults to 256 system descriptors, 100,000 directory identifiers, depth 64, 8 MiB of aggregate directory bytes,
1 MiB of retained UTF-8 names and 100,000 recorded allocation descriptors in unique ICBs. Parent and deleted identifiers
consume the directory-record allowance too. Each directory extent is admitted before queuing and its decoded/parser work
before its temporary directory buffer is allocated. Only one directory buffer is active at a time. Ordinary file
payloads are not materialized by opening. Integer and extent arithmetic is checked through BigInt before conversion to
exact JavaScript offsets.

Standard archive policies default to 64 MiB source bytes, 4096 requests, 64 MiB decoded/parser work and 16 MiB output
accounting. Index entries reserve 64 accounting bytes plus UTF-8 name bytes; unique allocation arrays reserve 24 bytes
per descriptor. These explicit logical allowances are not exact JavaScript heap measurements. They do not charge file
payload sizes merely because those sizes appear in metadata.

Opening limits remain a lifetime allowance across later reads. An opening ledger stays active when a read adds its own
ledger, and passing the identical opening ledger again does not double-charge it. An individual read also applies its
per-operation policies. The known intersecting source bytes and request count are reserved before selected or
directory-buffer allocation. Actual reads consume those credits without charging a ledger twice. Reservations are not
refunded after failure, including when a later admission dimension refuses the operation.

Use `archive.member(id, options)` to pass one regular file to another byte-source consumer. Its source reads exact
selected intervals across the checked allocation vector and adds persistent member limits across its reads. Opening
limits and any distinct caller ledger remain active. The returned source borrows the original image and never closes it.
Its identity, when available, combines the captured image identity and physical ICB address, never its filename.

The image's size, read capability, optional identity and stability declaration are captured before the first await.
Stability must be `immutable`, `provider` or `caller`; absent evidence needs explicit `allowUnverifiedSource: true`.
That option does not create a snapshot. Identity alone is not stability evidence. Keep the physical image unchanged
through opening and later reads.

Opening, member and operation abort signals are combined. A fresh signal cannot bypass an aborted opening lifetime.
Abort is checked before source admission and after awaited reads, including empty selections. A pending borrowed
provider operation must settle; cancellation cannot forcibly interrupt foreign code. Its independent failure remains
visible if it rejects while cancellation is pending. No host mount, file publication, background resource or ownership
transfer occurs. Retry with a stable image or an explicitly larger finite policy after an applicable refusal;
unsupported layouts need a separate implemented profile rather than a relaxed checksum check.

## Independent evidence

The current TypeScript producer, `tests/fixtures/udf/create.ts`, invokes signed-Debian `genisoimage -udf` and compares
every original file byte through the independent 7-Zip handler forced with `-tUdf`. This prevents an ISO bridge from
accidentally supplying the verification result. `udfinfo` supplies a separate structural report. The corpus includes
empty files, Unicode names using both compression identifiers, nested directories, identifiers crossing sector
boundaries, file aliases and a large unrelated payload used to check exact selected-range access.

Long and split allocation vectors are explicitly labelled authored adaptations of a genuine image. The original payloads
remain unchanged; independent forced-UDF extraction verifies every file in each adaptation. They are not labelled
genuine producer-generated long or split vectors. Version/help probes that return a nonzero status remain recorded as
diagnostics; successful payload and image-structure commands must exit zero.

The format sources are
[UDF 1.02 in ECMA TR/112-7](https://ecma-international.org/wp-content/uploads/ECMA_TR-112-7_1st_edition_december_2023.pdf)
and
[ECMA-167, second edition](https://ecma-international.org/wp-content/uploads/ECMA-167_2nd_edition_december_1994.pdf).
The latter is the edition referenced by UDF 1.02. The fixture receipt pins their exact hashes, native package versions,
producer script and image hashes. Test-only native tools are not runtime dependencies. Authored byte controls check CRC
coverage, tag locations, allocation bounds, directory relationships, policy admission and provider cancellation. They
complement independent full-byte interoperability rather than replacing it.
