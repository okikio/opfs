---
"@okikio/opfs": minor
---

Preview Internet Archive ARC1.0 physical captures through bounded stored-block ranges. Explicit file-description
separator profiles preserve genuine producer differences without changing declared byte extents.

```ts
import { openArc } from "@okikio/opfs/archive/arc";
import { createBlobSource } from "@okikio/opfs/source";

export async function previewArc(bytes: ArrayBuffer) {
  const archive = await openArc(createBlobSource(new Blob([bytes])));
  const capture = archive.entries.find((entry) => entry.kind === "record");
  if (!capture) return { archive, capture: undefined, preview: undefined };
  const preview = await archive.read(capture.id, { length: Math.min(capture.size, 64) });
  const storedBlock = archive.source(capture.id);
  return { archive, capture, preview, storedBlock };
}
```

Stored HTTP blocks retain response headers; framing supplies no checksum or authentication. See the
[ARC guide](../docs/arc.md) for borrowed-source ownership, finite limits and interoperability evidence.
