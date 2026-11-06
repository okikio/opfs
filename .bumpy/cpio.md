---
"@okikio/opfs": minor
---

### Preview CPIO members without extracting the archive

Optional archive/cpio and view/cpio subpaths index SVR4 newc/CRC records, resolve archived regular-file hard links, and
read selected payload extents.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openCpio } from "@okikio/opfs/archive/cpio";

export async function preview(archiveBytes: ArrayBuffer): Promise<void> {
  const archive = await openCpio(createBlobSource(new Blob([archiveBytes])), {
    maxSourceBytes: 4 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxEntries: 10000,
    maxNameBytes: 65536,
    maxMetadataBytes: 1024 * 1024,
  });
  const entry = archive.entries.find((entry) => entry.name === "report.txt");
  if (entry?.kind === "file") {
    const preview = await archive.read(entry.id, {
      length: Math.min(4096, entry.size),
      maxSourceBytes: 16 * 1024 * 1024,
      maxDecodedBytes: 16 * 1024 * 1024,
      maxOutputBytes: 4096,
    });
    console.log(preview.bytes, preview.integrity, preview.dataEntryId, preview.work);
  }
}
```

CRC prefixes verify the entire physical data-owner payload by default; this additive checksum is not authentication.
newc has no payload checksum. Genuine GNU/BSD producer fixtures verify the supported profile; concatenated archives,
compressed input and host extraction remain unsupported.

See [the complete usage and limits guide](docs/cpio.md).
