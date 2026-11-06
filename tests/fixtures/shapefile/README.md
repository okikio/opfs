# Shapefile fixture provenance

These fixtures support the bounded `shp2d-dbf3` reader. They prove the selected physical layout and selected complete
feature bytes, not general Shapefile, dBASE, topology, CRS or encoding conformance.

The primary grammar is the
[ESRI Shapefile Technical Description](https://www.esri.com/library/whitepapers/pdfs/shapefile.pdf), version 1000,
J-7855. Its cover says July 1998 and its internal date says March 1998. The inspected PDF is 126,761 bytes, SHA256
`bd025d588c1ba69428fc36d55e2c6e963c5cd068e54fd9cb1e2706e1962b18c8`. Its copyrighted bytes are not redistributed here.

The test-only producer and reader are
[PyShp 3.1.6](https://github.com/GeospatialPython/pyshp/tree/7708b60d598904e35022d840d70ec071a0c4a465). Its retained MIT
license accompanies its source snapshot. `shapefile.py.snapshot` matches pinned `src/shapefile.py`: 188,541 bytes,
SHA256 `211b44002f628ea9ad697b365a413fbac73e801f2b2337b391ca91c29eeffec5`. The wheel, package metadata, exact member
hashes and inspected standard-library imports are recorded in `acquisition.json`. No PyShp import or installation is
required by the library or ordinary tests.

[The native recipe](native-recipe.md) records the historical reviewed acquisition and offline execution. Its Python
sources are now inert `.snapshot` data. `acquisition-state.json` and `producer-state.json` retain actual resolved image
and resource facts; the successful producer exited 0 without OOM. Container network was disabled for execution, with no
mounts or ports. The producer uses only the verified wheel through zipimport and never imports candidate code.

`independent.json.snapshot` preserves the exact successful JSON output; `independent.json` is its formatting-safe test
import. `format-receipt.json` records both hashes and equality of decoded JSON values. Five genuine writer profiles
cover Point, PolyLine, Polygon, MultiPoint and empty files. Native writer/reader checks cover complete original
coordinates and attributes. Separate Python `struct` checks cover complete packed geometry, SHX offsets and raw DBF
rows. Exact integers beyond JavaScript's safe range remain decimal strings in the JSON oracle. This is same-project
writer/reader evidence plus an independent byte parser, not cross-vendor interoperability.

The original producer failed because PyShp's object API synthesizes `parts: [0]` for nonempty MultiPoint records. The
stored format has no part array. `produce-first.py.snapshot`, `producer-first-state.json` and
`producer-first-failure.log` retain that attempt. The successful harness preserves physical empty parts and records the
native object's synthetic parts separately. No candidate behavior changed to fit that convention.

Deletion-flag variants are explicitly authored modifications of genuine DBF files. Their hashes and original bytes are
in the fixture. Native PyShp suppresses those rows; this library preserves their physical ordinals and exposes the flag
so a later feature keeps its original row association. No signature, checksum or source authenticity is implied.

## Current authored TypeScript controls

Run `node tests/fixtures/shapefile/produce.ts --output /ABS/NEW-shapefile.json` with Node 22.18 or later. The output
path must not exist. Stage this directory with `../iso/native.ts` and `../codec.ts` if copying it into an isolated
runner. No package is acquired.

`produce.ts` writes all five component profiles from authored geometry and attribute rows. It compares every SHP, SHX
and DBF byte and every deletion variant with the frozen corpus. IEEE-754 negative zero is checked in packed geometry;
the integer `9007199254740993` is encoded through BigInt. The DBF header date is deliberately fixed to the historical
2026-11-05 date rather than the current clock. Empty files and physical MultiPoint parts remain distinct from PyShp
object conventions.

The new receipt says `independentNativeRerun: false`: it does not invoke PyShp or establish fresh independent
conformance. Historical native full-value checks above remain the independent evidence. `source-map.json` links exact
source snapshots and hashes. The retired acquisition harness acquired only that historical Python wheel; current
controls need no replacement downloader. New receipts are controls, not replacements for `independent.json`.
