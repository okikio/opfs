# Preview LAS 1.2 point clouds

`openLas` indexes a stable LAS 1.2 file and reads selected points into owned typed columns. It supports uncompressed
point formats 0–3. Opening reads the fixed header and variable-length record (VLR) headers; it does not load every point
or interpret projection metadata. This example previews the first 16 points and requests scaled coordinates.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openLas } from "@okikio/opfs/dataset/las";

export async function preview(file: Blob) {
  const dataset = await openLas(createBlobSource(file), {
    maxPoints: 1024 * 1024,
    maxMetadataBytes: 8 * 1024 * 1024,
    maxVlrs: 4096,
    maxSourceBytes: 64 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const selected = await dataset.read({ offset: 0, count: Math.min(16, dataset.points), scale: "physical" });
  return {
    points: dataset.points,
    raw: { x: selected.X, y: selected.Y, z: selected.Z },
    physical: selected.physical,
    classification: selected.classification,
    georeferencing: dataset.georeferencing,
    work: selected.work,
  };
}
```

`offset` and `count` are point positions, rather than byte offsets. A read acquires only the selected complete point
records, in source requests of at most 64 KiB. All fields of those records are read, including opaque suffixes. The
reader does not fetch unrelated points, resample the cloud, spatially index coordinates, or turn header bounds into
verified statistics.

## Stored columns and coordinate interpretation

The result uses separate arrays for fields that consumers can traverse independently. Input is little-endian; each
numeric value is explicitly decoded into the corresponding native typed array.

| Result                              | Meaning                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `X`, `Y`, `Z`                       | Stored signed `Int32Array` coordinates, always returned                              |
| `intensity`, `sourceId`             | Stored `Uint16Array` fields                                                          |
| `returnNumber`, `returnCount`       | Unsigned three-bit return fields in `Uint8Array`                                     |
| `scanDirection`, `edgeOfFlightLine` | Unsigned one-bit fields, 0 or 1                                                      |
| `classificationByte`                | Full stored classification byte                                                      |
| `classification`                    | Lower five bits, without assigning application meaning to class codes                |
| `classificationFlags`               | Upper three bits shifted down: synthetic, key-point, withheld                        |
| `scanAngleByte`                     | Full stored unsigned scan-angle byte                                                 |
| `scanAngleRank`                     | Separately named signed two's-complement interpretation, native-proven against laspy |
| `userData`                          | Uninterpreted unsigned byte per point                                                |
| `gpsTime`                           | `Float64Array` for formats 1 and 3 only                                              |
| `red`, `green`, `blue`              | `Uint16Array` channels for formats 2 and 3 only; no color-space conversion           |
| `extra`                             | Concatenated opaque suffix bytes, `extraBytesPerPoint` bytes per selected point      |

The original LAS 1.2 document gives the scan-angle range −90…90 but labels its table field unsigned. The API preserves
the raw byte and exposes the conventional signed interpretation separately. Neither representation is hidden or silently
clamped. Other decoded bit fields likewise preserve their stored values; this preview does not perform a whole-file
check of return-number consistency, classification validity or scan-angle range.

Default `scale: "raw"` returns stored coordinates only. `scale: "physical"` additionally returns
`physical: { x, y, z }`, three `Float64Array` columns computed as `raw * headerScale + headerOffset`. Header scale and
offset values must be finite. Arithmetic can still overflow or produce IEEE nonfinite values; the reader does not clamp
them or invent a validity mask. The coordinate system, units, datum and axis meaning are not inferred. Scaling does not
perform reprojection. Signed zero and floating infinities are numeric values; GPS NaN payload bits are not a
serialization guarantee.

`gpsTimeType` reports the low global-encoding bit: `week`, or `adjusted-standard` (standard GPS time minus 1e9). GPS
numbers are not converted into JavaScript dates or UTC. Reserved global bits refuse this profile.

## Metadata and opaque bytes

The dataset exposes declared point count, format, record width, point-data offset, scales/offsets, bounds and counts by
return. Bounds and return counts are **header declarations**, not statistics verified by scanning the cloud. The source
extent must contain every declared point. Trailing bytes are reported as a count and are not interpreted.

The ordinary public header is 227 bytes. A bounded extension is represented by `headerExtension: { offset, size }`; its
bytes are not eagerly read or interpreted. The caller still owns the original source and can inspect this extent under
their own source budget. A gap after the final VLR and before points is similarly reported as `metadataGap`. Point
records must be at least 20, 28, 26 or 34 bytes for formats 0, 1, 2 or 3. A longer record has an opaque suffix, which is
returned in `extra` without interpreting ExtraBytes descriptors or extension-specific encodings.

VLR headers contain `userId`, `recordId`, description, reserved value and a checked payload extent. Headers are read
sequentially because payload lengths determine subsequent positions. VLR bodies stay borrowed in the source until
explicitly selected. To inspect an opaque payload without loading the cloud:

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openLas } from "@okikio/opfs/dataset/las";

export async function previewMetadata(file: Blob) {
  const dataset = await openLas(createBlobSource(file));
  const record = dataset.vlrs[0];
  if (!record) return undefined;
  const selected = await dataset.readVlr(record.id, {
    offset: 0,
    length: Math.min(record.size, 256),
    maxSourceBytes: 256,
    maxOutputBytes: 256,
  });
  return { userId: record.userId, recordId: record.recordId, bytes: selected.bytes };
}
```

`readVlr` returns an owned copy. Its byte/request/decoded/output work composes with the same opening authorities as
point reads. A source identity or opaque VLR is not authentication. `georeferencing: "opaque-vlr"` means only that a VLR
with user ID `LASF_Projection` exists. `none` means none was found. Neither state establishes valid projection keys. The
original specification requires projection metadata; this reader also previews native files without it and therefore
makes no full LAS-conformance claim.

## Admission, ownership and limits

Opening captures the source size, stability, identity and bound read method before I/O. The source must explicitly
declare `immutable`, `provider` or `caller` stability for the snapshot being inspected. The reader borrows it and never
closes or mutates it. All indexes and scalar metadata are captured/frozen; changing a public metadata array cannot
redirect future reads. Options are copied at invocation.

| Policy             | Default   | Effect                                                                      |
| ------------------ | --------- | --------------------------------------------------------------------------- |
| `maxPoints`        | 1,048,576 | Selected points per read, not declared file point count                     |
| `maxVlrs`          | 4096      | Indexed VLR headers                                                         |
| `maxMetadataBytes` | 8 MiB     | Whole pre-point extent, including skipped extensions, bodies and gaps       |
| `maxSourceBytes`   | 64 MiB    | Requested source bytes                                                      |
| `maxRequests`      | 4096      | Exact-range source requests                                                 |
| `maxDecodedBytes`  | 64 MiB    | Parsed fixed/VLR-header bytes and selected complete point/VLR payload bytes |
| `maxOutputBytes`   | 16 MiB    | Returned column/suffix bytes, or returned VLR bytes                         |

For each point read, exact selected source bytes/requests, decoded work and output bytes are admitted before column
allocation or point I/O. Base column payload costs 26 bytes per point; GPS adds 8, RGB adds 6, physical XYZ adds 24, and
opaque suffixes add their exact width. Temporary source chunks, typed-array headers, source/provider copies and metadata
objects add memory beyond returned payload accounting. There is no claim of exact peak heap usage. Source metrics count
the requested extents at this layer; provider transport prefetch needs its own limits.

Opening limits remain cumulative lifetime authorities. Each read also has fresh per-operation limits, which cannot raise
the opening authority. Additional read ledgers compose with opening ledgers. Passing the same ledger again charges it
once. Reservations are not refunded after failures. Use explicit finite larger opening budgets when repeated interactive
previews are intended. `work` reports admitted byte/request work for that operation, not a wall-clock deadline or
complete transport accounting.

Opening and per-operation abort signals compose. Both are checked even for zero-point/zero-byte selections, and the
combined signal reaches source reads. A source ignoring cancellation must settle before the operation returns; original
provider errors propagate. There are no background jobs or owned source resources to retire.

## Supported profile and evidence

Only LAS 1.2 uncompressed point formats 0–3 are supported. LAZ, later/earlier LAS versions, waveform formats, COPC,
ExtraBytes interpretation, CRS/GeoTIFF interpretation, spatial queries, writers and full-file conformance validation are
excluded. Signature, version, global bits, geometry, metadata bounds and exact acquired extents are checked. Every
result states `integrity: "not-provided"`: this profile has no content checksum and proves no publisher identity.

The primary document is ASPRS LAS 1.2, approved 2008-09-02, retained via the
[libLAS archival mirror](https://liblas.org/_static/files/specifications/asprs_las_format_v12.pdf). The live original
ASPRS URL returned 404 during pinning; the mirrored title, approval, header/VLR tables, point layouts and scaling/GPS
clauses were compared with indexed official text. This is a mirrored-artifact receipt, not a claim of byte equality with
an unavailable live original. SHA256 and exact acquisition/tool receipts are retained with the fixtures.

Test-only native fixtures use laspy and NumPy: laspy-produced files and an independently authored struct writer are both
read by laspy and compared against complete original stored columns and scaled XYZ. Fixtures cover all four formats,
empty/ordinary/larger clouds, signed scan bytes, opaque header/point extensions, full record bytes and selected record
extents. Authored controls separately test corrupt/truncated inputs, budget admission, ownership and aborts. These tools
are not production dependencies. Benchmarks preflight every complete/selected output against the original native arrays,
then compare cold indexing, selected/full columns and native preindexed byte copies. Those operations have different
costs and semantics; one run establishes no universal speed advantage.
