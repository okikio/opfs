---
"@okikio/opfs": minor
---

### Browse selected TAR files through a read-only filesystem

The optional view/tar subpath exposes indexed regular members after strict namespace validation. ZIP and CPIO use the
same private path admission without converting their integrity contracts.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createBlobSource } from "@okikio/opfs/source";
import { openTar } from "@okikio/opfs/archive/tar";
import { createTarAdapter } from "@okikio/opfs/view/tar";

export async function preview(file: Blob): Promise<Uint8Array> {
  const archive = await openTar(createBlobSource(file), { maxEntries: 10_000 });
  const fs = createFileSystem(createTarAdapter(archive, {
    maxSourceBytes: 4096,
    maxDecodedBytes: 4096,
    maxOutputBytes: 4096,
  }));
  try {
    return await fs.readFile("/notes/hello.txt", { at: 0, length: 4096 });
  } finally {
    await fs[Symbol.asyncDispose]();
  }
}
```

Links, duplicate paths, traversal and file/directory collisions reject before payload reads. Only requested TAR payload
extents are fetched; header checksums never verify payload content. Closing a view leaves its source borrowed and
usable.

See [the complete usage and limits guide](docs/tar.md).
