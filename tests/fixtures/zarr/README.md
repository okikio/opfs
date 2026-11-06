# Zarr v2 fixture controls

`independent.json` and `provenance.json` retain the original independent Python-library producer/consumer execution
evidence. The production tests still consume that corpus unchanged. `create.py.snapshot` preserves the exact authored
historical harness as inert data; `source-map.json` records its bytes and SHA-256 without relabelling old receipts as
TypeScript executions.

Use Node 22.18 or later from the repository root:

```sh
node --max-old-space-size=256 tests/fixtures/zarr/create.ts --output /tmp/new-zarr-authored.json
```

`create.ts` imports no candidate implementation and acquires no packages. It authors wire bytes and expected originals
from the fixed historical manual recipe, then compares the complete bytes with saved independent oracles. Its receipt
explicitly sets `independentNativeRerun: false`. That is an authored compatibility control against earlier native
evidence, not a new Zarr/NumPy producer or consumer execution. It refuses existing output paths and never replaces the
historical native corpus.

All 19 numeric dtypes retain little/big-endian storage, both C/F chunk orders and edge fill. The 38 numeric cases
compare every complete logical original and every physical data chunk with the earlier manual writer. The six additional
cases cover scalar, empty, missing, NaN fill, larger arrays and noncanonical boolean bytes. Their complete
originals/chunks compare against the corresponding frozen native or manual evidence. Current metadata is explicitly
authored; this comparison does not execute a native metadata parser.

Signed/unsigned 64-bit maxima use BigInt without passing through Number. Quiet NaNs have explicit bit patterns; negative
zero and infinities remain distinct bytes. Boolean raw bytes 0/2/255/1 stay physical evidence while the authored logical
original normalizes nonzero values to 1. C/F order changes local chunk strides, not row-major canonical originals.
Metadata uses the v2 NaN fill marker and raw uncompressed, unfiltered chunks. No new codec or v3 claim is made.

Historical input and new receipt are each limited to 4 MiB. Fixed cases have at most two dimensions and 512×257 logical
elements; no native process or filesystem extraction occurs.

The heap flag is a V8 limit, not a whole-process memory guarantee. The outer runner owns overall time/memory/filesystem
policy. Qualify the new command and review full-byte comparisons before retaining a new execution receipt. Type checking
alone does not prove those comparisons ran or add format conformance.
