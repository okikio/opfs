# Refresh native codec evidence with TypeScript

These tools create new candidate-free codec evidence from authored inputs. They never import the OPFS codec being
checked, install packages or download native programs. Run them inside the reviewed disposable tool environment with
finite container memory, CPU and process budgets. Each child command additionally has a 90-second deadline and a 16-MiB
capture ceiling per output stream. Those limits do not replace the container's native memory limit.

Native child commands use `LANG` and `LC_ALL` set to `C.UTF-8` in the admitted Linux environment or `en_US.UTF-8` on
macOS. The tool environment must provide that locale. Libarchive converts member names through it; inheriting `C` can
refuse valid Unicode names before a payload comparison. A missing locale is a fixture-environment failure, not a reason
to replace names, skip Unicode cases or count partial output as a passing comparison.

Use a new output path when comparing results. Every tool requires `--output`; none silently overwrites the adjacent
historical corpus. The output is published only after the complete original bytes pass the required native consumers.
`codec.ts` owns subprocess bounds, complete-byte comparison and receipt publication. `zip-codec.ts` owns the narrow
ZIP32 inspection and explicitly authored data-descriptor controls shared by the two ZIP producers.

| Tool                     | Native programs required | Expected result                                                                                            |
| ------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `compression/create.ts`  | Node built-in zlib       | gzip, zlib and raw-DEFLATE bytes, optional gzip headers, empty/expansion/TAR cases                         |
| `compression/produce.ts` | `brotli`, `zstd`         | Full-byte native codec round trips and tool version output                                                 |
| `bzip/produce.ts`        | `bzip2`, `7zz`           | All nine levels, multiple blocks, repeated bytes and observed padding behavior                             |
| `xz/create.ts`           | `xz`, `7zz`              | Native containers, supported/refusal profiles, independent CRC64 checks and native corruption refusals     |
| `lzma/create.ts`         | `xz`, `7zz`              | Alone/raw profiles, all 75 supported property combinations, reset compositions and reciprocal native reads |
| `zip-bzip/create.ts`     | `7zz`, `bsdtar`          | Native method-12 ZIPs and labelled authored data-descriptor controls                                       |
| `zip-lzma/create.ts`     | `7zz`, `bsdtar`          | Native method-14 ZIPs, observed properties and labelled data-descriptor controls                           |

For example, run these commands from the repository root after native tools have been admitted. `--seven`, `--xz`,
`--bzip`, `--bsdtar`, `--brotli` and `--zstd` select explicit executable paths where the corresponding tool needs one.
The tool does not acquire a missing executable or infer approval from its name.

```sh
node tests/fixtures/compression/create.ts --output /tmp/compression-next.json
node tests/fixtures/compression/produce.ts --output /tmp/native-codecs-next.json
node tests/fixtures/bzip/produce.ts --seven /usr/bin/7zz --output /tmp/bzip-next.json
node tests/fixtures/xz/create.ts --seven /usr/bin/7zz --output /tmp/xz-next.json
node tests/fixtures/lzma/create.ts --seven /usr/bin/7zz --output /tmp/lzma-next.json
node tests/fixtures/zip-bzip/create.ts --seven /usr/bin/7zz --bsdtar /usr/bin/bsdtar --output /tmp/zip-bzip-next.json
node tests/fixtures/zip-lzma/create.ts --seven /usr/bin/7zz --bsdtar /usr/bin/bsdtar --output /tmp/zip-lzma-next.json
```

A zero exit establishes the comparisons implemented by that producer. It does not prove a public cloud deployment, a
cryptographic audit, all possible codec profiles or the candidate package's runtime behavior. Run the corresponding
package tests and artifact checks separately. A source-only migration does not count as a successful new native run.

## Preserve old evidence while changing its producer

Historical expected JSON and provenance receipts remain unchanged. The former Python sources are now inert
`*.py.snapshot` files. Do not execute those snapshots. When a historical receipt names `create.py` or `produce.py`,
append `.snapshot` to locate its exact original bytes. Their hashes still identify the original execution rather than
the new TypeScript implementation.

| Original source relative to this directory | SHA-256 of its retained `.snapshot`                                |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `compression/create.py`                    | `e623ca6c0747c4c313c51489a17cf4e1c1929b7ceb579966dc6645a067af7c39` |
| `compression/produce.py`                   | `2ee734a3acb1f603c52265e71c9e396e55839dc5d0717ecf6d9471ddbd0fd96e` |
| `bzip/produce.py`                          | `8b0b444e171d3c42024f3d27e8c9bf121f1228b4efa022fe6fb102088c48fbb1` |
| `xz/create.py`                             | `361411982ae611586f9e11f68b88f3246dea14c16083b2d260ef6099684ea9c7` |
| `lzma/create.py`                           | `ca06c2ae05a047f1144cf288fcb4639bf7e3b734e1ae98a195e368e41ace4743` |
| `zip-bzip/create.py`                       | `a363e2aea6093a88d7d8eb8337a7b0cee71632b75f73fabcf00b5669f0e4e194` |
| `zip-lzma/create.py`                       | `65ebde7b1474b65338c1084643b54a556b6492287c87448b36edf773e359dd08` |

New receipts identify the executing TypeScript source, native tool versions and shared harness source hashes. The new
xorshift byte recipes in BZip2, XZ and LZMA differ from Python's historical random generator. Native-only ZIP producers
also do not impersonate Python's ZIP writer: their descriptor controls are authored framing around genuine native
compressed extents, and independent native consumers must accept their complete payloads. Retain the historical
Python-produced rows as additional evidence; do not discard them merely because the current producer cannot recreate
that original implementation.

After a new run, compare coverage and bytes before deliberately replacing any retained corpus. Preserve native refusals
as diagnostics with their real exit status, and explain any removed or newly supported profile. Keep the old receipt if
its source, tools, recipe or output differs. A JSON file with familiar member names is not a substitute for that
evidence trail.

The CLI contracts were checked against the [XZ manual](https://tukaani.org/xz/man/xz.1.html),
[bzip2 manual](https://www.sourceware.org/bzip2/manual/manual.html) and
[Node zlib documentation](https://nodejs.org/api/zlib.html). Actual command acceptance and output are separate runtime
checks against the admitted tool versions.
