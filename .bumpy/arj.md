---
"@okikio/opfs": minor
---

Preview STORED files inside selected single-volume ARJ archives without extracting host files.

```ts
import { openArj } from "@okikio/opfs/archive/arj";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType) {
  const archive = await openArj(source);
  const entry = archive.entries.find((value) => value.kind === "file" && value.readable);
  if (!entry) return undefined;
  return await archive.read(entry.id, { length: Math.min(256, entry.size) });
}
```

Header CRCs are mandatory. A default prefix read checks every byte of the selected member before returning owned output;
a partial `verify: false` read reports pending integrity and avoids the full-member scan. CRC32 is not authentication.
Names and comments remain inert, duplicate physical members retain distinct IDs, and nested sources borrow the caller's
original resource. Native ARJ and 7-Zip fixtures compare complete original bytes, explicit directories and comments.
Compressed members can expose supported header metadata but cannot be decoded; encryption, multivolume, recovery,
nonzero extended headers and extraction are unsupported. The [guide](../docs/arj.md) explains budgets, cancellation,
encoding policy and selected-read costs.
