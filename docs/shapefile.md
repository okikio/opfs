# Preview a feature and its matching raw attribute row

`openShapefile` inspects explicitly supplied Shapefile components. Select `shp2d-dbf3` to read 2D Null, Point, PolyLine,
Polygon and MultiPoint geometry, optionally cross-check an index, and inspect raw DBF version 03 rows. Supply the
sources you own; the reader never discovers sibling files or chooses a coordinate reference system or text encoding.

```ts
import { openShapefile } from "@okikio/opfs/dataset/shapefile";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function previewFeature(
  shp: ByteSourceType,
  shx: ByteSourceType,
  dbf: ByteSourceType,
  signal: AbortSignal,
) {
  const dataset = await openShapefile({ shp, shx, dbf }, {
    profile: "shp2d-dbf3",
    signal,
    maxFeatures: 100_000,
  });
  const page = dataset.features({ limit: 64 });
  const first = page.features[0];
  if (!first) return { scope: dataset.scope, next: page.cursor };
  const geometry = await dataset.read(first.id);
  const row = await dataset.attributes(first.id);
  return {
    recordNumber: first.recordNumber,
    kind: geometry.kind,
    xy: geometry.xy,
    parts: geometry.parts,
    deleted: row?.deleted,
    fields: row?.fields,
    integrity: geometry.integrity,
    work: geometry.work,
    next: page.cursor,
  };
}
```

`shp` is required. `shx` and `dbf` are optional supplied values. Without a DBF, `scope` is `geometry`, `fields` is empty
and `attributes(id)` returns undefined. With a DBF, `scope` is `geometry-and-raw-attributes`; its physical row count
must match the geometry count. An absent index is reported as `index: "absent"`; a supplied index must be cross-checked.
Neither scope is a claim that a complete Shapefile sidecar set or GIS project was supplied.

The sources remain borrowed and are never closed. Each source needs `immutable`, `provider` or `caller` stability
evidence, or explicit `allowUnverifiedSource: true`. Its identity is an optional caller assertion, bounded to 8192
UTF-16 code units before JSON provenance composition. All source descriptors/methods and opening options are captured
before the first source await. A component match does not prove that separate providers published an atomic snapshot or
that their owners are the same.

## Find a physical feature

Opening scans the main `.shp` header and every physical record header, retaining bounded descriptors. It reads fixed
geometry metadata and skips large point arrays until selection. For Point, the coordinates are the descriptor bounds, so
opening reads that complete 20-byte body. A Null shape stays in the physical sequence.

`features()` returns stored order. `id` is a zero-based ordinal; `recordNumber` is the one-based number stored in the
main record header. The reader enforces that record numbers begin at 1 and increase by 1. A supplied `.shx` cannot hide
or redirect a main record: every index entry must match the scan-derived main offset and length, with an equal record
count and matching header except its own file length.

`features({ kind, cursor, limit, maxScanned })` has independent result and scan bounds. The default result limit is 256,
hard 4096; the default scan allowance is 8192, hard 65,536. A sparse kind filter can return an empty page with a
continuing cursor. Use that cursor with the same dataset and filter. This method does not read point arrays or return a
hidden timestamp/spatial sort.

## Read one complete geometry

`read(id)` returns an owned `Float64Array` in `[x0,y0,x1,y1,...]` order and an owned `Uint32Array` of part-start
indexes. It admits the complete stored feature and output cost before acquiring its buffers. It checks every selected
coordinate, computes that feature's bounds, validates part starts and minimum lengths, and checks Polygon ring closure.
Returned coordinates preserve their values, including negative zero.

Point and MultiPoint have no stored part arrays, so their returned `parts` is empty. PyShp 3.1.6's high-level MultiPoint
object synthesizes `[0]`; that is an object convention, not a physical field. The native fixture recipe retains that
distinction rather than changing the stored oracle. Polygon parts retain source order and winding; the reader does not
classify holes, repair intersections, normalize winding or turn the result into GeoJSON. Ring closure is not proof of
valid polygon topology. Main-header bounds are retained declarations, not recomputed over every unselected feature.

`source(id)` exposes the exact stored geometry body, including its little-endian shape-type word, as a bounded
`ByteSourceType`. The physical identity is composed unambiguously from the parent identity, offset and length. This view
carries no implicit whole-geometry validation; use `read` for that selected check. It retains source stability and all
ancestor signals and ledgers. Its ranges return owned bytes. Creating or reading a view fails if its inherited signal is
already aborted, even if a fresh child signal is supplied.

This format supplies no native CRC or authentication for these operations: `integrity` is always `not-provided`. Stable
source evidence and byte-level consistency are separate from authenticity. Z/M geometry, MultiPatch, CRS transformations
and spatial indexes other than the supplied SHX are pending separate profiles.

## Keep raw rows aligned

`attributes(id)` reads the same physical ordinal from the supplied DBF. A Null geometry still has a corresponding row. A
deleted row is returned with `deleted: true`; it is never compacted away or shifted onto a different geometry. Opening
validates header/field spans and row count; it does not scan every deletion flag or semantically decode unselected field
values. A selected row's flag must be active 0x20 or deleted 0x2a.

The result's `bytes` is an owned complete row, including that flag. Each `fields[i].bytes` is a fixed-width view into
this owned row, paired with a frozen field descriptor. These views alias the result's own bytes; mutating them cannot
alter a later read or the original source. Spaces, blank numeric representations, Unicode bytes, date strings and
integer text larger than Number can represent remain exact. The library does not silently infer nulls, parse numbers or
choose a code page.

The first raw DBF profile uses the inspected PyShp 3.1.6 version 03 writer layout: 32-byte header, 32-byte descriptors,
a 0x0d terminator, one deletion byte plus the declared field widths per row, and at most one optional 0x1a end marker.
Field names are unique 1–10-byte ASCII names with unambiguous NUL padding. Field codes C/N/F/L/D are retained; memo,
encrypted and other variants refuse rather than following external `.dbt` data. Required reserved bytes are zero in this
selected profile. This is raw DBF layout inspection, not universal dBASE semantic support.

The caller keeps `.prj`, `.cpg` and all other sidecars. CRS and text encoding remain unknown here. Interpret field bytes
only after choosing the actual encoding and field semantics in application code; never derive them from the filename or
coordinate magnitudes.

## Costs, budgets and failures

These are local safety defaults and hard ceilings, separate from the format's signed 32-bit word counts:

| Policy                       |   Default | Hard ceiling |
| ---------------------------- | --------: | -----------: |
| Features                     |   100,000 |    1,000,000 |
| SHP record-header visits     | 1,000,000 |    4,000,000 |
| Metadata reservation         |     8 MiB |       64 MiB |
| Points per selected geometry |    65,536 |    1,048,576 |
| Parts per selected geometry  |      4096 |       65,536 |
| Stored selected geometry     |    16 MiB |       64 MiB |
| DBF fields                   |       128 |         1024 |
| One DBF row                  |    16 KiB |       64 KiB |

Generic `maxSourceBytes`, `maxRequests`, `maxDecodedBytes`, `maxOutputBytes` and an optional external `ledger` apply
too. Opening's local ledger remains a lifetime owner on later calls. An operation adds finite local limits; passing new
options cannot reset the opening quota. Repeated external ledger identity is deduplicated, with a maximum 16 total
owners including generated local owners. Abort is checked after foreign quota callbacks, before provider reads and after
awaited reads; a callback that aborts during the final reservation causes no payload I/O.

`sourceBytes` and requests count complete admitted extents, including repeated work. `decodedBytes` counts all stored
bytes materialized during header parsing, raw row collection or selected geometry conversion. `outputBytes` counts
returned typed coordinate/part buffers or raw bytes. Record, point, part and index-check counts remain visible. Selected
input is collected in requests of at most 64 KiB, then decoded into bounded typed output; it is not constant-memory
streaming. Returned field views share their row buffer rather than allocating another copy per field.

Flat descriptor columns are allocated in groups of at most 256 rows with a 64-byte policy reservation per row, plus
bounded field metadata. This is a policy count, not an exact JavaScript heap measurement. The caller's provider can
allocate internally; those opaque allocations are outside the reader's control. Large main files can require more
opening requests than the generic default 4096; raise explicit budgets only for the workload you intend to admit.

Malformed framing, mismatched optional components, unsupported dimensional/DBF profiles, nonfinite selected coordinates,
invalid parts/rings, quota exhaustion and cancellation fail explicitly. Provider failures retain their original
identity. There are no background tasks, retries, remote acquisition or owned resources to dispose.

## Sources and evidence

The geometry/index grammar is ESRI's
[Shapefile Technical Description](https://www.esri.com/library/whitepapers/pdfs/shapefile.pdf), cover July 1998, J-7855,
version 1000. Inspected primary PDF 126,761 bytes, SHA256
`bd025d588c1ba69428fc36d55e2c6e963c5cd068e54fd9cb1e2706e1962b18c8`. The copyrighted PDF is not copied into the published
fixtures.

DBF3 writer-profile evidence is
[PyShp 3.1.6 source at 7708b60d](https://github.com/GeospatialPython/pyshp/blob/7708b60d598904e35022d840d70ec071a0c4a465/src/shapefile.py),
SHA256 `211b44002f628ea9ad697b365a413fbac73e801f2b2337b391ca91c29eeffec5`. Its exact test-only wheel was acquired
inertly from PyPI and inspected without installation or setup, with actual public Python 3.13.18 ARM64 base and 1 GiB
RAM, 1 CPU and 128-PID quotas. The bundled MIT license and immutable source/metadata hashes are retained. No wheel is a
production dependency.

Authored tests cover physical row alignment, SHX mismatch, selected geometry, raw attributes, hard bounds, inherited
quota/cancellation and native byte slots. Native production completed after a retained harness-only failure exposed
PyShp's synthesized MultiPoint part index. The corrected harness records that separate object convention and
independently checks complete packed physical geometry, DBF row and SHX tuple bytes. Five genuine component sets cover
Point, PolyLine, Polygon, MultiPoint and empty datasets, with Null rows and exact integer text `9007199254740993`. One
explicitly authored deletion-flag mutation per nonempty DBF records native suppression while the candidate preserves
physical association. Native writer DBF header length is 129, row length 66, with no EOF trailer. Raw producer JSON
SHA256 is `82bfbbe0455bc1ffee662efb3f752946d58feb0083f233186de9db843655b5ad`; the exact output remains an inert
snapshot. Same-project writer/reader results do not imply cross-vendor or full Shapefile/dBASE conformance.

The six benchmark lanes in `bench/shapefile.bench.ts` distinguish a 212-byte borrowed record copy from cold main-file
indexing, cold correlated-component indexing, a complete validated polygon conversion, a 66-byte raw attribute row and
an empty sparse metadata page. All native geometry bytes, coordinates, parts and row bytes are checked before timing.
The retained Node 26.13.0 Linux ARM64 run used 1 GiB RAM, no swap, 1 CPU, 128 PIDs and no network or mounts. Median
operation times were about 4.45 µs, 55.18 µs, 89.99 µs, 9.57 µs, 7.41 µs and 0.61 µs respectively. These are different
work contracts, not interchangeable implementations or an SDK speed comparison. Warm views use explicit finite sampling
allowances. Another workspace's existing utility container was left running; its start/end resource snapshots qualify
cross-run comparisons. The fixture [benchmark receipt](../tests/fixtures/shapefile/benchmark.json) retains exact input
hashes, work labels, distributions and the losslessly compressed raw report hash.
