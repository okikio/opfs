---
"@okikio/opfs": minor
---

Preview physical numeric ORC columns without a query engine.

```ts
import { openOrc } from "@okikio/opfs/dataset/orc";
import { createByteSource } from "@okikio/opfs/source";

export async function preview(bytes: ArrayBuffer) {
  const dataset = await openOrc(createByteSource(new Uint8Array(bytes)), {
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
    maxFooterBytes: 1024 * 1024,
    maxSelectedStreamBytes: 8 * 1024 * 1024,
    maxRows: 100,
  });
  const column = dataset.columns.find((column) => column.supported);
  if (!column) throw new Error("No physical numeric column is available.");
  const result = await dataset.read(column.id, {
    offset: 0,
    length: Math.min(100, dataset.rows),
  });
  return {
    name: column.name,
    values: result.values,
    validity: result.validity,
    stripes: result.stripes,
    work: result.work,
  };
}
```

This flat STRUCT profile reads uncompressed ORC 0.11/0.12 BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT and DOUBLE columns with
separate validity bytes. Selected stripes must use DIRECT encoding; integer RLEv2, nesting, generic compression,
encryption and logical conversions remain unsupported. A small row selection still decodes complete covering column
streams. The reader borrows a stable source and reports integrity as none because this profile supplies no checksum or
authentication guarantee.

See the [guide](../docs/orc.md) for supported profiles, costs, ownership and verification limits.
