---
"@okikio/opfs": minor
---

Preview selected contiguous numeric datasets in an explicit classic HDF5 profile.

```ts
import { openHdf5 } from "@okikio/opfs/dataset/hdf5";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType, name: string) {
  const file = await openHdf5(source, { profile: "classic-contiguous" });
  const dataset = await file.dataset(name);
  return await dataset.read({ offset: 0, count: Math.min(256, dataset.elements) });
}
```

The selected legacy root tree exposes literal direct links and allocated contiguous standard integer/IEEE datasets.
Typed results preserve integer64 values as BigInt and keep stored values separate from physical interpretation. Selected
reads avoid other dataset payloads; metadata, dimensions, allocations, cumulative budgets and ancestor cancellation
remain bounded. This layout provides no checksum or authentication. Genuine h5py/HDF5 files and h5dump compare complete
original bytes, while unsupported layouts remain retained refusal examples. Both native tools use HDF5 and do not
constitute two independent HDF implementations. Chunked/filtered data, arbitrary types, recursive traversal, writes and
netCDF-4 interpretation remain unsupported. The [guide](../docs/hdf5.md) describes the exact profile and limits.
