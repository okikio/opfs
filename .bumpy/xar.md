---
"@okikio/opfs": minor
---

Preview Apple-profile XAR members with separate TOC, archived-byte and extracted-byte checksum evidence.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openXar } from "@okikio/opfs/archive/xar";

export async function previewXar(bytes: ArrayBuffer, subtle: SubtleCrypto): Promise<Uint8Array> {
  const archive = await openXar(createBlobSource(new Blob([bytes])), { subtle });
  const entry = archive.entries.find((entry) => entry.type === "file" && entry.path === "hello.txt");
  if (!entry) throw new Error("hello.txt is absent");
  const preview = await archive.read(entry.id, { length: Math.min(entry.data?.size ?? 0, 128) });
  console.log(archive.toc, preview.archived, preview.extracted, preview.work);
  return preview.bytes;
}
```

See the [xar guide](../docs/xar.md) for caller-owned resources, finite work and unsupported profiles.
