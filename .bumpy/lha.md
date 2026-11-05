---
"@okikio/opfs": minor
---

Preview stored LHA members with explicit header and complete-file CRC evidence.

```ts
import { openLha } from "@okikio/opfs/archive/lha";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType) {
  const archive = await openLha(source);
  const member = archive.entries.find((entry) => entry.readable);
  if (!member) throw new Error("No supported stored file exists.");
  return await archive.read(member.id, { length: Math.min(1024, member.size) });
}
```

Header levels 0–2 and ordinary `-lh0-` files have bounded indexes, owned selected bytes and borrowed nested sources. The
default selected read scans the complete member for CRC16; explicit unchecked partial reads retain pending integrity.
Names remain inert, directory separators remain format-specific, and non-ASCII decoding requires caller policy. Native
JLHA fixtures compare every original byte with JLHA, Lhasa, 7-Zip and libarchive, with a distinct native writer limit
for level-0 names. Compressed methods, extraction, encryption and split volumes are unsupported. The
[guide](../docs/lha.md) explains CRC scopes, limits, cancellation and nesting.
