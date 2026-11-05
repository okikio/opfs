# Read guest bytes from a QCOW2 image

QCOW2 stores a virtual disk inside another addressable file. `openQcow2` resolves selected guest bytes without mounting
the disk or materializing its full logical size. The result contains disk bytes, not guest files. Partition tables and
guest filesystems need their own parsers.

This complete function accepts an image already acquired by the caller. The physical source is borrowed, and the guest
source remains valid as long as that original source remains available and stable.

```ts
import { openQcow2 } from "@okikio/opfs/image/qcow2";
import { createByteSource } from "@okikio/opfs/source";

export async function preview(imageBytes: ArrayBuffer): Promise<Uint8Array> {
  const physical = createByteSource(new Uint8Array(imageBytes));
  const image = await openQcow2(physical, {
    maxGuestBytes: 1024 ** 4,
    maxMetadataBytes: 8 * 1024 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxRequests: 4096,
  });
  const length = Math.min(512, image.size);
  const result = await image.read({ offset: 0, length });
  // QCOW2 does not authenticate payloads. Source snapshot evidence is separate.
  if (result.integrity !== "none") throw new Error("Unexpected integrity profile.");
  return result.bytes;
}
```

Native QEMU fixture production has passed original-raw-byte readback, while candidate runtime and installed-package
validation remain pending. The public subpath is an integration target until those checks complete. Authored malformed
controls remain separate from genuine native images.

## Mapping and supported profile

The reader supports standalone, unencrypted version 2 and version 3 images with ordinary uncompressed clusters and
standard L2 entries. L1 selects a second-level mapping table; L2 selects a physical data cluster. Opening eagerly
inspects the complete declared active mapping graph, including table entries outside the guest size. An unsupported
compressed entry anywhere in that graph refuses opening.

Version 3 explicit-zero entries and absent mappings both return zeros without payload I/O. `image.map(offset, length)`
distinguishes `hole`, `zero`, and `allocated` intersections. A preallocated explicit-zero entry retains a `sourceOffset`
for inspection, but its stored bytes are never read. Every mapping and known preallocated cluster is alignment- and
source-bound-checked.

Opening validates the header, active mapping extents, reserved bits, guest coverage, and known metadata-role overlaps.
It protects header, L1, L2, refcount table, and referenced refcount-block extents from payload aliases. Only declared
serialized L1 entries must physically exist: a valid image can end immediately after its last entry. Its rounded cluster
interval is protected as metadata, but padding past physical EOF is neither read nor claimed to be available. The reader
permits shared data clusters and repeated references to the same L2 table.

`image.validation` is `active-mapping-bounds`, and `image.refcountValidation` is `not-checked`. Refcount-block addresses
are inspected to protect their extents; the reference-count values are not checked. The wire `copied` bit remains a
hint, not proof that a cluster has one owner. Successful opening is not equivalent to `qemu-img check` and does not
authenticate the image or its publisher.

The initial profile refuses backing files, external data, encryption, internal snapshots, dirty/corrupt images, all
feature-mask bits, extended L2 entries, compressed clusters, and unknown header extensions. Only the extension
terminator and structurally validated feature-name records are admitted. This is a conservative supported profile: the
QEMU specification permits some additional fields and compatible extensions to be safely ignored by other readers.
Refusal here does not assert that every such image is universally invalid.

Cluster sizes range from 512 bytes to 2 MiB. Version 2 uses its fixed 72-byte header. Version 3 accepts known 104- or
112-byte headers, zero additional fields, and 16-bit refcounts. No conversion, repair, path resolution, host mount,
write, snapshot selection, or guest execution happens implicitly.

## Limits, cancellation, and nested sources

The defaults allow 1 TiB of logical guest bytes, 8 MiB of serialized metadata inspection, 1,048,576 serialized table
entries admitted across all tables, 1,024 distinct L2 tables, 65,536 refcount-block extents, and 4,096 cluster
intersections in one selection. Repeated prefix/header bytes count again toward metadata inspection. Opening reads the
complete first header cluster, including unused bytes, and L2 validation makes two bounded passes over admitted entries.
A logical size cap does not authorize a logical-size allocation. A fragmented selection can hit its segment cap even
when the requested output is small.

The shared ledger defaults are 64 MiB source bytes, 64 MiB decoded bytes, 16 MiB returned output, and 4,096 source
requests. Metadata reads consume source and decoded work. Guest reads charge the complete selected logical range as
decoded and output work, including holes and zeros; only allocated intersections consume payload source work. Reads use
chunks of at most 64 KiB. Physical costs count this reader's exact source requests, not hidden work inside a provider.

Before output allocation, the reader admits known source/request costs and the complete decoded/output selection.
Reservations are not refunded after a later failure. The metadata byte cap bounds serialized owned bytes, not exact
engine heap usage: bounded maps, protected extents, temporary source chunks, and returned output use additional memory.
The reader does not create a guest-sized buffer unless the caller explicitly requests that full size and all finite caps
admit it.

Opening options are captured. Their aggregate local ledger, external ledger, and abort signal remain authority for later
reads. Additional per-read or nested limits can narrow that authority. Passing the same external ledger at opening and
nested-source construction does not charge that owner twice. A source identity alone does not establish stability; use a
stable source or explicitly accept an unverified source with `allowUnverifiedSource: true`.

`image.source({ ledger, signal, ...limits })` returns an exact-range guest source. It can feed another reader when the
guest layout matches that reader. A virtual disk may start with a partition table rather than an ISO/UDF image; the
QCOW2 reader does not discover or skip that partition table. The derived source retains the physical source's stability
evidence, and only provides an identity when a bounded identity can be derived from the captured physical snapshot and
view. If the derived JSON identity exceeds 8,192 characters, the nested source omits identity rather than truncating it.
Stability and all read authority remain unchanged; omission supplies no new replay or authentication guarantee.

Cancellation composes opening, operation, and nested signals. It waits for an already-issued borrowed source read to
settle, preserves an independent provider failure, and never closes the source. No partially filled read result is
returned on observed abort. `map` is synchronous inspection of the existing immutable index; it performs no provider I/O
and still checks the opening abort signal.

The immutable grammar reference is the
[QEMU v9.2.0 specification](https://raw.githubusercontent.com/qemu/qemu/ae35f033b874c627d81d51070187fbf55f0bf1a7/docs/interop/qcow2.txt).
Native fixture provenance will distinguish original raw-byte oracles from candidate output and from authored
malformed-image controls.

## Recorded workload costs

The eight-lane benchmark uses genuine QEMU originals and checks every full guest byte before timing. In one bounded
Linux arm64 run with Node 26.13.0 and Mitata 1.0.34, a warm 37-byte allocated selection requested 37 source bytes in one
call; a hole or preallocated-zero selection requested no payload bytes. Both zero profiles still charged 37
logical/output bytes. The 262,144-byte full guest read requested 196,608 stored bytes in three calls.

Cold acquisition remains separate: the 512-byte-cluster fixture requested 2,656 metadata bytes in seven calls; the
different 64-KiB-cluster fixture requested 196,688 metadata bytes in five calls. Their guest sizes and layouts differ,
so these observations do not isolate cluster size as a cause of speed. The native already-raw Blob lane omits QCOW2
indexing and budget admission. Exact workload labels, averages, medians, runtime, resource limits and lossless
full-report hashes are recorded in the [fixture provenance](../tests/fixtures/qcow2/provenance.json). This single run
supports no universal speed or cross-runtime performance claim. Warm sampling uses finite benchmark-only lifetime
allowances; per-operation caps keep their normal defaults.
