---
"@okikio/opfs": minor
---

Preview selected Arrow IPC columns through an indexed source or a forward stream.

The optional `@okikio/opfs/dataset/arrow` entry reads uncompressed V5 little-endian files and modern IPC streams with
six flat physical types: int32, int64, float64, boolean, UTF8 and binary. A record batch contains equally sized columns.
Indexed access can reach the final batch without reading earlier batch bodies. A forward stream consumes earlier
messages in order and yields one bounded batch on demand. Neither operation creates a filesystem or row objects.

This complete function accepts a caller-supplied Blob, selects the first physical column from the final batch and
returns its owned values and separate null mask. Inspect `dataset.columns` before choosing ordinals for another schema.

```ts
import { openArrow } from "@okikio/opfs/dataset/arrow";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(file: Blob) {
  const dataset = await openArrow(createBlobSource(file), {
    maxSourceBytes: 8 * 1024 * 1024,
    maxRequests: 64,
    maxBufferBytes: 2 * 1024 * 1024,
    maxOutputBytes: 8 * 1024 * 1024,
    maxRows: 100_000,
  });
  if (dataset.batches.length === 0) return undefined;
  const result = await dataset.read(dataset.batches.length - 1, [0]);
  console.log(result.work, result.scope, result.integrity);
  return result.columns[0];
}
```

A validity byte of one means present; zero means null, even when a value slot contains zero or empty bytes. Int64 stays
exact in `BigInt64Array`. Float64 preserves signed zero and NaN value semantics. Binary columns use a contiguous payload
and offsets rather than an object per row. Returned values own their storage.

Opening validates the footer geometry and matching embedded/footer schemas. Reading admits the selected batch's metadata
and validates only selected payloads. Unselected messages, gaps and payloads are not whole-file verification. The result
always reports `integrity: "none"`: this IPC profile supplies no content checksum or authentication. Rendering 20 rows
still decodes each selected column's complete batch, under finite source, request, buffer, row and output limits. Text
output uses a conservative storage allowance, not an exact heap measurement.

`openArrow` borrows its stable source and never closes it. `readArrow` acquires its stream reader on first demand and
cancels the underlying stream on abort, failure or early return, then awaits cleanup and releases the lock. The stream
accepts explicit EOS followed by EOF or clean message-boundary EOF; partial frames and trailing bytes fail. It does not
create durable resume checkpoints. Dictionary, nested, compressed, legacy, big-endian and other physical types remain
explicitly unsupported.

See the [Arrow guide](../docs/arrow.md) for complete file and stream examples, read-cost diagrams, validation scopes,
ownership and recovery. Native evidence uses a pinned Arrow C++ writer/reader against authored original values; that
does not imply two-engine interoperability or support for the full Arrow format.
