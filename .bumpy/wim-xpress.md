---
"@okikio/opfs": minor
---

Read ordinary WIM XPRESS-Huffman chunks with bounded decode work and separate resource hashes.

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

Ordinary 32 KiB XPRESS-Huffman resources now share the existing WIM index and whole-resource SHA-1 policy. Packed source
bytes and decoded sizes remain distinct. A deferred range decodes complete selected chunks and leaves the resource hash
pending; default verification decodes the full resource. Finite tables, chunks, CPU steps and materialized output remain
explicit. The [guide](../docs/wim.md) explains the strict native writer termination profile and genuine wimlib/7-Zip
full-byte evidence. This does not certify the whole image or add plain XPRESS, LZX, LZMS, solid or split images.
