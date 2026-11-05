---
"@okikio/opfs": minor
---

Preview BinHex attachments while preserving their separate data and resource forks.

```ts
import { openBinHex } from "@okikio/opfs/archive/binhex";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType) {
  const archive = await openBinHex(source);
  const result = await archive.read("data", { length: Math.min(256, archive.dataSize) });
  return { name: archive.name, ...result };
}
```

Each read replays encoded content from the borrowed source. A verified data prefix checks its whole data fork, while
resource and terminal evidence remain pending. Reading the resource fork also checks preceding data. Streaming output is
provisional until its `finished` promise settles; CRC16 does not authenticate a publisher. Explicit compatibility
options expose observed producer banner and padding differences. The [guide](../docs/binhex.md) explains retained
budgets, cancellation, nested readers and native fixture limits. No host files are extracted.
