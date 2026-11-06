# Native UDF fixture evidence

`independent.json` and `provenance.json` retain the original native production and full-payload consumer evidence.
`create.py.snapshot` preserves the exact historical harness as inert source, with its mapping in `source-map.json`.

## Current TypeScript harness

Use Node 22.18 or later with the selected native tools already available:

```sh
node --max-old-space-size=128 tests/fixtures/udf/create.ts --seven /path/to/7zz --output /tmp/new-udf-receipt.json
```

The source imports no candidate parser, installs no packages and never mounts an image. It creates one fresh temporary
root, runs native tools with a 45-second command deadline and a 4 MiB quota on each captured pipe, admits regular files
before reading them, and retains both primary and cleanup errors. It writes only to a new output path with exclusive
creation. A signalled or unstarted child cannot count as a native format refusal. The outer runner owns
whole-process/native memory, CPU and filesystem quotas. The command above caps V8 heap at 128 MiB; that is not a native
process memory limit.

All 72 original files, including the hard link and Unicode names, must pass forced `7zz -tUdf` extraction. The long,
split-short and split-long allocation adaptations each repeat that full comparison and get a udfinfo report. The
large/noise original bytes come from the retained historical entry bodies; the source checks their sizes/digests instead
of claiming to emulate CPython Random. Other originals are authored and compared with every historical entry. Images and
historical input are limited to 16 MiB and the receipt to 32 MiB. The unsupported udfinfo version/help probes retain
normal nonzero status separately.

Keep each new receipt separate from `independent.json` and review native versions, complete byte comparisons and
resource receipts before replacing any historical evidence. Native timestamps/metadata can change wire hashes. The
source mapping preserves old bytes and hashes without claiming that TypeScript produced the old output, or that these
cases establish whole-format conformance.
