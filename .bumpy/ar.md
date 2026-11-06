---
"@okikio/opfs": minor
---

Preview normal GNU and BSD ar members without extracting packages

The normal physical archive reader validates GNU tables and BSD inline names, then returns exact selected payload
extents. Member sources compose with compressed TAR preview without materializing a whole package; thin external
references are refused.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openAr } from "@okikio/opfs/archive/ar";

export async function preview(archiveBytes: ArrayBuffer): Promise<Uint8Array | undefined> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 4 * 1024 * 1024,
    maxRequests: 512,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxOutputBytes: 4096,
  });
  const archive = await openAr(createBlobSource(new Blob([archiveBytes])), { ledger });
  console.table(archive.entries);
  const file = archive.entries.find((entry) => entry.kind === "file");
  if (!file) return undefined;
  const result = await archive.read(file.id, { offset: 0, length: Math.min(4096, file.size), ledger });
  console.log(result.integrity); // "none": ar has no payload checksum.
  return result.bytes;
}
```

See [the capability guide](../docs/ar.md) for ownership, work limits, recovery and independent interoperability
evidence.
