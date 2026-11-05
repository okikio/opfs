---
"@okikio/opfs": minor
---

Read selected guest bytes from standalone uncompressed QCOW2 images without mounting a filesystem.

```ts
import { openQcow2 } from "@okikio/opfs/image/qcow2";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType) {
  const image = await openQcow2(source);
  const length = Math.min(512, image.size);
  return { mapping: image.map(0, length), result: await image.read({ offset: 0, length }) };
}
```

Versions 2 and 3 use bounded active mapping indexes, distinguish holes from explicit zeros and preserve borrowed-source
budgets through nested guest sources. Selected logical bytes require no full virtual-disk allocation. Native QEMU
fixtures compare every original raw byte, including images whose serialized L1 table ends before final cluster padding.
Backing chains, compression, encryption, snapshots and guest filesystem interpretation remain unsupported. Mapping
bounds do not verify reference-count values or authenticate payloads. The [guide](../docs/qcow2.md) explains exact
physical costs, cancellation, source identities and the conservative profile.
