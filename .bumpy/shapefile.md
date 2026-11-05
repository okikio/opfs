---
"@okikio/opfs": minor
---

Inspect explicitly supplied 2D Shapefile components and preview selected geometry without loading a GIS runtime.

```ts
import { openShapefile } from "@okikio/opfs/dataset/shapefile";
import type { ShapefileSourcesType } from "@okikio/opfs/dataset/shapefile";

export async function preview(sources: ShapefileSourcesType) {
  const dataset = await openShapefile(sources, { profile: "shp2d-dbf3" });
  const page = dataset.features({ limit: 64, maxScanned: 8192 });
  const first = page.features[0];
  if (!first) return { next: page.cursor };
  return { geometry: await dataset.read(first.id), attributes: await dataset.attributes(first.id) };
}
```

The main file establishes physical feature order. A supplied SHX is cross-checked; a supplied DBF preserves raw fixed
fields and deleted-row alignment. No sibling discovery, CRS conversion, text or numeric decoding, topology repair or
checksum guarantee is inferred. Selected geometry uses owned typed columns and retains opening budgets and signals. The
[guide](../docs/shapefile.md) defines supported shape types, component consistency and independent fixture limits.
