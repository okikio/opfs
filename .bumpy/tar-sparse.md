---
"@okikio/opfs": minor
---

Preview GNU PAX sparse 1.0 logical ranges without reading holes.

```ts
import { openTar } from "@okikio/opfs/archive/tar";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(blob: Blob): Promise<Uint8Array | undefined> {
  const archive = await openTar(createBlobSource(blob));
  const entry = archive.entries.find((entry) => entry.sparse);
  return entry ? (await archive.read(entry.id, { length: Math.min(64, entry.size) })).bytes : undefined;
}
```

Entry size is logical. Sparse metadata separately retains the map, physical stored size and recorded extents. Hole bytes
count against decoded/output limits while only intersecting recorded extents consume source requests. Opening ledgers
and abort signals now persist through ordinary and sparse indexed reads, and source/options are captured before I/O. The
[guide](../docs/tar.md) documents aggregate sparse limits, unchanged header-only integrity and strict refusal of sparse
data by one-shot/compressed TAR routes. Genuine GNU tar files match complete Python/libarchive logical bytes; recorded
7-Zip sparse-byte differences are not counted as interoperability success.
