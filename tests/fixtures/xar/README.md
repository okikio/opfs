# Independent native XAR evidence

The historical `produce.py.snapshot` used macOS `/usr/bin/xar` and `/usr/bin/bsdtar` with Python standard-library
checks. The retained `independent.json` has SHA256 receipts, native tool versions, header code/size receipts, authored
member bytes, and consumer results.

Six archives come from Apple xar 1.8dev: stored/zlib member encoding crossed with SHA1/SHA256/SHA512. A seventh is
produced by bsdtar. The retained consumer identifies itself as bsdtar 3.5.3 using libarchive 3.7.4. Native xar extracts
all files; bsdtar extracts SHA1 archives exactly. This bsdtar refuses Apple's code 3/code 4 SHA2 archives, and failed
stderr/exit receipts are retained rather than hidden. In that historical run, Python independently decoded TOC/member
zlib streams, validated all TOC/member checksum scopes with hashlib, and compared the entire decoded byte sequences with
authored inputs. No candidate reader output establishes the oracle.

Native fixture tools run synchronously with checked exit status. Failed producer/native extraction aborts generation;
expected bsdtar refusals are retained with nonzero status. No shell pipe hides a producer failure. The three authored
files include UTF8 text, binary bytes 0..255 repeated three times, and an empty file, with one nested path. macOS-native
metadata (including com.apple.provenance EA when present), times and user/group names remain unchanged. Regeneration can
change these genuine archive bytes and hashes. EAs are opaque evidence and are never applied by the reader.

The pinned dialect source is Apple's archive.c at commit 3efbc308e3699a4ab8258fd769f5853bae91a2dc, source SHA256
`aafad8b949b2dc555f141d8c281ec675cea9485bef2bb3ddbaa5415fe0f2c6f2`:
https://github.com/apple-oss-distributions/xar/blob/3efbc308e3699a4ab8258fd769f5853bae91a2dc/xar/lib/archive.c The
source's license is BSD-style; no source implementation was copied. The authored generator and inputs use the repository
license. Native tools are test-only dependencies; production imports no native SDK or executable.

## Current TypeScript harness

Use Node 22.18 or later with the selected native tools already available:

```sh
node --max-old-space-size=128 tests/fixtures/xar/produce.ts --xar /usr/bin/xar --bsdtar /usr/bin/bsdtar --output /tmp/new-xar-receipt.json
```

The source imports no candidate parser, installs no packages and never mounts an image. It creates one fresh temporary
root, runs native tools with a 45-second command deadline and a 4 MiB quota on each captured pipe, admits regular files
before reading them, and retains both primary and cleanup errors. It writes only to a new output path with exclusive
creation. A signalled or unstarted child cannot count as a native format refusal. The outer runner owns
whole-process/native memory, CPU and filesystem quotas. The command above caps V8 heap at 128 MiB; that is not a native
process memory limit.

The seven native producer profiles are retained, including SHA1/SHA2 and stored/zlib combinations. Native xar must
extract every complete original. Libarchive must match SHA1 originals; SHA2 success/refusal status is recorded without
hiding a failed spawn or producer. Node checks the fixed header, bounded TOC decompression and compressed-TOC digest.
Its small checksum-tag reader is limited to the observed native shape; it is not a general XML parser. It does not rerun
the historical Python per-member XML/checksum walk. The receipt says `memberChecksumWalk: false`, so native extraction
proof and that historical extra checksum proof stay distinct. Archive files are limited to 16 MiB, decoded/packed TOCs
and extracted files to 1 MiB, and the receipt to 32 MiB.

Keep each new receipt separate from `independent.json` and review native versions, complete byte comparisons and
resource receipts before replacing any historical evidence. Native timestamps/metadata can change wire hashes. The
source mapping preserves old bytes and hashes without claiming that TypeScript produced the old output, or that these
cases establish whole-format conformance.
