# Preview verified UnixFS files and directory entries

UnixFS describes files and directories as content-addressed blocks. The block reader supplies storage or transport;
`openUnixfs()` verifies and interprets those blocks. You can inspect a directory or read a selected file range without
fetching every child. A root CID does not prove that its descendants are available.

```ts
import { openUnixfs } from "@okikio/opfs/content/unixfs";
import type { UnixfsBlockReaderType } from "@okikio/opfs/content/unixfs";

export async function previewUnixfs(
  rootCid: string,
  readBlock: UnixfsBlockReaderType,
  subtle: SubtleCrypto,
): Promise<Uint8Array> {
  const root = await openUnixfs(rootCid, readBlock, { subtle });
  if (root.kind !== "directory") throw new Error("Expected a directory root");
  const entry = await root.open("hello.txt");
  if (entry.kind !== "file") throw new Error("hello.txt is not an ordinary file");
  const preview = await entry.read({ offset: 0, length: Math.min(64, entry.size) });
  console.log(preview.scope, preview.integrity, preview.work);
  return preview.bytes;
}
```

The borrowed `readBlock(cid, { maxBytes, signal })` callback returns a complete serialized block. It should enforce
`maxBytes` before collecting an incoming response where possible. This module checks the returned native byte extent,
admits its owned allocations, copies the bytes, and verifies SHA2-256 before parsing or returning content. It does not
trust a callback's verification label. The supplied `subtle.digest` method is bound before the first callback and no
crypto capability, gateway, credential, block store or network transport is discovered.

The callback's own allocation is opaque: a post-return size check cannot prevent it from first allocating an oversized
response. Request admission happens before the callback; serialized byte admission happens after its exact size is
known, before this module copies or hashes it. A CAR reader can supply the callback with this adapter:

```ts
import type { CarReaderType } from "@okikio/opfs/content/car";
import type { UnixfsBlockReaderType } from "@okikio/opfs/content/unixfs";

export function carBlocks(car: CarReaderType): UnixfsBlockReaderType {
  return async (cid, options) => {
    const block = await car.read(cid, options);
    return block.bytes;
  };
}
```

That reader keeps its existing verification, source and permission contracts. The additional UnixFS verification is
deliberate. No existing gateway trust mode changes.

## Selected bytes and complete-file evidence

A file's `size` comes from its verified local header. Its inline content precedes its child links, in original link
order. `blocksizes` describes each child's logical file bytes; it must pair exactly with the link array. The declared
`filesize`, or zero when absent, must equal inline bytes plus that list. Logical offsets are checked and indexed before
a range is selected. Fetching a child verifies both its block hash and its actual local logical size against the
parent's declaration. `Tsize` is an optional cumulative serialized-DAG hint, not logical length; wrong hints do not
change reads or authorize accounting.

`file.read({ offset, length })` returns owned buffered bytes with `scope: "selected-file-range"`. Only intersecting
branches are fetched; a tiny range can still require several complete serialized blocks and intermediate headers. An
untouched subtree can be missing or have inconsistent declarations. Even a full-length range can skip a zero-length
child, so it does not claim complete-file availability. An empty range performs no child acquisition and proves nothing
new about unexamined children.

```ts
import type { ByteSourceType } from "@okikio/opfs/source";
import type { UnixfsFileType } from "@okikio/opfs/content/unixfs";

export async function verifiedUnixfsSource(file: UnixfsFileType): Promise<ByteSourceType> {
  const result = await file.verify({ maxSourceBytes: 8 * 1024 * 1024, maxRequests: 2048 });
  console.log(result.scope, result.work);
  return file.source({ maxSourceBytes: 8 * 1024 * 1024, maxOutputBytes: 1024 * 1024 });
}
```

`file.verify()` explicitly traverses every descendant of that file, including zero-length links. Each edge checks its
child type and declared logical size. It returns `scope: "complete-file"` only after that traversal succeeds. It does
not verify directory siblings, an entire CAR or availability after the operation. A later read still verifies acquired
blocks and can fail if the backing store no longer supplies them. Neither result authenticates an author or proves that
a CID was obtained from a trusted publisher.

`file.source()` composes with exact-range archive readers. Its identity names the verified root CID and logical UnixFS
file representation, not one contiguous physical block extent. Its immutable stability means successful reads are bound
to that content identity; it does not promise permanent block availability. Each read verifies selected blocks, uses a
fresh bounded operation cache and retains all parent lifetime limits and abort signals.

## Literal directories, links and metadata

A directory exposes its complete local link list without opening children. Every entry retains literal UTF8 `name`,
canonical CID and optional declared decimal `tsize`. The original order is retained, including unsorted names.
`directory.open(name)` matches **one exact Name field**. It does not split slashes, percent-decode, normalize Unicode,
interpret `.` or `..`, resolve an IPFS URI or access a host path. This entry-lookup API is deliberately separate from
UnixFS path resolution. Missing names fail. Two byte-identical directory names are refused rather than shadowed.

Symlinks expose only owned target metadata bytes and have no file read/source method. They are never followed. Optional
mode retains the complete `modeRaw` uint32 and separately exposes only defined low-twelve-bit `mode` values. Optional
mtime retains signed decimal seconds and optional fractional nanoseconds; absence remains unspecified rather than
becoming the epoch. No permission, timestamp or link is applied to a host filesystem.

The strict profile accepts raw-codec files, DAG-PB File, ordinary Directory and inert Symlink nodes with complete
SHA2-256 multihashes. It refuses legacy DAG-PB Raw, reserved Metadata, HAMT shards, identity CIDs, other multihashes and
other codecs when selected. An unopened link can declare another profile, but listing it does not claim that profile is
supported. HAMT hashing/bitmap semantics, writers, imports, encryption and transport remain separate work.

Both contiguous Links-first and Data-first PBNode encodings are accepted. PBLink fields must be known, ordered and
unique; singular UnixFS authority fields cannot be duplicated. Expanded, packed and mixed repeated `blocksizes` are
accepted in wire order. The decoder refuses unknown fields/wire types, malformed UTF8, non-minimal/overflowing varints,
interleaved Links/Data/Links, named File children, unsafe logical sums, inconsistent sizes and invalid time fractions.
This is a bounded explicit profile, not a general Protocol Buffers decoder. File-size fields on non-file nodes and
HAMT-specific fields are outside the profile.

## Budgets, cancellation and ownership

| Policy            | Default | Hard ceiling or meaning                                                          |
| ----------------- | ------: | -------------------------------------------------------------------------------- |
| `maxBlockBytes`   |   1 MiB | 8 MiB serialized bytes per callback result                                       |
| `maxLinks`        |   16384 | 65536 links per node and entries per blocksizes list                             |
| `maxDepth`        |      64 | 128 graph edges from the opening root, including later directory opens           |
| `maxNameBytes`    |    4096 | 65536 UTF8 bytes; caller UTF16 length is checked before encoding                 |
| `maxIndexBytes`   |   4 MiB | 16 MiB estimated node/index allocation per operation                             |
| `maxNodes`        |    4096 | 65536 node admissions, including repeated cached references                      |
| `maxEdges`        |  100000 | 1000000 examined directory/file edges per operation                              |
| `maxSteps`        |   16 Mi | 64 Mi protobuf byte/field, seek and lookup work units                            |
| `maxCacheBytes`   |   4 MiB | 16 MiB serialized block buffers retained in one operation; zero disables cache   |
| `maxSourceBytes`  |  64 MiB | Cumulative acquired serialized bytes; foreign callback allocation remains opaque |
| `maxRequests`     |    4096 | Cumulative callback acquisitions, admitted before invoking the callback          |
| `maxDecodedBytes` |  64 MiB | Owned block/hash copies and index reservations                                   |
| `maxOutputBytes`  |  16 MiB | Returned buffers; one read also has a hard 16 MiB allocation ceiling             |

Opening limits span all later child opens, reads, verifications and source reads. Limits supplied to a directory open
also span that child handle's later operations. Source options create a separate cumulative owner for its repeated
reads. Per-call limits narrow those owners. The optional `ledger` composes with other bounded readers; the same ledger
object is charged once even when supplied at several levels. Failed reservations are not refunded. Separate operations
share no global cache and never retain a complete reconstructed file as a hidden cache.

Index estimates reserve 128 bytes per node, 256 per link plus four times CID wire bytes and twice name bytes, and eight
bytes per child-size entry before allocating the corresponding indexed data. These are conservative local estimates, not
exact JavaScript engine heap measurements. The complete block and hash input each consume decoded work before
allocation; symlink target copies are charged separately. Cache size counts retained serialized buffers, while index
memory has its own admission. Repeated CID references can reuse an operation-local verified node, but every edge still
checks the expected size and counts graph work. Results expose `work` with source/request/decoded/output dimensions plus
nodes, edges, links, parser steps, index bytes, cache bytes and cache hits.

The reader and crypto capability stay borrowed. No worker, stream, connection or background task is acquired. Parent,
child and operation signals compose; a fresh signal cannot revive an aborted opening or directory. Abort is checked
after foreign acquisition, after uninterruptible Web Crypto and before returning results. Source and digest failures
retain their original errors. Pure parsing is synchronous and finitely bounded; this is a buffered preview API, not a
claim of byte-stream backpressure or constant memory.

## Independent evidence and remaining scope

The [fixture receipt](../tests/fixtures/unixfs/README.md) pins the primary September 2026 UnixFS document, current
DAG-PB grammar and Kubo source/release identity. It records genuine offline Kubo imports with raw and DAG-PB leaves,
multilevel files, repeated content, empty files, nested names and optional mode/mtime. Every complete original file and
selected range was compared by native Kubo before this implementation existed. Separately authored CAR variants test
field ordering and packed/mixed sizes through native import/cat; they are not described as genuine importer topology or
a second independent native algorithm.

One native compatibility difference is retained explicitly: Kubo 0.43.1 omits inline content in a File that also has
child links. The pinned primary grammar places it before the linked bytes, which this implementation follows. The
fixture retains the native 18-byte result and the primary 25-byte expectation. No native interoperability claim is made
for that combined shape; the successful packed/field-order fixtures are separately named no-inline cases.

The selected UnixFS document declares draft status; that label is not used to resolve conflicting maturity claims
elsewhere. It also contains contradictory duplicate-name requirements: the Directory section requires refusal, while its
path section requires first-match behavior. This strict entry-lookup profile follows the refusal rule and makes no claim
to implement the conflicting path resolver. Unknown/unselected descendants and deferred HAMT profiles stay explicitly
unverified.

`bench/unixfs.bench.ts` measures cold file-header opening, selected early/late/full-length ranges, explicit
complete-file traversal and repeated-content cache admission. Full native original-byte checks precede timing. Labels
separate acquired bytes, hash/materialization work, edges, parser steps and cache reuse. Warm sampling uses an explicit
finite 64 GiB / ten-million-request lifetime allowance at every retained handle; per-operation policies remain finite.
The decoded Blob copy baseline supplies existing plaintext without block verification and is only a lower bound. These
in-memory protocol workloads do not measure Kubo network transport or establish a universal cache speedup.
