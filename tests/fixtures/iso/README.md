# Native ISO fixture evidence

`independent.json` and `provenance.json` retain the original native production and full-payload consumer evidence.
`create.py.snapshot` preserves the exact historical harness as inert source, with its mapping in `source-map.json`.

## Current TypeScript harness

Use Node 22.18 or later with the selected native tools already available:

```sh
node --max-old-space-size=128 tests/fixtures/iso/create.ts --output /tmp/new-iso-receipt.json
```

The source imports no candidate parser, installs no packages and never mounts an image. It creates one fresh temporary
root, runs native tools with a 45-second command deadline and a 4 MiB quota on each captured pipe, admits regular files
before reading them, and retains both primary and cleanup errors. It writes only to a new output path with exclusive
creation. A signalled or unstarted child cannot count as a native format refusal. The outer runner owns
whole-process/native memory, CPU and filesystem quotas. The command above caps V8 heap at 128 MiB; that is not a native
process memory limit.

Both xorriso and genisoimage produce primary-only and Joliet images. isoinfo and independent libarchive must recover
every complete authored payload, with no duplicates or missing files. The pinned isoinfo cannot emit UTF-8, so Joliet
display names retain `-j iso8859-1`. Node cannot pass raw Latin-1 argv bytes directly. A fixed `/bin/sh` command
converts an ASCII octal escape for only the final filename argument with `printf '%b'`, then execs isoinfo. Each
filename byte is escaped, arguments remain separate, and NUL/CR/LF or identifiers over 1 KiB are refused. No filename is
interpreted as shell source. This boundary preserves the native consumer and Unicode payload case. Images are limited to
16 MiB, extracted files to 2 MiB, listings/trees to 16 entries and the receipt to 32 MiB.

Keep each new receipt separate from `independent.json` and review native versions, complete byte comparisons and
resource receipts before replacing any historical evidence. Native timestamps/metadata can change wire hashes. The
source mapping preserves old bytes and hashes without claiming that TypeScript produced the old output, or that these
cases establish whole-format conformance.
