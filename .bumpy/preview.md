---
"@okikio/opfs": minor
---

### Preview selected archive members under explicit budgets

New optional `archive/zip`, `archive/tar` and `view/zip` subpaths let applications list supported archives and read
selected members under explicit source, request, decoding and output budgets. ZIP views expose read-only filesystem
capabilities and refuse ambiguous paths. A prefix can remain checksum-pending; complete CRC verification requires
consuming the whole member, and CRC does not authenticate its sender.

See the archive guide for complete examples, ZIP/ZIP64 stored and DEFLATE profiles, the narrower ustar profile and exact
unsupported cases. Partial DEFLATE access decodes from the member's start; range access does not imply cheap random
access within compressed data. Archive creation and encrypted ZIP members remain unsupported.
