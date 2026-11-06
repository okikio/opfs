# Preview uncompressed Zarr v2 arrays

`openZarr` reads `.zarray` metadata from a snapshot of a key/value store, then reads only the chunk ranges needed for
selected numeric elements. A store is several objects, rather than a fabricated single archive. This example owns a
private map of immutable Blobs; callers can adapt another store when they can provide the same cross-key snapshot.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZarr } from "@okikio/opfs/dataset/zarr";

export async function preview(files: ReadonlyMap<string, Blob>, path = "") {
  const snapshot = new Map(files);
  const array = await openZarr({
    stability: "immutable",
    async open(key, options) {
      options?.signal?.throwIfAborted();
      const blob = snapshot.get(key);
      return blob === undefined ? undefined : createBlobSource(blob);
    },
  }, {
    path,
    maxMetadataBytes: 1024 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxObjects: 4096,
    maxElements: 1024 * 1024,
  });
  const result = await array.read({ offset: 0, count: Math.min(16, array.elements) });
  return {
    shape: array.shape,
    dtype: array.dtype,
    values: result.values,
    fillMask: result.fillMask,
    work: result.work,
  };
}
```

The store and every returned byte source are borrowed. The reader does not close, mutate or cache them. `immutable`
means that both object contents **and key presence/absence** remain fixed across the array's lifetime. `caller` means
the caller guarantees that same snapshot for the operations they start. Independent object ETags do not establish this
guarantee: a reader could otherwise combine old metadata, new chunks and a missing key from different revisions. Use an
immutable published dataset version, a store transaction, or an application-owned snapshot. A mutable live bucket with
per-object conditional requests alone does not qualify. Source identities are evidence, not authentication.

## Numeric selection and absent chunks

`offset` and `count` select flat zero-based elements in **C logical order**, with the last axis changing fastest. Stored
`order: "F"` changes physical offsets; it does not change result order. Every chunk, including an edge chunk, must
contain the full declared chunk shape. Unused edge values are not returned. A scalar has one element and key `0`; an
array with a zero-sized axis has no elements. Multibyte values are decoded using the dtype's explicit endianness.

| v2 dtype                           | Result                                           |
| ---------------------------------- | ------------------------------------------------ |
| `b1`                               | `Uint8Array`, normalized to 0 or 1               |
| `i1`, `u1`, `i2`, `u2`, `i4`, `u4` | Corresponding signed/unsigned native typed array |
| `i8`, `u8`                         | `BigInt64Array`, `BigUint64Array`                |
| `f4`, `f8`                         | `Float32Array`, `Float64Array`                   |

The dtype includes `<`, `>` or `|`; `|` is accepted only for one-byte types. Boolean stored bytes use nonzero truth,
matching the independently tested NumPy/Zarr behavior for bytes 2 and 255. Results normalize these bytes rather than
preserving their representation. Floating signed zero and infinities remain numeric values; NaN payload bits are not a
serialization guarantee. No scale, coordinate, unit or application-specific missing-value convention is inferred.

An absent chunk synthesizes `fill_value`. `fillMask` is one byte per selected element: 1 means synthesized from an
absent chunk, while 0 means physically read. A stored value equal to the fill value remains 0. A synthesized NaN gets 1;
a stored NaN gets 0. The mask therefore describes storage absence, rather than scientific validity. With null
`fill_value`, missing chunks have undefined contents under v2; the reader refuses that selection instead of inventing
numbers. Existing chunks and empty selections still work. Numeric float fill and the strings `NaN`, `Infinity` and
`-Infinity` are supported. Integer fills require an exact safe JSON integer lexeme in dtype range: raw 64-bit integer
chunk values are supported, but unsafe JSON 64-bit fills are refused before `JSON.parse` can round their authority.

## Costs, admission and cancellation

Opening reads the complete `.zarray`, in requests of at most 64 KiB. Reads first build a bounded selection plan, open
only its unique chunk keys, validate full chunk sizes, and reserve known physical requests/source bytes before output
allocation or chunk reads. A missing key still consumes a lookup. Only selected contiguous ranges are acquired; no
full-chunk decompression or prefetch occurs. Each selected value reserves its dtype width as decoded work, including
synthesized fill. Output reserves the typed values plus one byte per mask element. Store lookup overhead and provider
prefetch/copies are outside archive-level byte metrics; the adapter must bound its own physical transport.

| Policy                              | Default     | Effect                                                               |
| ----------------------------------- | ----------- | -------------------------------------------------------------------- |
| `maxMetadataBytes`                  | 1 MiB       | Complete UTF-8 `.zarray` admission                                   |
| `maxRank`                           | 32          | Axes per shape/chunk tuple                                           |
| `maxChunkBytes`                     | 64 MiB      | Declared full raw chunk size, even for a one-element preview         |
| `maxElements`                       | 1,048,576   | Selected values per read                                             |
| `maxChunks`                         | 4096        | Unique selected keys, including absent chunks                        |
| `maxSegments`                       | 4096        | Retained physical contiguous selection segments, at most 64 KiB each |
| `maxPlanSteps`                      | 16,777,216  | Selected element count multiplied by rank                            |
| `maxObjects`                        | 4096        | Object lookups, including metadata and missing keys                  |
| `maxSourceBytes`, `maxDecodedBytes` | 64 MiB each | Requested physical bytes and selected numeric work                   |
| `maxRequests`                       | 4096        | Exact-range byte-source requests; separate from lookups              |
| `maxOutputBytes`                    | 16 MiB      | Returned typed bytes plus fill mask                                  |

Opening limits remain cumulative lifetime authorities. A read also has fresh per-operation byte/lookup limits; raising
them does not raise the opening authority. `createArchiveLedger` and `createZarrObjectLedger` allow explicit aggregate
owners across readers. Opening owners remain active on all reads; additional read owners compose with them. Passing the
same owner again does not charge it twice. Reservations are not refunded after later errors. `work` reports one
operation's actual admitted work, not elapsed time, exact heap usage, network authentication or checksum verification.
Retained planning strings/objects, JSON objects and typed-array headers add memory beyond payload byte accounting.
Planning is synchronous and bounded by count/rank/segments; these limits are not hard wall-clock deadlines.

Opening options, store method/stability and each acquired source descriptor are captured. Read options are captured at
invocation. Opening and read abort signals compose: either can refuse the operation, including empty selections.
Provider methods receive the combined signal, but a provider that ignores cancellation must settle before the reader
returns. Original provider failures propagate. There are no background jobs or owned provider resources to retire.

## Profile and interoperability evidence

This profile accepts Zarr **v2** numeric arrays with `compressor: null`, no filters (`null` or empty array), C/F order,
and `.` or `/` chunk separators. It does not traverse groups, read consolidated metadata, interpret attributes,
implement codecs, structured/string/complex/object dtypes, v3 metadata/codecs/sharding, or write arrays. No checksums
are present in this profile: every result states `integrity: "not-provided"`.

Paths follow the v2 ASCII logical-path normalization; dot and dot-dot segments are refused. They are store keys, never
host filesystem paths. Duplicate JSON keys, prototype-related keys, malformed UTF-8, deep/token-heavy metadata and
noncanonical/unsafe dimension integer lexemes refuse. Unknown extra metadata is ignored after bounded lexical
validation. These deliberate limits do not claim to reject every format that another v2 reader can interpret.

The
[pinned v2 specification](https://github.com/zarr-developers/zarr-specs/blob/ad8fc8df42441c84039c94569980e485e4c09870/docs/v2/v2.0.rst)
defines the profile. The separately reviewed
[v3 core specification](https://github.com/zarr-developers/zarr-specs/blob/ad8fc8df42441c84039c94569980e485e4c09870/docs/v3/core/index.rst)
is excluded. Fixtures contain 82 Zarr 2.13.6/NumPy 1.24.2 cases: native and independently authored raw chunk writers are
reciprocally consumed by Python Zarr and compared to full original NumPy arrays. Cases cover 19 dtypes, both
orders/endiannesses, edge chunks, scalar/empty arrays, absent chunks, noncanonical booleans and a larger chunked image.
Authored adversarial tests separately exercise refusal, budgets and ownership. Fixture receipts retain each object, full
original payload and producer/source hashes; no Python library is a production dependency. Benchmarks compare this
fixture's selected numeric work against a preindexed native byte-copy baseline, with full-byte preflight and explicit
work units. A single run establishes no universal performance advantage.
