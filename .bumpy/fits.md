---
"@okikio/opfs": minor
---

Preview selected FITS image values without reading or materializing every image pixel.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openFits } from "@okikio/opfs/dataset/fits";

export async function firstPixels(image: Blob) {
  const dataset = await openFits(createBlobSource(image));
  const hdu = dataset.hdus.find((item) => item.elements > 0);
  if (!hdu) return undefined;
  return await dataset.read(hdu.id, { offset: 0, count: Math.min(16, hdu.elements) });
}
```

Raw values retain the stored numeric type, including exact BigInt64 values. The source undefined mask is separate from
optional physical scaling. A selected read does not check the rest of its image: explicit `verify(id)` streams that
HDU's complete padded bytes for separate DATASUM/CHECKSUM evidence. Checksums do not authenticate a publisher. The
[guide](../docs/fits.md) explains element order, bounds and retained parent cancellation. FITS TABLE extensions and
compressed images refuse opening rather than inventing image offsets. Independent Astropy/CFITSIO producers and
reciprocal consumers compare complete original arrays and selected ranges; benchmark lanes expose the cost of full-HDU
verification separately from selected values.
