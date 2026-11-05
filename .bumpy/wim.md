---
"@okikio/opfs": minor
---

Preview ordinary uncompressed WIM images without restoring files or applying Windows metadata.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openWim } from "@okikio/opfs/archive/wim";

async function preview(imageFile: Blob, subtle: SubtleCrypto): Promise<Uint8Array> {
  const archive = await openWim(createBlobSource(imageFile), { subtle });
  const image = await archive.image(1);
  const entry = image.entries.find((entry) => entry.path === "hello.txt");
  if (!entry) throw new Error("hello.txt is absent from image 1");
  return (await image.read(entry.id, { length: Math.min(entry.size, 64) })).bytes;
}
```

Metadata and selected resource SHA-1 verification are separate from whole-image validity. Default verified previews hash
the complete selected resource within a finite policy; explicit pending reads can request just the chosen range.
Compressed, split and solid variants, restoration and extra-stream file interpretation remain unsupported. See the
[WIM guide](../docs/wim.md) for nested sources, cumulative budgets, parent cancellation and independent native fixtures.
