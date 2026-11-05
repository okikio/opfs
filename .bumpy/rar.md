---
"@okikio/opfs": minor
---

Preview original RAR5 headers and STORED file ranges without extracting an archive.

```ts
import { openRar } from "@okikio/opfs/archive/rar";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(blob: Blob): Promise<Uint8Array | undefined> {
  const archive = await openRar(createBlobSource(blob));
  const entry = archive.entries.find((entry) => entry.readable);
  return entry ? (await archive.read(entry.id, { length: Math.min(64, entry.size) })).bytes : undefined;
}
```

Original physical headers own the index; quick-open caches are ignored. Default CRC-present reads scan the complete
member before returning a selected interval. Explicit `verify: false` reads only that interval and leaves CRC pending; a
missing CRC is reported as not provided. The [guide](../docs/rar.md) explains finite budgets and unsupported compressed,
encrypted, solid and volume profiles. Genuine vendor-produced archives match complete native 7-Zip/libarchive outputs;
the vendor tool is a one-time test producer, not a runtime dependency or continuing CI requirement.
