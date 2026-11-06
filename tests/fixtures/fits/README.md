# Create the native CFITSIO FITS profile

`create.ts` compiles the unchanged test-only `native.c`, asks CFITSIO to write its two-image profile, and reads it back
through CFITSIO. Authored TypeScript expectations compare every stored int16 and exact int64 byte, plus the int16
image's unscaled physical doubles. Native CFITSIO must report both data and HDU checksums valid for both images. This is
one native implementation checked against original values. It is not reciprocal Astropy/CFITSIO acceptance.

Run from the repository root in a disposable little-endian Linux runner with Node 26, a C compiler, CFITSIO development
files and util-linux `prlimit` installed:

```sh
node tests/fixtures/fits/create.ts --source tests/fixtures/fits/native.c --output /tmp/fits-native-new.json
```

The output path must be new: exclusive creation refuses to overwrite existing evidence. Each native command has a
60-second deadline with SIGKILL, 4 MiB captured diagnostics and a kernel per-file limit of 16 MiB. Regular input/output
files are size-checked before reading. The tool removes its owned temporary tree. These bounds are not a filesystem
quota. Source hashes, compiler/package versions, commands, native receipts and profile limitations travel with the JSON.
Image names and axes in the JSON describe the authored workload; this harness does not independently inspect that
metadata.

The TypeScript producer has not yet run. Its current profile does not reproduce Astropy's uint8, int32, floating-point,
NaN/infinity, empty, scaling/BLANK or large-array cases. Those profiles remain in the unchanged historical
`independent.json` with their original reciprocal Astropy/CFITSIO evidence in `provenance.json`. The exact original
Python source is inert `create.py.snapshot`; its historical filename and hash retain their identity in receipts. Do not
attribute those historical checks to the new TypeScript command or replace their JSON under the old attribution.
