---
"@okikio/opfs": minor
---

Decode explicit LZMA Alone, raw LZMA1 and raw LZMA2 streams with bounded dictionaries and incremental output.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createLzmaDecoder } from "@okikio/opfs/archive/lzma";

async function previewAlone(file: Blob): Promise<Uint8Array> {
  const decoder = createLzmaDecoder(createBlobSource(file), { format: "alone" });
  const reader = decoder.stream.getReader();
  try {
    const first = await reader.read();
    return first.done ? new Uint8Array() : first.value.slice(0, 4096);
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
    await decoder.finished;
  }
}
```

Early cancellation reports pending structural termination, and every profile reports no checksum or authentication. The
pure codec owns finite dictionary/model/cursor storage, CPU work and source/output budgets. It does not yet parse 7z or
XZ framing, accept preset dictionaries or implement filters. See the [LZMA guide](../docs/lzma.md) for complete stream
consumption, explicit raw properties, independent producer evidence and caller-owned scheduling/cancellation.
