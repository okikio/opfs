# Read selected contiguous HDF5 values

Use `@okikio/opfs/dataset/hdf5` to list direct root links in a supplied HDF5 snapshot and preview a flat interval of
stored numeric values. This is an explicit classic-contiguous profile, not a complete HDF5 or netCDF-4 reader.

```ts
import { openHdf5 } from "@okikio/opfs/dataset/hdf5";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(blob: Blob) {
  const file = await openHdf5(createBlobSource(blob), {
    profile: "classic-contiguous",
  });
  const links = file.list();
  const grid = await file.dataset("grid");
  const selected = await grid.read({ offset: 257, count: 128 });
  return {
    links,
    shape: grid.shape,
    values: selected.values,
    integrity: selected.integrity, // "not-provided"
    work: selected.work,
  };
}
```

`offset` and `count` count scalar elements in C order: the last dimension varies fastest. An omitted count selects the
remaining elements within policy. A scalar has shape `[]` and one value. A zero dimension produces an empty array. The
return owns a new typed array; callers can mutate it. Signed/unsigned 64-bit integers stay in
`BigInt64Array`/`BigUint64Array`, so precision is not lost through JavaScript numbers. IEEE binary32/binary64 preserve
infinities, NaN and negative zero. No scale, units, missing-value or fill interpretation is applied.

To compose with another byte reader, use the stored byte extent:

```ts
import { openHdf5 } from "@okikio/opfs/dataset/hdf5";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function rawPreview(source: ByteSourceType) {
  const file = await openHdf5(source, { profile: "classic-contiguous" });
  const dataset = await file.dataset("i32_le");
  const stored = dataset.source();
  const bytes = await stored.read(0, Math.min(16, stored.size));
  return { bytes, byteOrder: dataset.datatype.endian, evidence: stored.stability };
}
```

That source returns raw file bytes in file byte order, rather than converted values. Its JSON-tuple identity includes
the parent's identity, object address, data address and byte length. Its stability remains the parent's evidence; a
physical offset does not establish immutability or authenticity.

## Names and the selected grammar

`list()` returns all direct root links only after the entire admitted root tree has been parsed and its sorted names and
upper-bound keys checked. Link names are literal, strict UTF-8 (including a preserved initial U+FEFF), nonempty names
without `/`, `.` or `..`. Hard aliases may share an object address. Soft-link targets and subgroup names remain inert
metadata. `dataset(name)` accepts an exact direct hard-link name and refuses a group; it does not resolve paths or
follow soft links. List results own their name-byte copies, so mutating one result does not change the index.

The admitted writer grammar is superblock version 0 at byte zero, zero base address, eight-byte addresses/lengths, no
driver information or live consistency flags, object-header version 1 with bounded continuations, local heap version 0,
and a level-zero classic group B-tree containing version-1 symbol nodes. Cached root tree/heap addresses must agree with
the authoritative root symbol-table message. Child cached group pointers are not used or verified. Datasets require
dataspace version 1, version-1 full-width signed/unsigned integer or standard IEEE floating datatypes, and version-3
contiguous layout. Both byte orders are decoded. Root B-trees with internal levels are refused. The declared end of
allocation must fit the supplied source; bytes after it are not inspected or declared canonical.

Shared or conditional object-message flags, custom precision/padding, nonstandard float layouts, strings,
compound/enum/reference/variable-length values, newer superblocks and metadata, user blocks, rebased/family files,
external storage, filters, compact/chunked/virtual layouts and SWMR/live interpretation are outside this profile.
Unknown non-authority message payloads are bounded metadata but are not interpreted. Attributes are not exposed. A
nonempty unallocated dataset is refused: the reader never invents fill values. An empty dataset with undefined storage
address and zero storage length is admitted. Metadata/data corruption can go undetected: this legacy profile has no
checksum or authentication proof, and every result says `not-provided`.

## Ownership, budgets and cancellation

Sources are borrowed and are never closed. Supply `stability: "immutable"`, `"provider"` or `"caller"` on a custom
source; an identity alone is insufficient. `allowUnverifiedSource: true` explicitly permits sources without that
evidence, with the risk that separate reads observe different revisions. Source size, method, identity and stability are
captured before the first read. Source callbacks must return exact native byte extents, including cross-realm views; a
short return fails rather than silently truncating the preview.

Opening limits persist through dataset views, converted reads and raw sources. Each derived operation also honors its
own limits and inherited external `ledger`. Reusing the same external ledger does not charge it twice; up to 16 total
distinct owners, including generated local owners, may be composed on one view chain. `createArchiveLedger` can share
allowance with other archive readers. Byte owners reserve the full selected source/request/decoded/output work before
result allocation or payload I/O. Reservations remain charged after failures. Requests are at most 64 KiB each, and a
converted read has one selected typed array plus a bounded packed-byte scratch extent. A custom source may allocate
internally before returning; that allocation belongs to its provider.

| Policy                                                                     |   Default | Hard implementation ceiling |
| -------------------------------------------------------------------------- | --------: | --------------------------: |
| Lifetime metadata bytes visited and retained link metadata (separate caps) |     4 MiB |                      16 MiB |
| Retained root links                                                        |      4096 |                       65536 |
| Lifetime metadata node visits                                              |      4096 |                       16384 |
| Lifetime object messages visited                                           |     16384 |                       65536 |
| Continuation depth                                                         |        16 |                          64 |
| Dataset rank                                                               |        16 |                          32 |
| Name or soft-target UTF-8 bytes                                            |      4096 |                       65536 |
| Selected scalar elements per read                                          | 1,048,576 |                   4,194,304 |
| Selected bytes per converted/raw read                                      |     8 MiB |                      32 MiB |

Retained links charge 128 bytes per entry plus three times name UTF-8 bytes and twice target UTF-8 bytes against a
separate ceiling equal to the metadata byte policy. This bounds string/name-copy retention even if malicious heap
strings overlap. These are library policy bounds, not HDF5 format maxima. Generic ledger defaults are 64 MiB source,
4096 requests, 64 MiB decoded and 16 MiB output bytes. Metadata visits count source and decoded bytes, including re-read
dataset headers. Converted or raw reads count selected bytes in all three byte dimensions; listing counts copied
name/target bytes as output. Metadata/node/message visits are counted cumulatively even when admission later fails. File
`work` reports lifetime work; dataset `work` reports its opening metadata work; each read reports its own reserved work.
No whole-file scan or checksum is hidden in a tiny range.

An opening `signal` remains authoritative through every child. A dataset or raw source can add cancellation, but a fresh
read signal cannot override an aborted ancestor. Cancellation is checked before admission, after borrowed reads and
before returning converted values. Provider errors retain their original error identity. There are no open file handles,
codecs or background jobs to release.

## Evidence and scope

The [fixture provenance](../tests/fixtures/hdf5/README.md) pins the primary HDF5 grammar, signed distribution packages
and native producer recipe. Genuine h5py 3.7.0/HDF5 1.10.8 bytes contain 37 authored datasets, a hard alias, a soft link
and a subgroup. The producer checks authored physical bytes, h5py reads and `h5dump -b FILE` output independently of
this reader. h5py and h5dump share HDF5's implementation; they are not two independent HDF5 implementations. Selected
candidate values and full raw extents are checked against those original oracles, including big integers, endian
conversion and special floats.

Seven genuine unsupported files exercise newer superblocks, chunking, gzip filters, compound types, unallocated nonempty
data, a deeper root tree and a user block. Separate authored mutations exercise bounds, continuation framing, duplicate
authority, source admission and inherited cancellation/ledger rules. This does not claim arbitrary HDF5 producer
coverage or complete file validation.

`bench/hdf5.bench.ts` checks all native original bytes and typed values before measuring six distinct workloads:
borrowed copying, cold root indexing, cold selected metadata, raw stored ranges, converted ranges and converted full
grid. Warm sampling has finite explicit lifetime allowance. Copy-only and converted results are different contracts;
neither is an HDF5 SDK throughput comparison.

One retained Node 26.13.0 ARM64 macOS/Apple M1 Pro run measured medians of 2.39 µs for the borrowed 512-byte copy,
100.75 µs for cold root indexing (2344 source bytes/23 requests), 110.96 µs for cold open plus selected grid metadata,
4.22 µs for a raw 512-byte view read, 9.71 µs for converting 128 int32 values, and 43.84 µs for converting the full
1000-value grid. These are one local run, not portable speed guarantees. The raw distribution report SHA-256 is
`4060c3405a28cb5c0a720dcf9cfcae2442e39c69c6a0e885f0e82d9bc84d7b17`; the task retained it as a byte-verified lossless
gzip outside the package.
