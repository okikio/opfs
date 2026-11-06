---
"@okikio/opfs": minor
---

Preview uncompressed classic GeoTIFF windows through an optional dataset reader.

```ts
import { openGeotiff } from "@okikio/opfs/dataset/geotiff";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType) {
  const raster = await openGeotiff(source, { profile: "classic-geotiff-raw" });
  const image = raster.images[0];
  if (!image) throw new Error("No raster image was admitted.");
  const rectangle = { x: 0, y: 0, width: Math.min(64, image.width), height: Math.min(64, image.height) };
  const planned = raster.plan(image.id, rectangle);
  return { planned, pixels: await raster.read(image.id, rectangle), declarations: image.geo };
}
```

The reader borrows one stable source and plans exact row-span work before reading selected owned numeric samples.
Uncompressed strips and padded tiles support both byte orders and selected integer/float profiles. Raw block sources
preserve physical bits; logical windows exclude tile padding and do not promise NaN payload bits. Geospatial tags remain
unresolved declarations, with no reprojection, color conversion, COG certification or checksum claim. Native GDAL and
tifffile fixtures check complete original samples and physical blocks; GDAL and libtiff share a backend. The
[guide](../docs/geotiff.md) explains admission, retained budgets, cancellation and unsupported layouts.
