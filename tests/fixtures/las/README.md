# LAS 1.2 fixture controls

`independent.json` and `provenance.json` retain the original independent Python-library producer/consumer execution
evidence. The production tests still consume that corpus unchanged. `create.py.snapshot` preserves the exact authored
historical harness as inert data; `source-map.json` records its bytes and SHA-256 without relabelling old receipts as
TypeScript executions.

Use Node 22.18 or later from the repository root:

```sh
node --max-old-space-size=256 tests/fixtures/las/create.ts --output /tmp/new-las-authored.json
```

`create.ts` imports no candidate implementation and acquires no packages. It authors wire bytes and expected originals
from the fixed historical manual recipe, then compares the complete bytes with saved independent oracles. Its receipt
explicitly sets `independentNativeRerun: false`. That is an authored compatibility control against earlier native
evidence, not a new laspy/NumPy producer or consumer execution. It refuses existing output paths and never replaces the
historical native corpus.

All 16 manual-writer cases are retained: LAS 1.2 point formats 0–3 crossed with empty, 37-point, 37-point with opaque
extensions and 12,000-point clouds. The source authors signed coordinates, return/classification bits, scan angles,
scaled XYZ, GPS time and RGB columns before packing records. Both header and point suffix extensions remain opaque.
Every full file, complete record span, selected record span and complete column must match the frozen independently
consumed struct-writer case. It does not reproduce the additional 16 native laspy-written files or claim ExtraBytes/CRS
semantics. Future LASzip/GDAL qualification would be a separate reviewed profile, not evidence added here.

Historical input and new receipt are each limited to 16 MiB. The authored case set bounds individual clouds to 12,000
points and records to 35 bytes. No native process or filesystem extraction occurs.

The heap flag is a V8 limit, not a whole-process memory guarantee. The outer runner owns overall time/memory/filesystem
policy. Qualify the new command and review full-byte comparisons before retaining a new execution receipt. Type checking
alone does not prove those comparisons ran or add format conformance.
