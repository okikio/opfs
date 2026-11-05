---
"@okikio/opfs": minor
---

Preview unencrypted EOS-required LZMA members directly or through the read-only ZIP filesystem.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";
import { createZipAdapter } from "@okikio/opfs/view/zip";

export async function preview(file: Blob, path: string) {
  const archive = await openZip(createBlobSource(file));
  const files = createFileSystem(createZipAdapter(archive, {
    maxOutputBytes: 1024,
    verify: false,
    lzma: { maxDictionaryBytes: 8 * 1024 ** 2, maxSteps: 128 * 1024 ** 2 },
    bzip: { maxMemoryBytes: 8 * 1024 ** 2 },
  }));
  try {
    return await files.readFile(path, { length: 1024 });
  } finally {
    await files.close();
  }
}
```

ZIP method 14 uses the existing project-owned raw LZMA1 kernel with explicit property framing and an EOS requirement.
Codec termination provides structural evidence, while complete-member CRC remains a separate check. A prefix can require
replay from the start. The view captures its BZip2/LZMA policies at construction and keeps the archive borrowed; its
default remains full-member verification unless `verify: false` explicitly selects pending-check previews. Native Python
and 7-Zip fixtures compare all original bytes; libarchive successes and its precise empty-LZMA refusals are recorded
separately. Encryption and no-EOS method-14 variants remain unsupported. The [guide](../docs/zip-lzma.md) explains
costs, cancellation, checksum scope and native limitations.
