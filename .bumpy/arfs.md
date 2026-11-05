---
"@okikio/opfs": minor
---

Inspect explicitly selected public ArFS 0.15 metadata revisions and compose their file sources with archive previews.

```ts
import { openArfs } from "@okikio/opfs/content/arfs";
import type { ArfsDataInputType, ArfsInputType } from "@okikio/opfs/content/arfs";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(inventory: ArfsInputType, fileId: string, data: ArfsDataInputType) {
  const drive = await openArfs(inventory);
  const archive = await openZip(drive.file(fileId).source(data));
  return await archive.read(0);
}
```

Callers own revision selection, decoded tags, metadata provenance and explicit data acquisition. IDs and sizes are
validated as assertions; the reader does not discover a gateway, follow pins, verify signatures, choose latest revisions
or prove complete drive state. It preserves borrowed-source evidence, cumulative budgets and cancellation through
selected reads. Numeric file authority is checked lexically before JSON conversion can round it. Independent offline
ArDrive/Arweave SDK fixtures verify the selected public metadata framing, and independent Python ZIP bytes exercise
composition. Locally signed, unsubmitted fixture transactions do not establish chain confirmation or production-reader
authentication. Private metadata, older ArFS versions and publication remain separate profiles. The
[guide](../docs/arfs.md) explains source ownership, supplied-only listings and recovery boundaries.
