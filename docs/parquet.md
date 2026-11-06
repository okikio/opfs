# Preview numeric columns in a Parquet file

Open a stable byte source, inspect its flat columns, then read a column by its numeric ID and a zero-based row range.
This first profile returns physical numeric values and a separate null mask. It does not start a SQL engine or interpret
dates, decimals, strings, nested records, or encrypted columns.

```ts
import { openParquet } from "@okikio/opfs/dataset/parquet";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(file: Blob): Promise<void> {
  const dataset = await openParquet(createBlobSource(file), {
    maxFooterBytes: 8 * 1024 * 1024,
    maxPageBytes: 8 * 1024 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  console.table(dataset.columns);
  const column = dataset.columns.find((column) => column.readable);
  if (!column) throw new Error("This file has no column supported by this preview profile.");

  const result = await dataset.read(column.id, {
    offset: 0,
    length: Math.min(10, dataset.rows),
  });
  for (let index = 0; index < result.values.length; index++) {
    console.log(result.validity[index] === 1 ? result.values[index] : null);
  }
  console.table(result.pages);
  console.log(result.work);
}
```

`createBlobSource` owns its captured Blob description. The Parquet reader borrows the source and has no connection,
worker, file handle, or disposal operation. Another byte source can supply exact remote ranges, provided its immutable,
provider, or caller stability evidence remains valid. An identity string alone does not establish stable replay.
`allowUnverifiedSource: true` explicitly opts into parsing a source without that evidence; it does not authenticate the
bytes.

Signed `INTEGER(32, true)` on INT32 and `INTEGER(64, true)` on INT64 are accepted because they preserve the physical
meaning. The corresponding legacy INT_32/INT_64 annotations are accepted too; when both forms occur they must agree.
Narrower, unsigned, date, decimal and other logical conversions remain unsupported. Scale or precision fields also
retain that refusal.

## Values and nulls

The supported physical type numbers follow the format's enumeration:

| Physical type | Returned array  | Meaning                                                             |
| ------------- | --------------- | ------------------------------------------------------------------- |
| BOOLEAN (0)   | `Uint8Array`    | One 0 or 1 per requested row; stored bits are unpacked.             |
| INT32 (1)     | `Int32Array`    | Signed integer values.                                              |
| INT64 (2)     | `BigInt64Array` | Exact signed 64-bit values without conversion to JavaScript Number. |
| FLOAT (4)     | `Float32Array`  | IEEE single-precision values.                                       |
| DOUBLE (5)    | `Float64Array`  | IEEE double-precision values.                                       |

`validity` has one byte per selected row: 1 means a stored value and 0 means null. Null value slots are initialized to
zero. Always consult the mask; a null is not a stored zero or an IEEE NaN. NaN, infinities, and signed zero retain value
semantics, but the API does not promise NaN payload bit identity after JavaScript numeric operations. Typed values have
the host's ordinary in-memory byte order; the reader converts the file's little-endian numeric representation
explicitly.

Literal UTF-8 names, including an initial U+FEFF character, are preserved without path projection, normalization, or
case folding. Duplicate flat names refuse opening. Numeric IDs identify columns without treating names as filesystem
paths.

`columns` and `rowGroups` are immutable index descriptors. Row-group offsets are logical row offsets, not byte
positions. Their counts have been checked against the file metadata, while the contents of unread pages remain
unverified.

## Supported framing and checksum scope

The profile accepts one local `PAR1` file with an unencrypted footer and a flat root of REQUIRED or OPTIONAL primitive
fields. It reads UNCOMPRESSED PLAIN data pages in the original page format or DATA_PAGE_V2. Optional fields use the
one-bit RLE/bit-packed definition levels that distinguish null from present. There is no repeated/nested row
reconstruction.

A selected row range can cross pages and row groups. The reader scans all page headers in each intersected row group for
the selected column, checks their declared totals, and reads each overlapping page body completely. It does not decode
unrelated columns. Header lookahead can physically include a bounded prefix of the following body; those bytes and
repeated lookahead are counted as source work even when that body's values are not selected. Small output does not imply
equally small source work.

For a selected page with a stored CRC32, the complete stored body is checked before any result is returned. The result's
page evidence reports:

| Evidence         | Meaning                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `crc32-verified` | The selected page body matches its stored CRC32.                                                    |
| `not-provided`   | The selected page has no stored CRC32.                                                              |
| `not-read`       | Its body was not fully acquired or CRC checked. Header lookahead can still fetch a physical prefix. |

The returned `integrity: "selected-pages"` labels this scope; it does not mean all pages have checksums. Footer
metadata, page headers, statistics and publisher identity are not authenticated by a body CRC. `dataset.integrity` is
therefore `"metadata-unverified"`. This reader does not claim a whole-file checksum or trust statistics for filtering. A
changed unselected page body can remain undetected during a preview of a different page.

## Bounds, cancellation, and failure

Opening byte/request/output limits remain aggregate authority for the dataset's lifetime. Each read also has its own
finite `ArchiveLimitsType` limits. Passing the same external `ledger` at opening and reading counts that owner once;
adding a different read ledger adds authority rather than replacing the opening owner. Reservations include admitted
work that later fails and are not refunded.

Defaults are 8 MiB footer, 64 KiB page-header lookahead, 8 MiB per selected body, 1,024 columns, 4,096 row groups,
65,536 scanned pages per read and 1,048,576 output rows per read. Compact Protocol parsing is bounded by 1,048,576 work
units, depth 32 and 65,536 bytes per string/binary field. The retained-metadata policy defaults to 8 MiB of string and
conservative descriptor/field-ID allowances; it is an admission model, not an exact JavaScript heap measurement.
Repeated lookahead parsing consumes that allowance too. The separately bounded owned footer and selected body copies
remain in addition to these descriptors.

Every default is configurable at opening and documented on `ParquetOpenOptionsType`. These policies are implementation
safety limits, not format maxima. The default byte/request policies are 64 MiB source, 4,096 requests, 64 MiB
decoded/copied work and 16 MiB returned output. Output bytes include both numeric values and validity bytes. Repeated
reads can exhaust the opening allowance even when each individual read is small.

The reader admits known selected body costs and complete output sizes before allocating its output arrays. Bounded
header scanning happens before that admission and can perform source reads even if a later selected-body budget fails.
Source-provided scratch views are copied before later provider reads can reuse them. Decoding loops and skipped unknown
metadata also consume finite work budgets; limiting returned bytes alone would not bound that work.

Opening and per-read signals compose. Cancellation is checked after each foreign ledger reservation, before copies and
I/O, and after awaited reads. An admitted provider read is awaited; the reader cannot forcibly stop a provider that
ignores its signal. Provider failures retain their original identity. The borrowed source is never closed or replaced.
Retry requires sufficient remaining aggregate allowance and a source that still represents the same stable snapshot.

`ArchiveError.code` distinguishes `invalid-archive`, `unsupported-profile`, `budget-exceeded`, and `checksum-mismatch`.
Invalid user ranges use `RangeError`. An unsupported file can still be stored as opaque bytes; this preview profile does
not imply every Parquet reader would reject it.

## Deliberate exclusions and evidence

Flat columns with unsupported physical types, logical annotations, compression or dictionary encodings can appear in the
index with `readable: false` and a reason. Their structural metadata is bounded, but no decoded-value claim is made.
Nested/repeated schemas, external column files and encryption refuse opening in this profile. INT96, binary/string
values, logical type conversion, dictionary/delta/byte-stream encodings, compression codecs, writes, page-index
filtering, bloom filters, SQL, GeoParquet and lakehouse table protocols are separate capabilities.

The implementation grammar is pinned to Apache Parquet format 2.10.0 at `b9c4fa81c3be13dc98760c92b037fa4dd465cef8` and
Thrift 0.22.0 at `af9ac170f4de895266de4b6f9f3e68a58f113760`. The test-only native producer wrote 22 genuine files and
compared all original values and null masks through PyArrow 20.0.0 and DuckDB 1.3.2. Twenty files cover the supported
physical profiles; two genuine dictionary/Snappy controls remain unsupported by this reader. Empty files do not
establish page version or checksum evidence. A required zero page offset is accepted only for a column with zero values,
zero stored and decoded bytes, and no dictionary; this sentinel never authorizes a payload read. Independent native
success establishes those fixture bytes; candidate runtime tests, static compilation, benchmarks and installed-package
checks are separate verification stages. The reproducible recipe and original notice files are in
[the source fixture directory](https://github.com/okikio/opfs/tree/main/tests/fixtures/parquet).

The fixture recipe also documents a separate TypeScript/native C++ workflow. It admits the same Arrow wheel as an inert
archive and substitutes the official DuckDB CLI for the Python binding. All 22 intended profiles retain two-engine
full-value checks. Its separate native qualification passed all 22 profiles with Node 26.13.0, Debian C++ 12.2.0 and
DuckDB CLI 1.3.2 in a network-disabled 1 GiB runner, without OOM or cleanup faults. This qualifies the replacement
producer and its complete-value comparisons; it does not replace the frozen historical fixture or establish candidate
reader acceptance of the newly generated images.

## Measure preview costs

`bench/parquet.bench.ts` compares cold footer indexing, warm selected/full reads, and a cold-open-plus-selected read
over the genuine 4,096-row Arrow and DuckDB fixtures. Every lane checks complete original INT32 values and null masks
before sampling. Selected previews return 100 rows across the row-group boundary. The already-decoded Blob lane returns
only numeric bytes and performs no mask, metadata or checksum work; it is a lower bound, not a competing Parquet reader.

The observed Arrow selected read returned 500 bytes (400 value bytes and 100 mask bytes) after 15,973 source bytes in 65
requests. Its full read returned 20,480 bytes after 25,217 source bytes in 124 requests. The DuckDB selection returned
the same 500 output bytes after 10,888 source bytes in four requests, with no stored page checksum. These are
fixture-specific work counts, not timing comparisons between writers. They show why small previews need separate
request, source, work and output policies: this profile scans headers in intersecting row groups and checks complete
selected bodies, without using optional page indexes.

A single seven-lane run used Node 26.13.0, Mitata 1.0.34 and Linux AArch64 in a one-CPU, 1 GiB offline container.
Unrelated containers were active at the opening resource sample, so its timing distributions are observations under
contention, not isolated latency results or a general speed claim. The post-window resource sample was collected after
releasing the reservation and includes the next workload; it does not establish overlap with the timed run. Raw
distributions, source hashes and lossless compression receipts are retained for the run. Repeated sampling has finite
benchmark-only aggregate allowances; ordinary per-read caps remain unchanged.
