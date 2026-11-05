---
"@okikio/opfs": minor
---

### Inspect cabinet directories and read uncompressed members

The optional archive/cab subpath indexes standalone CAB v1.3 metadata and reads exact NONE folder ranges. A verified
preview can read complete covering blocks shared with neighboring files.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openCab } from "@okikio/opfs/archive/cab";

export async function preview(archiveBytes: ArrayBuffer): Promise<void> {
  const archive = await openCab(createBlobSource(new Blob([archiveBytes])), {
    maxSourceBytes: 4 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxFolders: 256,
    maxEntries: 10000,
    maxBlocks: 10000,
    maxNameBytes: 256,
    maxMetadataBytes: 1024 * 1024,
  });
  const entry = archive.entries.find((entry) => entry.name === "report.txt");
  if (!entry || !archive.folders[entry.folderId]?.readable) return;
  const result = await archive.read(entry.id, {
    length: Math.min(4096, entry.size),
    maxSourceBytes: 65536,
    maxDecodedBytes: 65536,
    maxOutputBytes: 4096,
  });
  console.log(result.bytes, result.integrity, result.blocks, result.work);
}
```

MSZIP/LZX/Quantum payload decoding, cabinet sets and nonzero CFDATA reserved-area payloads remain unsupported.
Independent gcab/cabextract fixtures and accepted mathematical vectors verify the narrow profile; reserved-byte
diagnostics explain its explicit refusal.

See [the complete profile and limits guide](docs/cab.md).
