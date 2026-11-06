---
"@okikio/opfs": minor
---

Preview bounded ISO9660 primary and Joliet trees without mounts, with explicit parent-record compatibility.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openIso } from "@okikio/opfs/archive/iso";

export async function preview(image: ArrayBuffer): Promise<Uint8Array | undefined> {
  const archive = await openIso(createBlobSource(new Blob([image])), {
    namespace: "joliet",
    maxEntries: 10000,
    maxDirectoryBytes: 1024 * 1024,
    maxSourceBytes: 2 * 1024 * 1024,
    maxRequests: 1024,
  });
  const file = archive.entries.find((entry) => entry.kind === "file" && entry.size > 0);
  if (!file) return undefined;
  const result = await archive.read(file.id, {
    offset: 0,
    length: Math.min(file.size, 4096),
    maxSourceBytes: 4096,
    maxDecodedBytes: 4096,
    maxOutputBytes: 4096,
    maxRequests: 1,
  });
  return result.bytes;
}
```

See the [iso guide](../docs/iso.md) for caller-owned resources, finite work and unsupported profiles.
