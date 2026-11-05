---
"@okikio/opfs": minor
---

Preview flat numeric Parquet columns without starting a SQL engine.

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

The optional reader indexes stable range sources and returns typed physical values with a separate null mask. It
supports REQUIRED/OPTIONAL BOOLEAN, INT32, INT64, FLOAT and DOUBLE columns using PLAIN, uncompressed v1/v2 pages,
including signed identity INT32/INT64 annotations. A selection reads and checks stored CRC32 values for the complete
covering page bodies when present. Metadata remains unverified; unrelated pages are not checked, and header lookahead
can fetch a bounded body prefix. Small output therefore does not guarantee small source work.

The source remains caller-owned. Opening budgets and cancellation remain authoritative for later reads. Dictionary
encoding, compression, nested records, encryption, logical conversions, SQL and writes remain separate capabilities.
Pinned PyArrow and DuckDB fixtures retain complete original values and masks, including explicit unsupported dictionary
and Snappy files. The [guide](../docs/parquet.md) explains range costs, nulls, checksum scope and refusal behavior.
