---
"@okikio/opfs": minor
---

Preview CAB MSZIP members with exact DEFLATE framing and bounded prior-block dictionary replay.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openCab } from "@okikio/opfs/archive/cab";

async function preview(file: Blob): Promise<Uint8Array | undefined> {
  const archive = await openCab(createBlobSource(file));
  const entry = archive.entries.find((entry) => archive.folders[entry.folderId]?.readable);
  if (!entry) return undefined;
  const result = await archive.read(entry.id, { length: Math.min(entry.size, 4096) });
  console.table(result.blocks);
  return result.bytes;
}
```

Late MSZIP ranges replay the required folder history, even with checksum verification disabled. Block evidence names
history prerequisites separately from selected covering blocks, and only present matching parity checks contribute
verified evidence. Local decoding admits exact packed termination, decoded size, Huffman trees and match distances
without a runtime codec dependency. Opening cancellation and cumulative budgets remain active across reads. The
[CAB guide](../docs/cab.md) explains work costs, finite CPU policies and independent producer/consumer limits. Quantum,
LZX, spanning and reserved-area payload profiles remain unsupported.
