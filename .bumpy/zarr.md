---
"@okikio/opfs": minor
---

Preview selected uncompressed Zarr v2 numeric arrays through an explicit snapshot store.

```ts
import { openZarr } from "@okikio/opfs/dataset/zarr";
import type { ZarrStoreType } from "@okikio/opfs/dataset/zarr";

export async function firstValues(store: ZarrStoreType) {
  const array = await openZarr(store);
  return await array.read({ count: Math.min(16, array.elements) });
}
```

The store owns namespace stability, including absent keys, and lends byte sources. Reads retain opening budgets and
cancellation, select chunk extents, normalize C/F storage to logical C order and preserve exact 64-bit integers. A
separate object ledger counts lookups even when a chunk is absent. The fill mask identifies synthesized absent-chunk
values, not semantic missing data. Independent NumPy/Zarr fixtures cover complete arrays and reciprocal authored chunks.
There is no checksum claim; compressors, filters, groups, v3 and structured/string types remain unsupported. See the
[guide](../docs/zarr.md) for a complete store example and ownership requirements.
