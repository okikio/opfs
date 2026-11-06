---
"@okikio/opfs": minor
---

Inspect uncompressed MCAP recordings and preview opaque message bytes without loading a serialization decoder.

```ts
import { openMcap } from "@okikio/opfs/dataset/mcap";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType) {
  const recording = await openMcap(source, { profile: "mcap0-uncompressed" });
  const page = recording.messages({ limit: 64, maxScanned: 8192 });
  const first = page.messages[0];
  if (!first) return { channels: recording.channels, next: page.cursor };
  return await recording.read(first.id, { length: Math.min(256, first.size) });
}
```

The reader scans physical records and uncompressed chunks, preserves exact bigint timestamps and pages messages within
separate result and scan limits. Sparse pages can be empty and still carry a continuation cursor. Selected reads name
their checked chunk or attachment CRC scope; ordinary unchunked messages require an explicit whole-data check. Raw
payload sources remain unchecked and borrow the original resource. Independent Python writer/reader paths verify
complete native bytes and the zero-summary footer CRC, but do not establish cross-vendor conformance. Compressed chunks,
index-driven lookup, payload decoders and authenticity are unsupported. The [guide](../docs/mcap.md) explains lifetime
budgets, cancellation and verification costs.
