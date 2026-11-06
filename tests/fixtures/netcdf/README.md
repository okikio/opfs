# Create the native netCDF-C classic profiles

`create.ts` compiles the unchanged test-only `native.c`, then writes and reads CDF-1 and CDF-2 datasets through
netCDF-C. For each version, it covers the mixed numeric/character/scalar profile and single byte, character, short and
empty record-variable profiles: ten outputs in total. Authored TypeScript expectations compare every raw native variable
byte and each native two-record subset. They preserve signed zero and exact integer bytes. This is one native
implementation checked against original values, not reciprocal SciPy/netCDF-C acceptance.

Run from the repository root in a disposable little-endian Linux runner with Node 26, a C compiler, netCDF development
files and util-linux `prlimit` installed:

```sh
node tests/fixtures/netcdf/create.ts --source tests/fixtures/netcdf/native.c --output /tmp/netcdf-native-new.json
```

The output path must be new: exclusive creation refuses to overwrite existing evidence. Each native command has a
60-second deadline with SIGKILL, 4 MiB captured diagnostics and a kernel per-file limit of 16 MiB. Regular input/output
files are size-checked before reading. The tool removes its owned temporary tree. These bounds are not a filesystem
quota. Source hashes, compiler/package versions, commands and native receipts travel with the JSON. Variable names,
shapes and attributes come from the authored native workload; this harness does not independently inspect that metadata
or compare masked/scaled values.

The TypeScript producer has not yet run. It does not reproduce SciPy's separate writer layouts, nonfinite floating-point
values, large 30,000-record case or multi-variable record interleaving. The unchanged `independent.json` and
`provenance.json` retain those profiles and the original reciprocal SciPy/netCDF-C full-byte/subset comparisons. The
exact executed Python source remains inert `create.py.snapshot`; the old filename and source hash keep their identity in
historical receipts. Do not attribute that evidence to the new TypeScript command or overwrite it with a new native-only
profile.
