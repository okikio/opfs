# Preview FITS image values

FITS stores astronomical images as numeric arrays, with an 80-character card header and 2880-byte record boundaries. Use
`openFits` to locate primary/image HDUs (header/data units), then select a flat interval of image elements. This does
not mount a disk, extract files, interpret a world-coordinate system, or require an astronomy runtime library.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openFits } from "@okikio/opfs/dataset/fits";

export async function preview(image: Blob) {
  const dataset = await openFits(createBlobSource(image), {
    maxHeaderBytes: 8 * 1024 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxRequests: 4096,
    maxElements: 1024 * 1024,
  });
  const hdu = dataset.hdus.find((item) => item.elements > 0);
  if (!hdu) return undefined;
  const result = await dataset.read(hdu.id, { offset: 0, count: Math.min(16, hdu.elements) });
  // FITS axis 1 changes fastest. A [4, 3] array has 3 rows of 4 values.
  // Mask 1 means the stored value was BLANK (integer) or NaN (floating point).
  return { axes: hdu.axes, unit: hdu.unit, values: result.values, undefinedMask: result.undefinedMask };
}
```

The caller owns the source. The reader captures its size, bound read function, identity and stability before the first
await. It does not close the source or mutate it. A source must declare `stability: "immutable"`, `"provider"` or
`"caller"`; these are source contracts, not cryptographic authentication. `allowUnverifiedSource: true` explicitly
permits a source with no stability evidence. Source identity alone does not prove stability.

## Raw values, scaling and missing data

The default `scale: "raw"` returns the exact stored type. FITS input is always big-endian; the reader decodes it into an
owned typed array in the runtime's native byte order. The returned typed array is numeric data, not a portable byte
serialization. Floating-point reads preserve numeric values; preservation of NaN payload bits is not a serialization
guarantee.

| BITPIX | Raw result      |
| ------ | --------------- |
| 8      | `Uint8Array`    |
| 16     | `Int16Array`    |
| 32     | `Int32Array`    |
| 64     | `BigInt64Array` |
| -32    | `Float32Array`  |
| -64    | `Float64Array`  |

`offset` and `count` count elements, starting at zero. They cross row/plane boundaries in FITS axis order; axis 1 is
contiguous. No axis permutation is performed. `NAXIS=0`, or any zero-sized axis, produces an empty array. The index
keeps each HDU's physical header/data offsets and padded sizes separate from its logical element count.

Explicit `scale: "physical"` returns `Float64Array` values using `stored * BSCALE + BZERO`. Defaults are 1 and 0. This
uses JavaScript IEEE arithmetic, so rounding, overflow, infinities or newly produced NaNs are possible. Integer BITPIX
64 refuses physical scaling even when a particular value might fit: use the raw BigInt values and choose a conversion
policy yourself. The reader does not silently round an integer outside the exact Number range.

`undefinedMask` always describes the source: integer `BLANK` is compared **before scaling**, and floating NaNs set the
mask. It does not mark values that become NaN/Infinity through scaling. Raw NaNs, infinities and signed zero remain
numeric values; no masked value is silently replaced. Physical values at masked positions are still the ordinary
arithmetic result; callers must consult the mask. `BUNIT` is a literal unit label. There is no unit conversion, WCS,
calibration, or assumption that all HDUs share one unit.

## Verification is a separate full-HDU operation

Every selected read reports `integrity: "pending"` if `DATASUM` or `CHECKSUM` is present, even after a prior
verification. `"not-provided"` means neither checksum was declared. Reading a small interval never implies that the rest
of the image was read or checked.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openFits } from "@okikio/opfs/dataset/fits";

export async function verifyFirst(image: Blob) {
  const dataset = await openFits(createBlobSource(image));
  const verification = await dataset.verify(0);
  // Independent scopes: DATASUM covers padded data; CHECKSUM covers padded header + data.
  // Both are accidental-corruption checks, not authentication or publisher identity.
  return verification;
}
```

`verify(id)` rereads the entire padded header and padded data of that HDU in chunks no larger than 64 KiB, including
fill bytes. It implements FITS big-endian 32-bit one's-complement addition. `DATASUM` is a quoted unsigned decimal sum;
`CHECKSUM` requires the full HDU sum to be negative zero (`0xffffffff`). Missing or blank checksum strings report
`"not-provided"`. Mismatches throw `ArchiveError` with code `"checksum-mismatch"`. A successful result applies to that
operation on that source snapshot. It is not cached authority for earlier/later reads or unrelated HDUs.

## Bounds, cancellation and supported headers

The initial profile supports FITS 4.0 primary arrays (`SIMPLE=T`) and ordinary `XTENSION='IMAGE   '` extensions with
`PCOUNT=0`, `GCOUNT=1`, and BITPIX values above. Missing advisory `EXTEND` does not block an IMAGE extension. The parser
checks mandatory ordering, numeric/logical types, printable ASCII, END framing and space-filled header padding. Extent
products and padded offsets use exact BigInt arithmetic before conversion to safe Number offsets. It requires one
complete sequence of HDUs ending at EOF, on a 2880-byte boundary.

Every TABLE/BINTABLE or other extension refuses the complete open. Table sizing and table semantics are not implemented,
so the reader cannot safely skip a table to locate a later image. Random groups, compressed image tables, inherited
headers and interpreted long-string BUNIT/checksum values are unsupported. Unknown optional cards, COMMENT and HISTORY
are retained as inert strings. Retaining cards does not validate every convention or make a general FITS header editor.

Defaults permit 1024 HDUs, 16 axes per HDU (the format permits up to 999), 8 MiB aggregate header bytes and 1,048,576
elements per read. Header storage is bounded by encoded card bytes; JavaScript strings/objects require additional
runtime-dependent memory. Numeric output and one mask byte per element are both charged before allocation. A read keeps
at most one 64 KiB borrowed input extent at a time, in addition to its owned result arrays. It does not materialize an
entire image to obtain a prefix.

The ordinary archive defaults are 64 MiB source, 4096 requests, 64 MiB decoded work and 16 MiB output. Opening policies
also bound the dataset's lifetime. An additional per-read/verify policy and ledger may narrow that operation; it cannot
replace the opening authority. Passing the same external ledger again does not double charge it. Counts reserve known
source bytes/requests before selected output allocation or source I/O; failed reservations are not refunded. Returned
work reports actual requested source bytes and reads, decoded numeric input/header/checksum work, and returned values
plus masks. Borrowed provider buffers, provider caching and native allocator overhead are outside an exact heap claim.

An opening AbortSignal applies to all subsequent operations; an operation signal composes with it. Signals are checked
before work, after each source await, and before returning a result, including an empty read. The caller retains source
ownership on success, failure or abort. Original provider failures propagate; format, budget and checksum failures use
the existing archive error codes.

## Evidence and standards

The implementation follows the
[official FITS 4.0 standard](https://fits.gsfc.nasa.gov/standard40/fits_standard40aa-le.pdf), especially sections 3
(records), 4 (headers), 5 (data), 7 (IMAGE extensions), and 4.4.2.7/Appendix J (checksums).
[Astropy's image documentation](https://docs.astropy.org/en/stable/io/fits/usage/image.html) explains the distinction
between raw arrays and automatic BSCALE/BZERO scaling. The test-only authored native producer/consumer uses the
[CFITSIO image API](https://heasarc.gsfc.nasa.gov/docs/software/fitsio/quick/node9.html).

The frozen independent fixtures come from Astropy and CFITSIO reciprocally: both implementations checked full original
numeric arrays and checksum scopes. Fixtures cover all six BITPIX types, exact 64-bit integers beyond 53 bits,
asymmetric axes, scaling/BLANK, NaN/Inf/signed zero, empty axes, long headers and an unrelated large image. The fixture
directory records actual package versions, producer source hashes and full-byte receipts. Neither tool is a runtime
dependency. The current [TypeScript producer](../tests/fixtures/fits/README.md) retains only the native CFITSIO profile
with authored byte expectations. It does not repeat the historical Astropy checks; the original Python source remains an
inert snapshot.

`bench/fits.bench.ts` compares cold indexing, raw selected/full numeric reads, physical scaling and complete padded-HDU
verification against a preindexed native Blob byte-copy baseline. Every lane first checks the original native fixture
bytes; the byte-copy baseline intentionally has no numeric conversion, mask or checksum. Lane labels record element
counts, offsets, requested bytes, output bytes and request counts. Repeated samples use explicit finite lifetime
allowances. A measurement on one runtime/workload does not establish a general speed advantage.
