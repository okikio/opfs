# Independent native XAR evidence

Run `python3 tests/fixtures/xar/produce.py` from the repository on macOS with `/usr/bin/xar` and `/usr/bin/bsdtar`. The
script uses Python's standard library only. It writes complete genuine producer bytes to `independent.json`, with SHA256
receipts, native tool versions, header code/size receipts, authored member bytes, and consumer results.

Six archives come from Apple xar 1.8dev: stored/zlib member encoding crossed with SHA1/SHA256/SHA512. A seventh is
produced by bsdtar. The retained consumer identifies itself as bsdtar 3.5.3 using libarchive 3.7.4. Native xar extracts
all files; bsdtar extracts SHA1 archives exactly. This bsdtar refuses Apple's code 3/code 4 SHA2 archives, and failed
stderr/exit receipts are retained rather than hidden. Python independently decodes TOC/member zlib streams, validates
all TOC/member checksum scopes with hashlib, and compares the entire decoded byte sequences with authored inputs. No
candidate reader output establishes the oracle.

Production tools run synchronously with checked exit status. Failed producer/native extraction aborts generation;
expected bsdtar refusals are retained with nonzero status. No shell pipe hides a producer failure. The three authored
files include UTF8 text, binary bytes 0..255 repeated three times, and an empty file, with one nested path. macOS-native
metadata (including com.apple.provenance EA when present), times and user/group names remain unchanged. Regeneration can
change these genuine archive bytes and hashes. EAs are opaque evidence and are never applied by the reader.

The pinned dialect source is Apple's archive.c at commit 3efbc308e3699a4ab8258fd769f5853bae91a2dc, source SHA256
`aafad8b949b2dc555f141d8c281ec675cea9485bef2bb3ddbaa5415fe0f2c6f2`:
https://github.com/apple-oss-distributions/xar/blob/3efbc308e3699a4ab8258fd769f5853bae91a2dc/xar/lib/archive.c The
source's license is BSD-style; no source implementation was copied. The authored generator and inputs use the repository
license. Native tools are test-only dependencies; production imports no native SDK or executable.
