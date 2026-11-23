# Native MCAP NONE fixtures

These files support a bounded read-only MCAP major-0 profile. They do not claim all upstream conformance cases, message
serialization decoding, or additional codecs.

The authoritative primary specification is foxglove/mcap commit `23d6c627a27ac089d418d9e7f8cdcef9ed86dac1`,
`website/docs/spec/index.md`, SHA256 `4197b0200bb5c657d2a97e70816b078fdb050a9027f030c342c2862a3c33b3b6`. Its original
Markdown, registry, notes and MIT license remain `.snapshot` bytes. The normative record definitions control over older
terminology in the notes.

`acquire.py` downloaded only the 21,955-byte Python `mcap==1.6.0` wheel with SHA256
`7cd37fba2cf51d033f2139ca837d2ed3024dcec3cd9f8ecdf3d4d15930df6e17`. It rejected redirects and admitted exact ZIP member
paths, ordinary file types, stored/DEFLATE methods and finite member/expanded-size bounds after checking the whole-wheel
hash. No setup, pip, package import or extra dependency ran during acquisition. `acquisition.json` records every member
byte hash. Exact selected package source and metadata are inert snapshots. The wheel's METADATA declares MIT but the
wheel includes no LICENSE file; the repository's separately pinned MIT license is retained as `LICENSE.snapshot`.

The exact wheel's writer and stream reader catch ImportError for both optional lz4 and zstandard imports. The NONE
writer does not use those branches. The native offline producer asserts both packages are absent, zipimports only the
pinned wheel, and uses standard-library harness code. Python 3.11.2 ran in the recorded ARM64 task image. No SDK is a
production import or runtime dependency of the TypeScript reader.

`produce.py.snapshot` is the exact executed candidate-free producer. It creates original opaque binary messages from
`(j*31+i*17)%251`, nanosecond timestamps beginning at2^63, a binary schema, Unicode channel metadata, a binary
attachment and named metadata. It uses the SDK's Writer with NONE compression, then checks all message and schema bytes,
attachment bytes and exact metadata through native sequential and seeking reader paths. These are two paths from the
same project, not cross-vendor validation.

| Genuine writer profile | File bytes | Messages | Summary start | Summary CRC |
| ---------------------- | ---------: | -------: | ------------: | ----------: |
| chunked                |       2689 |        7 |          1743 |  3563058382 |
| unchunked              |       1842 |        7 |          1311 |  3045754221 |
| zero-summary           |       1348 |        7 |             0 |  1875167664 |
| empty                  |        322 |        0 |            74 |  1079046675 |

The producer independently uses standard-library zlib CRC 32 over each actual summary plus the 25-byte footer prefix.
For the zero-summary file it hashes the footer prefix alone and obtains the native writer's1875167664. It never
interprets zero summary start as the beginning of the file. Native readers validate available CRCs on their supported
paths; the seeking reader can fall back to its sequential reader when no chunk indexes exist. This fallback is not a
second implementation.

Raw producer JSON SHA256 `2606def430cd78c19ac9098b0fd8f294cabd0b52b004a3bf2fb9668ff2c6eb8d` is preserved in
`independent.json.snapshot`. `independent.json` is the formatting-adapted test import; any formatting must preserve JSON
semantics and its own hash must be recorded separately. Embedded MCAP bytes retain their individual raw SHA256 values.
There were no acquisition or native execution failures in this slice. `acquisition-state.json` and `producer-state.json`
retain actual exit0, no OOM, image identities and 1 GiB/1 CPU/PID 128 caps; the producer had network none, no host
mounts or ports. `native-recipe.md` explains reproduction and approval/resource ownership.

`tests/mcap.test.ts` separately authors malformed framing, definition conflicts, duplicate maps, unsupported chunk
profiles, sparse pagination, inherited budgets/cancellation and native byte-brand regressions. Those are authored tests,
not copied upstream conformance IDs. Upstream `.mcap` entries represented as Git LFS pointers have not been acquired or
resolved. No conformance claim follows from the repository tree listings.
