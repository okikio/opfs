# GeoTIFF native fixtures and their proof boundary

These fixtures let maintainers compare a selected raw raster window with the author's original samples and inspect every
stored strip or tile byte. They do not establish whole-file TIFF conformance, resolved CRS correctness, COG conformance
or source authenticity.

`independent.json.snapshot` is the original producer output, preserved byte for byte. `independent.json` is the readable
JSON copy used by tests. `format-receipt.json` records both hashes and their parsed-value comparison. The original
output is 359,325 bytes with SHA-256 `c06a5fa6e1dee2ea93b1cfca83d894f1e2efd960a36a2e893ecbc8371406c622`.

## What produced and consumed the bytes

The candidate-free `produce.py` ran under system Python 3.11.2 with NumPy 1.24.2, GDAL 3.6.2, tifffile 2023.2.3 and
libtiff 4.5.0. It produced 11 files containing 12 main-chain images. Nine files use GDAL's genuine GTiff writer; two use
tifffile's separate writer with authored GeoKey declarations. GDAL builds EPSG:4326 declarations in its files. The
tifffile GeoKeys instead explicitly retain unresolved, user-defined declarations.

The author's arrays cover little- and big-endian strips, 16 × 16 tiles with padded edges, RGB, unsigned and signed
integers, float32 and float64, NaN, negative zero and infinities. A separate two-image file contains a constant-valued
nearest-neighbor overview. Complete original samples are checked through GDAL and tifffile readers. Every stored block
is checked through `TIFFReadRawStrip` or `TIFFReadRawTile`; native decoded block bits are checked through libtiff's
encoded-read functions. A standard-library `struct` pass separately checks physical headers, IFD fields, byte counts,
offsets and uncompressed block contents against the original arrays.

GDAL and libtiff share a backend and therefore are not independent implementations. Tifffile and the authored physical
byte checks provide separate mechanisms. The metadata declarations remain declarations; successful SDK reading does not
verify the CRS registry or geospatial interpretation.

`independent.json` records each actual IFD offset, field tuple, strip or tile extent, original array, raw block, native
sample comparison and native edge window. For example, the 19 × 17 float32 tiled file contains four 1024-byte padded
tiles. A complete logical raster contains 1292 sample bytes; padding is excluded from that logical window but retained
by a raw tile source. The overview's single 128 × 128 padded tile is intentionally distinct from its 10 × 9 logical
raster.

## Exact execution and dependency ownership

The reviewed offline producer used image `sha256:3a54a562fa82928e49787be93b9ac85184ebe7f0a7398f345a7bf0c5af20a7c9`, with
1 GiB RAM, no swap, 1 CPU and 128 PIDs. It had no network, mounts or published ports. The first producer run exited 0
without OOM after 0.257 seconds. `producer-state.json` records Docker's actual limits and exit state;
`producer-run.json` records the inner deadline and bounded log receipt. `producer.log` is empty. The exact executed
scripts are retained as `.first.snapshot` files, with input hashes in `producer-input-first.json`. `tool-image.json` is
the acquisition-time receipt; its `nativeProducerExecuted: false` records the state before the later producer run, whose
separate terminal receipts are authoritative.

`produce-run.py` limits the process group to 90 seconds and combined logs to 4 MiB; the outer execution bound was 120
seconds. The producer caps files at 16, each file at 1 MiB, aggregate fixture bytes at 8 MiB and JSON at 16 MiB. Native
libraries may allocate internally; the process memory limit is the outer bound.

The signed-Debian acquisition required two retained installation-order repairs before success. Read
`acquisition-notes.md` for the failures, exact 102-archive hashes, original package baseline, ABI boundary and offline
continuation. The scripts retain the package closure and all 102 changed-package notices in `licenses/`. These tools are
test-only; no native SDK or codec dependency is imported by the library.

To reproduce, inspect the public Python base and exact acquired package closure before installation. Run
`acquire-run.py` with `acquire.sh`, then the offline producer with `/usr/bin/python3`, not the base's Python 3.13. The
original failed acquisition and continuation scripts remain snapshots. A currently cached local tool image is not
required or promised by these receipts.

## Primary grammar

The selected profile follows TIFF Revision 6.0, final 1992-06-03, and OGC GeoTIFF 1.1, 19-008r4. Primary source receipts
inspected during implementation are:

| Source                                                                          |   Bytes | SHA-256                                                            |
| ------------------------------------------------------------------------------- | ------: | ------------------------------------------------------------------ |
| [TIFF 6 OSGeo PDF](https://download.osgeo.org/libtiff/doc/TIFF6.pdf)            | 398,722 | `8cb1e1a2226e423ba8b88f57366a30ef1b7ad6109443ebdda072b952739a8d76` |
| [TIFF 6 ITU PDF](https://www.itu.int/itudoc/itu-t/com16/tiff-fx/docs/tiff6.pdf) | 249,524 | `dbcdf729182937ecff415dfd06806894bf03bfd741291aa3ad7ba45335673def` |
| [OGC GeoTIFF 1.1](https://docs.ogc.org/is/19-008r4/19-008r4.html)               | 564,429 | `11bdc2ae93beba691276f94294d8e4c61c7953c53c6522a45d269127b85d9beb` |
| [OGC COG 1.0](https://docs.ogc.org/is/21-026/21-026.html)                       | 149,548 | `5f6b36b21ea1a98c03fb028f1e03bcd560a474a6b9667eda5eb558ac6f28d19c` |

The two TIFF PDF mirrors have different physical bytes; no byte-identity claim is made. The immutable GeoTIFF source tag
1.1 is commit `3a421b08808d235130947018e292842013107874`. Its `GeoTIFF_Standard/standard/GeoTiff.adoc` SHA-256 is
`3492d8e4df799af6930a0026068cd51886b6d9e34a7c0160660bf9323d29e349`; `clause_7_requirements.adoc` is
`ed3357bf76e3c818b62c8d512494a13b3426c0b6b913fc2c818aaaf5b8caa130`. Later evolving master content was not used as 1.1
authority. COG remains a separate, unevaluated conformance boundary.

## Candidate checks and measured work

`validation.json` records 36 passing cases on each of Deno 2.9.8, Node 26.13.0 and Bun 1.4.2, plus owned formatting and
lint checks. The first final lint failure is retained; the repaired rerun changes three loop-local async declarations to
const expressions. Later changes to the option comment and this guide do not change reader behavior. The focused checks
do not replace the root compiler or installed-artifact gates.

`benchmark.json` records seven distinct Node workloads and their finite warm lifetime allowances. `benchmark.json.gz` is
the losslessly verified native Mitata report, retaining all distributions. The raw JSON SHA and exact input closure are
recorded separately. All original samples and stored blocks are checked before timing. The first attempt's quota failure
remains in `benchmark-first.stderr` and its stopped container state; it was repaired only by explicitly supplying the
sampling allowance to the reusable raw block source. The timing result does not compare equivalent work with the
physical-copy lower bound and does not measure a renderer, native SDK or COG server.
