---
"@okikio/opfs": minor
---

Open native Kubo fanout-256 UnixFS sharded directories through an explicit profile.

```ts
import { openUnixfs } from "@okikio/opfs/content/unixfs";
import type { UnixfsBlockReaderType } from "@okikio/opfs/content/unixfs";

export async function directory(root: string, read: UnixfsBlockReaderType, subtle: SubtleCrypto) {
  const node = await openUnixfs(root, read, { subtle, hamtProfile: "kubo-fanout-256" });
  if (node.kind !== "hamt-directory") throw new Error("Expected a sharded directory");
  return await node.list();
}
```

Literal lookup acquires only the selected shard route. Explicit listing traverses bounded internal shards and verifies
complete directory links without acquiring file targets. Parent cancellation and budgets remain authoritative; the
Murmur routing hash is separate from SHA-256 block integrity. Genuine Kubo imports, reciprocal authored boundary graphs
and independent original hash vectors exercise routing and refusal. The profile names native conventions that differ
from the pinned draft; default admission still refuses HAMT. Listing does not prove descendant contents, availability or
publisher identity. See the [guide](../docs/unixfs.md) for selected-file reading and resource limits.
