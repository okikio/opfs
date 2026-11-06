---
"@okikio/opfs": minor
---

Inspect unencoded 7z headers and preview stored COPY members

A strict bounded 7z reader now separates directory/header CRC evidence from payload CRC evidence. Unencoded headers can
expose compressed or encrypted member metadata; payload reads support single COPY streams only and can scan the complete
selected file to verify a short preview.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openSeven } from "@okikio/opfs/archive/seven";

export async function preview(archiveBytes: ArrayBuffer): Promise<Uint8Array | undefined> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 16 * 1024 * 1024,
    maxRequests: 512,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxOutputBytes: 4096,
  });
  const archive = await openSeven(createBlobSource(new Blob([archiveBytes])), { ledger });
  console.table(archive.entries);
  const file = archive.entries.find((entry) => entry.kind === "file" && entry.readable);
  if (!file) return undefined;
  const result = await archive.read(file.id, { length: Math.min(file.size, 4096), ledger });
  console.log(result.integrity, result.checks, result.work);
  return result.bytes;
}
```

See [the capability guide](../docs/seven.md) for finite budgets, source ownership, exact unsupported profiles and
independent fixture evidence.
