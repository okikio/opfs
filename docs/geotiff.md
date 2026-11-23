# Read a raw GeoTIFF window

`openGeotiff` borrows one stable byte source and returns bounded main-directory metadata plus selected uncompressed
raster windows. This optional public subpath requires an explicit `classic-geotiff-raw` profile. It keeps geospatial
declarations visible without choosing a projection database, renderer, color conversion or missing-value policy.

```ts
import { openGeotiff } from "@okikio/opfs/dataset/geotiff";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType, signal: AbortSignal) {
  const raster = await openGeotiff(source, { profile: "classic-geotiff-raw", signal });
  const image = raster.images[0];
  if (!image) throw new Error("No raster image was admitted.");
  const rectangle = { x: 0, y: 0, width: Math.min(64, image.width), height: Math.min(64, image.height) };
  const planned = raster.plan(image.id, rectangle);
  const pixels = await raster.read(image.id, rectangle, { maxOutputBytes: 1024 * 1024 });
  return {
    values: pixels.values,
    bands: pixels.samplesPerPixel,
    photometric: image.photometric,
    declaredGeo: image.geo,
    planned,
    actual: pixels.work,
    integrity: pixels.integrity,
    cog: raster.cog,
  };
}
```

The caller owns the source and its transport, authentication and lifetime. Opening captures the source's size, identity,
stability and read method before the first asynchronous callback. The reader never closes it or discovers sidecars.
Identity is an optional assertion limited to 8192 UTF-16 code units; it is not a digest. Supply `immutable`, `provider`
or `caller` stability evidence, or deliberately select `allowUnverifiedSource: true`.

## Select an admitted image and window

`images` follows the classic TIFF main-IFD next-pointer chain, in stored order. An IFD is an Image File Directory: a
finite table of typed tags and the next image's offset. The list covers that admitted chain, not hidden extension
directory trees. SubIFDs, masks, pages, extra sample bands and depth layouts are outside this profile. Every public
image descriptor and its nested declaration arrays are frozen; they cannot change the private chunk index.

The profile accepts both little- and big-endian classic TIFF identifier 42. Storage must be uncompressed and
pixel-interleaved, with orientation 1, fill order 1 and no predictor. One-band raw grayscale/scientific or three-band
RGB images use uniform u8, u16, i16, u32, i32, f32 or f64 samples. BigTIFF, packed bits, palettes, alpha, separate
planes and compressed data refuse explicitly. Unknown well-sized tags retain numeric IDs without arbitrary payload
acquisition; unknown field types refuse because the reader cannot establish their extent.

Coordinates are stored pixel indexes. `read(id, {x,y,width,height})` returns an owned typed array in row-major,
pixel-interleaved order, with every stored band. No orientation transform, band selection, scaling, resampling or
rendering occurs. In particular, Photometric 0 (WhiteIsZero) is retained and samples are **not inverted**. Photometric 1
(BlackIsZero) and 2 (RGB) also remain declarations for the caller's chosen rendering pipeline.

Floating arrays retain NaN, infinity and negative-zero semantics. Typed numeric conversion does not promise the original
NaN payload bits. Use a raw block source when exact stored bits matter. No numeric value is automatically classified as
missing, and extension-specific nodata metadata is not applied.

`plan(id, rectangle)` is synchronous and performs no source I/O or ledger reservation. Its fixed strategy creates one
span per intersecting row segment within a strip or tile. Each span is split into source requests of at most 64 KiB. The
plan reports the exact source bytes, request count, decoded bytes, output bytes, pixels, spans and distinct chunks that
`read` will use for the same admitted window. An empty rectangle inside or at the image boundary returns empty owned
output without payload I/O. Out-of-image rectangles fail.

Because chunks are uncompressed, a small window can read only its intersecting row spans. It does not have to collect
every byte in those tiles. Boundary tile padding is retained by physical sources and excluded from logical windows. The
descriptor's `blocks` counts strips or padded tiles; `source(imageId, blockId)` exposes one complete physical block as
an independently useful ByteSource. Its tuple identity combines parent identity, physical offset and length without
ambiguous concatenation. Creating a block source rejects a composed identity above 8192 UTF-16 code units; the reader
does not silently truncate or hash it. This does not turn a padded block into a cropped logical image or authenticate
it.

## Keep geospatial declarations separate from interpretation

A full-resolution admitted image needs GeoKeyDirectory metadata and either model scale/tiepoints or a model matrix. The
first profile checks directory version 1, revision 1, minor 0 or 1, key order/uniqueness and parameter bounds.
Referenced SHORT arrays must follow the directory entries; DOUBLE and ASCII references must stay within their tags.
GeoASCII retains raw bytes and pipe-terminated strings without Unicode normalization, external URL following or
projection lookup. Unknown key codes remain unresolved numeric declarations.

`geo.scope` is `unresolved-declarations`, or `absent-reduced-image` for an admitted reduced image that supplies no
GeoKeyDirectory. Scale, tiepoint and model matrix values remain stored declarations. Mutually conflicting authorities
fail. The reader does not resolve EPSG codes, transform axes, derive WGS84 bounds, infer a CRS from numeric magnitudes
or apply PixelIsPoint half-pixel conventions. A reduced image does not silently inherit a georeferencing assertion.

`integrity` is always `not-provided` for this profile: TIFF supplies no checksum for these selected operations. Source
stability, admitted offset consistency and source authenticity are different claims. `cog` is always `not-evaluated`. A
tile layout or successful HTTP range read alone cannot prove the GeoTIFF, overview, layout and server requirements of
the COG standard. This reader is not a whole-file TIFF/GeoTIFF validator, COG certifier or CRS validator.

## Bound work and retain cancellation authority

The following are local safety policies, not TIFF's provider or format limits:

| Policy                               |   Default | Hard ceiling |
| ------------------------------------ | --------: | -----------: |
| Main-chain images                    |        64 |         1024 |
| Entries in one IFD                   |      1024 |         8192 |
| Total block descriptors              |    65,536 |    1,048,576 |
| Retained metadata reservation        |     8 MiB |       64 MiB |
| One known-tag value                  |     1 MiB |       16 MiB |
| GeoKeys per image                    |      1024 |         8192 |
| Pixels in one window                 | 1,048,576 |   16,777,216 |
| Window or raw source interval output |    16 MiB |       64 MiB |
| Planned row spans                    |    65,536 |    1,048,576 |

Generic source, request, decoded and output budgets apply too. Opening's local quota is a lifetime owner on every later
operation. Each read adds finite local quotas and retains external ancestor ledgers, deduplicated by identity. The
maximum 16 total owners includes generated local owners. Supplying new options cannot reset inherited budgets. Source,
request, decoded and output costs are all reserved before selected result allocation and provider I/O. `decodedBytes`
counts every materialized metadata or row-span byte; `outputBytes` counts returned typed or raw bytes. Metadata
reservations are conservative policy units, not a measured JavaScript heap size. The source provider may allocate
internally beyond the reader's visibility.

All ancestor abort signals remain authoritative through derived block sources. A fresh child signal cannot replace an
aborted parent. Foreign ledger callbacks are followed by an abort check before provider I/O. Reused borrowed scratch is
copied before later source callbacks, and native byte extents are checked independently of spoofable properties.
Original provider failures retain their identity. There is no background work, retry or owned source resource requiring
disposal.

The selected profile also refuses sparse zero-offset chunks, ambiguous overlapping blocks, raster storage overlapping
structural metadata, malformed cardinalities and non-exact uncompressed byte counts. These are explicit conservative
admission rules; unusual otherwise valid TIFF layouts are not declared universally invalid. Pure plans may allocate
bounded span descriptors, and reads materialize bounded windows; neither is constant-memory byte streaming.

## Primary sources and proof status

Grammar follows [TIFF Revision 6.0](https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf), final 1992-06-03,
and [OGC GeoTIFF 1.1, 19-008r4](https://docs.ogc.org/is/19-008r4/19-008r4.html). The immutable GeoTIFF source tag 1.1 is
commit `3a421b08808d235130947018e292842013107874`; evolving master is a later draft and is not authority here.
[COG 1.0, 21-026](https://docs.ogc.org/is/21-026/21-026.html) supplies the separate conformance boundary.

The final 36 cases passed on Deno 2.9.8, Node 26.13.0 and Bun 1.4.2 in the isolated 1 GiB/no-swap/1-CPU/PID-128 runner.
They cover 25 authored admission, ownership and quota cases plus 11 genuine native files containing 12 main-chain
images. The candidate reads every original sample and every stored block, preserving raw NaN bits separately from
numeric semantics. Owned formatting and lint checks pass. The first final lint run found three block-scoped function
declarations; its failure remains recorded alongside the repaired rerun.

The offline producer used GDAL 3.6.2, tifffile 2023.2.3 and libtiff 4.5.0. GDAL and libtiff share a backend; tifffile
and authored physical byte checks provide separate mechanisms. EPSG codes remain declarations, and successful SDK
reading does not establish CRS correctness. [Fixture provenance and reproduction](../tests/fixtures/geotiff/README.md)
retain the original bytes, primary grammar pins, complete native comparisons, two acquisition failures, package notices
and process limits. No compiler or package-artifact result is claimed by these focused checks.

The [current reproduction recipe](../tests/fixtures/geotiff/README.md#current-native-only-recipe) replaces Python
orchestration with TypeScript and direct GDAL/libtiff C++ calls. Nine GDAL writer profiles retain the same scalar,
byte-order, block and overview cases. Two explicitly authored TypeScript writers replace the old tifffile writer cases;
GDAL, libtiff and an authored physical-word reader compare the resulting bytes. This new recipe does not repeat the
independent tifffile implementation proof. Its separate offline native qualification passed all eleven files and twelve
main-chain pages with GDAL 3.6.2 and libtiff 4.5.0 in a network-disabled 1 GiB runner, without OOM. The two authored
writer profiles remain authored inputs checked by native consumers; they are not GDAL-produced files. The old corpus and
receipts remain unchanged. Producer qualification does not establish candidate-reader acceptance of the new output,
authoritative CRS resolution or COG conformance.

The seven Node benchmark lanes separately measure a borrowed 64-byte physical copy, cold metadata indexing, early and
late float32 windows, a complete logical raster, a complete raw tile and a pure plan. The full native sample and block
oracles run before sampling. Their different validation, conversion and allocation contracts prevent a direct speed
ratio from being meaningful. [The benchmark receipt](../tests/fixtures/geotiff/benchmark.json) retains distributions,
work counts, environment, limits and the verified compressed raw report. These are small-fixture costs on one Linux
ARM64 runner, not an SDK, renderer or COG throughput claim. The first attempt exhausted a reusable raw source's default
request lifetime; the setup repair passes an explicit finite sampling allowance while retaining ordinary per-read
ceilings.
