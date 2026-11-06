# Preview netCDF classic variables

`openNetcdf` indexes a stable CDF-1 or CDF-2 dataset and reads selected numeric values without loading every variable.
The header describes named dimensions, attributes and typed variables. Fixed-size variables occupy contiguous extents;
variables using the unlimited dimension occupy interleaved record slabs. The reader maps selected elements to those
physical extents and returns owned typed arrays.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openNetcdf } from "@okikio/opfs/dataset/netcdf";

export async function preview(file: Blob) {
  const dataset = await openNetcdf(createBlobSource(file), {
    maxHeaderBytes: 8 * 1024 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxRequests: 4096,
    maxElements: 1024 * 1024,
  });
  const variable = dataset.variables.find((item) => item.elements > 0 && item.type !== "char");
  if (!variable) return undefined;
  const result = await dataset.read(variable.id, {
    offset: 0,
    count: Math.min(16, variable.elements),
    scale: "raw",
    missing: "attributes",
  });
  return { name: variable.name, shape: variable.shape, values: result.values, undefinedMask: result.undefinedMask };
}
```

`offset` and `count` are flat zero-based element positions. The last axis changes fastest: a `[time, row, column]` array
stores adjacent columns, followed by rows, then records. Scalars have one element. Zero records produce an empty record
variable. An interval crossing record boundaries reads only that variable's selected slabs, never another variable's
data between them. Opening the index may read ahead by up to 4095 bytes beyond the parsed header; those bytes are
charged to physical source work. There is no full-variable prefetch.

## Numeric values and conventions

CDF-1 and CDF-2 use the same six storage types. CDF-2 extends file offsets; it does not introduce 64-bit integer values.
All multibyte input values are big-endian. The result uses native typed-array byte order after explicit numeric
decoding.

| External type | Raw result                                    |
| ------------- | --------------------------------------------- |
| BYTE          | `Int8Array`                                   |
| CHAR          | `Uint8Array` of uninterpreted character bytes |
| SHORT         | `Int16Array`                                  |
| INT           | `Int32Array`                                  |
| FLOAT         | `Float32Array`                                |
| DOUBLE        | `Float64Array`                                |

Raw reads preserve signed integer and floating numeric values, including signed zero and infinities. Floating NaN
payload-bit preservation is not a serialization guarantee. CHAR data has no assumed UTF-8 encoding; `_Encoding`, units
and other character attributes remain raw byte values. Names, unlike character data, must be valid NFC-normalized UTF-8.
Attribute values are frozen number arrays; CHAR attributes contain unsigned bytes. Public metadata cannot be mutated to
change later interpretation.

Explicit `scale: "physical"` returns `Float64Array` using `stored * scale_factor + add_offset`, with defaults 1 and 0.
These attributes must be finite numeric scalars when physical interpretation is requested. CHAR refuses physical
scaling. True or otherwise uninterpretable `_Unsigned` refuses physical scaling; raw BYTE remains signed. The reader
does not claim full CF conventions, coordinate decoding, calendars, unit conversion or unsigned reinterpretation.

`undefinedMask` is one byte per selected element. A value of 1 means the chosen policy marked the **packed source**
value, before scaling:

| `missing` policy         | Marked values                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `"none"`                 | None; mask is zero, including for NaNs                                                |
| `"attributes"` (default) | Source NaN, scalar `_FillValue`, vector/scalar `missing_value`                        |
| `"fill"`                 | The preceding policy plus the storage type's default fill when `_FillValue` is absent |

CHAR always has a zero mask. Explicit fill/missing attributes must have the variable's stored type; `_FillValue` must
contain exactly one value. A malformed convention refuses the interpretation that needs it, while opaque indexing still
succeeds. The reader leaves masked numeric positions unchanged; physical values there are still ordinary arithmetic
results. IEEE overflow, infinities or NaNs introduced by scaling do not add mask bits. `valid_range`, `valid_min` and
`valid_max` are retained but not applied. No inferred validity interval is constructed.

Default fill values do not prove that storage was never written. A writer may use NOFILL, or store the same number as a
legitimate observation; that choice cannot be reconstructed from classic file bytes. Default fill masking therefore
requires explicit `missing: "fill"`. This also avoids silently masking the default BYTE fill in ordinary signed data.

## Record layout and producer compatibility

Each variable exposes its declared `vsize`, first data `offset`, dimension IDs, shape and logical element count. The
dataset exposes `recordStride`, the distance between consecutive records. With several record variables, one record
contains their padded slabs in header order. With exactly one BYTE/CHAR/SHORT record variable, the physical stride is
the **unpadded** slab length, although the specification still requires a padded `vsize` declaration.

SciPy 1.10.1 independently produced a deviation: a sole 3-element BYTE/CHAR variable declares `vsize=3` rather than 4; a
sole 3-element SHORT declares 6 rather than 8; zero-record versions declare 0. netCDF-C 4.9.0 accepted these files and
read complete original values. The default `recordVsize: "validate"` refuses the mismatched declarations. To inspect
these specific files, opt in explicitly:

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openNetcdf } from "@okikio/opfs/dataset/netcdf";

export async function inspectScipy(file: Blob) {
  const dataset = await openNetcdf(createBlobSource(file), { recordVsize: "allow-unpadded" });
  // Each item records id, declaredVsize and expectedVsize. Nothing is silently rewritten.
  return { variables: dataset.variables, deviations: dataset.deviations, recordStride: dataset.recordStride };
}
```

Compatibility applies only to a sole BYTE/CHAR/SHORT record variable with an unpadded declaration, or its zero-record
declaration of 0. All dimension, offset, source-bound and interleaving checks remain. Other size mismatches refuse the
open. Native netCDF-C fixtures exercise the ordinary padded declarations separately from SciPy compatibility fixtures.

## Bounds, ownership and unsupported profiles

Opening captures the source descriptor and options before its first await. The source remains borrowed, and no host
file, mount, network connection or disposable resource is acquired. Stability must be `"immutable"`, `"provider"` or
`"caller"`; `allowUnverifiedSource: true` explicitly permits missing evidence. Identity alone is not authentication.

All products, offsets and record extents are checked with BigInt before conversion to safe Number indexing. CDF-1 and
CDF-2 offsets are nonnegative signed 32/64-bit fields. The parser validates list tags, null header padding, dimension
references, unique names, bounded ranks, a single unlimited dimension and its first-axis use. Fixed data and the record
section cannot overlap the header or each other. Header/alignment gaps and unreferenced trailing bytes are permitted;
the reader does not assign them meaning. Data fill bytes are not validated.

Defaults bound the parsed header to 8 MiB, dimensions and variables to 4096 each, aggregate attributes to 16384,
aggregate attribute scalar values to 1,048,576, rank to 32, selected elements to 1,048,576 and selected source segments
to 4096. Interpreted missing-value sentinels have a separate limit of 4096 (`maxMissingValues`) and use an
operation-owned Set, avoiding a full sentinel scan for every value. Eight decoded-work bytes per sentinel are admitted
before allocating that Set; its actual runtime memory overhead is implementation-dependent. Frozen numeric attribute
arrays likewise charge eight decoded-work bytes per element in addition to encoded header parsing. Names, object
overhead and typed array allocator overhead do not have an exact heap guarantee.

Each data segment is at most 64 KiB. A selection keeps its bounded segment plan, one borrowed input extent, an owned
typed result, one mask byte per element and its sentinel Set. Source/request costs and output are admitted before result
allocation and selected I/O. Physical source bytes exclude other interleaved variables and padding. The ordinary archive
defaults are 64 MiB source, 4096 requests, 64 MiB decoded work and 16 MiB output. Opening limits and its external ledger
remain lifetime authorities. Additional per-read limits/ledgers cannot replace them, and passing the same external
ledger again does not double charge it. Failed reservations are not refunded.

Opening cancellation applies to all reads; an operation signal composes with it. Signals are checked before work, after
source awaits and before returning values, including empty reads. Provider errors propagate unchanged. Other failures
use the existing archive error codes. There are no built-in classic checksums: every result reports
`integrity: "not-provided"`. Parsing metadata or reading a value is not a corruption/authentication check.

CDF-5, HDF5/netCDF-4, streaming record counts (`0xffffffff`), overflow `vsize=0xffffffff` large-variable exceptions and
signed metadata counts above `0x7fffffff` are unsupported. Finite record counts use the unsigned stored count, excluding
the streaming marker. A high safe CDF-2 offset can be inspected through a bounded source, but initial high-offset tests
use an explicitly authored segmented source, not a claim of native large-file producer interoperability.

## Evidence and maintenance

The parser follows Unidata's
[classic format grammar at netCDF-C v4.9.3](https://github.com/Unidata/netcdf-c/blob/3a6b1debf1557f07b606ce3653e44f0d711203be/docs/file_format_specifications.md)
and its separate
[attribute conventions](https://github.com/Unidata/netcdf-c/blob/3a6b1debf1557f07b606ce3653e44f0d711203be/docs/attribute_conventions.md).
These are documentation references, not copied decoder code. The distinction between native raw data and application
masking/scaling is also visible in
[SciPy's API](https://docs.scipy.org/doc/scipy/reference/generated/scipy.io.netcdf_file.html).

The frozen fixtures used test-only authored C and Python producers with signed Debian netCDF-C and SciPy. They
reciprocally compared every original raw numeric byte and independently read two-record subsets with `nc_get_vara`.
Fixtures cover CDF-1/CDF-2, all six types, scalars, asymmetric arrays, multiple record variables, sole odd-sized slabs,
empty records and packed missing/scaling attributes. The fixture directory records exact source/archive/payload hashes,
tool versions and compatibility evidence. No producer SDK is a runtime dependency. Tests also cover unsafe extents,
malformed fields, budget admission, source capture and cancellation. The current
[TypeScript producer](../tests/fixtures/netcdf/README.md) retains the netCDF-C profiles with authored full-byte and
subset expectations. It does not repeat the historical SciPy writer or reciprocal checks; their source remains an inert
snapshot.

`bench/netcdf.bench.ts` uses a native 30,000-record fixture to compare cold indexing, small single/cross-record
selections, a full variable read and packed physical conversion. Its preindexed Blob baseline copies one slab without
numeric conversion or masking. Complete native originals are checked before timing. Labels include byte/request/output
counts and runtime receipts retain sampling distributions. Full record-heavy reads explicitly raise the finite segment
and request allowances; the normal 4096-segment policy can refuse such a full read while still permitting a small
preview. One runtime/workload measurement does not establish a general speed advantage.
