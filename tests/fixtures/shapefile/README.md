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

Follow [the native recipe](native-recipe.md) to reproduce the independently reviewed acquisition and offline execution.
`acquisition-state.json` and `producer-state.json` retain actual resolved image and resource facts; the successful
producer exited 0 without OOM. Container network was disabled for execution, with no mounts or ports. The producer uses
only the verified wheel through zipimport and never imports candidate code.

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
