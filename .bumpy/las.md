---
"@okikio/opfs": minor
---

Preview selected LAS 1.2 point columns without loading the whole cloud.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openLas } from "@okikio/opfs/dataset/las";

export async function points(file: Blob) {
  const cloud = await openLas(createBlobSource(file));
  return await cloud.read({ count: Math.min(16, cloud.points), scale: "physical" });
}
```

Uncompressed point formats 0–3 retain raw coordinate and flag columns, optional GPS/RGB and explicitly scaled
coordinates. Selected record ranges retain opening budgets and cancellation; native laspy and an independent record
writer verify complete columns and raw extents. Header bounds remain unverified declarations. VLR payloads and record
suffixes stay opaque, with selected VLR reads rather than implied CRS or ExtraBytes interpretation. There is no
checksum, LAZ, COPC, other LAS version or writing claim. The [guide](../docs/las.md) explains units, source ownership
and physical overflow.
