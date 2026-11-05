# UnixFS native evidence and primary-profile differences

`independent.json` retains genuine Kubo imports, every serialized block, CAR exports and complete original/native file
bytes. No candidate module was imported to create these oracles. Three profiles each contain 329 unique blocks:
CIDv1/raw leaves, CIDv0/DAG-PB leaves, and explicit mode/mtime metadata. The size-64 chunker creates multilevel files;
originals include deterministic 20000-byte random data, repeated/deduplicated content, empty files, nested UTF8 names, a
literal `Links` entry and symlink metadata. Kubo `cat` compares every complete ordinary file and selected ranges with
authored originals. Separate genuine standalone raw and DAG-PB file roots are retained too.

`authored.json` is distinct wire-variant evidence, not importer-produced topology. `adapt.py` authors three small CARs
with no inline File data: Links-first expanded, Data-first packed and Data-first mixed `blocksizes`. Each has repeated
raw children, a zero-length raw child and deliberately wrong Tsize hints. Native Kubo imports each CAR and compares
complete and selected-range output with the authored original. All three comparisons pass. This does not establish
behavior for every legacy protobuf variant or another independent native algorithm.

## Retained inline-data incompatibility

The first authored run failed. Its File had a seven-byte `inline|` prefix followed by two nine-byte `leaf-data`
children. The primary grammar defines inline content before linked content, giving 25 bytes. Native Kubo 0.43.1 instead
returned 18 bytes, `leaf-dataleaf-data`. The exact failed root is
`bafybeihi2epnlfwmxahvzzz53wfsnpbvqsqwlt3fd54hyc4t3er6r2yhha`. `inline-failure.json` retains reconstructed exact
CAR/block input, expected primary bytes, independently observed native bytes and diagnostic identities. It is explicitly
a mismatch receipt, not successful interoperability. The candidate's inline-before-links test follows the primary
grammar and is **not** claimed to match Kubo on that input.

The first script SHA256 was `2f5680610afce4a1c517afe72835624024f9300a8fc8262691862d5c42df93d4`; a diagnostic-only
revision was `f1b2263ecf6cec7a1b3e7015abde0d681f07d3d4ca3d82e1873d3275efee213d`. The subsequent successful cases were
explicitly renamed `*-no-inline` and have a separate source/receipt hash below. No native output became the candidate's
inline byte oracle and the failure was not silently repaired.

The cause is visible in pinned native source. Kubo's `UnixfsAPI.Get` calls Boxo's `unixfile.NewUnixfsFile`. Its pinned
Boxo v0.43.0 revision is `d133242046c3fb796050017089ae581d8f54a38c`. In
[`ipld/unixfs/io/dagreader.go`](https://github.com/ipfs/boxo/blob/d133242046c3fb796050017089ae581d8f54a38c/ipld/unixfs/io/dagreader.go),
`CtxReadFull` and `WriteTo` skip any node with child links, assuming internal nodes have no file data. This explains the
observed omission. The native producer emits a compatible balanced layout without that combined inline shape.

## Primary source pins

The selected
[UnixFS document](https://github.com/ipfs/specs/blob/b4ad54e3a8baa8a395c2d17b7eab123099efb228/src/unixfs.md) is dated
2026-09-17 and declares draft status. Source size 73991 bytes, SHA256
`385f09505b79b6845e274035b6175fcd4780246ec850eaf45138b4bbcce301fa`. That header is not treated as resolution of
conflicting maturity labels elsewhere. Its Directory section requires refusal of duplicate byte names, while its
path-resolution section requires first-match behavior. This implementation's strict literal-entry profile refuses
duplicates and does not implement that conflicting path resolver. It does not normalize literal names or follow
symlinks.

The current
[DAG-PB grammar](https://github.com/ipld/ipld/blob/b78bf00219b6ba843223e8eb2af11a5447a9567d/specs/codecs/dag-pb/spec.md)
is pinned at `b78bf00219b6ba843223e8eb2af11a5447a9567d`, 9890 bytes, SHA256
`806255813f14e22a416b079bdace9d24ef7c42a7ab84c29cfcb3fa15e16a2f81`. `primary.json` also retains the archived predecessor
pin with its relocation notice, the native importer and reader source hashes, Kubo `go.mod`, and the pinned
go-unixfsnode reader source consulted for API feasibility. Those source inspections are not claimed as an executed
second consumer. No upstream executable setup or production SDK was copied.

## Native environment and reproduction

Both native producer groups ran offline in separate disposable containers with `--network none`, 2 GiB memory, two CPUs
and 256 PIDs. The ARM64 base was `opfs-seven-tools:20261105`, SHA256
`527d62a5244f4fa71833b4a105a4906ec1c1c7708f64ea2967fa04d96c551dd5`. No host mounts, credentials or daemon were used.
Each CLI call has `--offline`, a private temporary `IPFS_PATH`, checked exit status and a finite timeout. Only a
successful final receipt was copied from the container.

Kubo is the verified vendor ARM64 release, not a global installation. Source revision
[`acc53c093810a8fe9a4bc2f023f0b1e0c1d629b5`](https://github.com/ipfs/kubo/tree/acc53c093810a8fe9a4bc2f023f0b1e0c1d629b5),
release v0.43.1, published 2026-09-15. `release.json` records the public download and digest receipt.
`kubo_v0.43.1_linux-arm64.tar.gz` is 39040966 bytes with SHA256
`e09237abadd9578d7a73dd2e2b718848b78437cb56e48cc9742b23ce9ebac829`. The extracted binary SHA256 is
`49f878c64edfaaf9915aa710b22b12703c05a3cc1e8f916752d76df5913f5422`. The binary reports `0.43.1-acc53c093`, ARM64/Linux,
Go 1.26.5 and repository version 18. Scripts verify the tar digest and architecture before extracting only `kubo/ipfs`
into an owned temporary directory.

Copy the verified vendor archive and scripts into a disposable ARM64 container, then run:

```sh
python3 /produce.py --archive /kubo.tar.gz --output /tmp/unixfs-independent.json
python3 /adapt.py --archive /kubo.tar.gz --output /tmp/unixfs-authored.json
```

The retained `inline-failure.json` CAR can also be imported into that private offline repository and read with `cat` to
reproduce the native difference. To reproduce the original authored input with the script, explicitly restore the
seven-byte `head = b"inline|"` and label those cases as inline variants; they are expected to fail the native exact-byte
assertion. Do not relabel them as successful no-inline cases.

CAR/block bytes and originals are retained in full. Temporary directory names and captured command receipts can differ
across runs; compare original file bytes and actual native results rather than asserting byte-identical JSON receipts
without also fixing those paths. Native commands and their stderr are retained in the JSON, including any tool warnings.
There is no real gateway, deployed IPFS network, HAMT, identity hash, writer or full-directory completeness claim.

## Retained bytes

| File                  | SHA256                                                             |
| --------------------- | ------------------------------------------------------------------ |
| `produce.py`          | `b1ce8782f22f3c4cb1ab6ecb03eeff7cd22019f7dc0d3eb21bb3eaf4d2e726d5` |
| `independent.json`    | `41f437d34da41a29e10d8897c93abf2b7192c4d69291df7feb1aef7d6aa8f55f` |
| `adapt.py`            | `aa2ca5d43fdd4883c78cb6c0c9818c4996826a8b4c175a0d8c7a81876d0af014` |
| `authored.json`       | `a10176661e55045f28d643c0bf20b47a7dee98c2236f068075a13d167027aaf1` |
| `inline-failure.json` | `e225ff4b54eb0806760fbb51f95ade4b8d4e1d0038e586033b24398e9af5bada` |

The fixture JSON files use Deno formatting. Original compact producer-output SHA256 values were
`0772616d0070c27fb0d343261e8ae237e71f561f63a2ced843ad2f5b348a7894` (genuine) and
`3915d49e1d5b5a203144d361b715ec649f0dd678b82ea1f91e7477c5256ec684` (authored); parsed records and embedded bytes are
unchanged.
