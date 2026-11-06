---
"@okikio/opfs": minor
---

Preview ordinary WIM LZX resources with exact chunk framing and explicit codec work.

```ts
import { openWim } from "@okikio/opfs/archive/wim";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(blob: Blob, subtle: SubtleCrypto): Promise<Uint8Array | undefined> {
  const archive = await openWim(createBlobSource(blob), { subtle });
  const image = await archive.image(1);
  const entry = image.entries.find((entry) => entry.type === "file");
  return entry ? (await image.read(entry.id, { length: Math.min(64, entry.size) })).bytes : undefined;
}
```

Ordinary independent 32 KiB LZX chunks use WIM-specific framing and E8 reversal. Default whole-resource SHA-1 checks
remain distinct from selected-chunk decoding; `lzxSteps`/`lzxBlocks` expose finite codec work without changing XPRESS
metrics. The [guide](../docs/wim.md) distinguishes genuine verbatim/aligned producer fixtures from explicitly authored,
native-accepted raw/multiblock fixtures. This profile does not imply CAB LZX, LZXD, LZMS, solid/split images or
publisher authentication. Imports add no native codec or external runtime dependency.
