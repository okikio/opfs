---
"@okikio/opfs": minor
---

Read verified UnixFS file ranges and literal directory entries through an explicitly supplied block reader.

```ts
import { openUnixfs } from "@okikio/opfs/content/unixfs";
import type { UnixfsBlockReaderType } from "@okikio/opfs/content/unixfs";

export async function firstBytes(cid: string, blocks: UnixfsBlockReaderType, subtle: SubtleCrypto) {
  const file = await openUnixfs(cid, blocks, { subtle });
  if (file.kind !== "file") throw new Error("Expected a file CID");
  return await file.read({ offset: 0, length: Math.min(file.size, 64) });
}
```

Each acquired block is copied and independently checked against its SHA2-256 CID before interpretation. Selected reads
can leave missing or inconsistent unselected descendants unexamined; `file.verify()` visits all file descendants,
including zero-length children. Neither proves directory completeness or permanent availability. Literal directory
lookup does not normalize paths or follow symlinks. The [guide](../docs/unixfs.md) explains graph, memory and lifetime
limits, inert metadata and the explicit native compatibility difference for nodes with both inline data and child links.
Genuine offline Kubo output and separately labeled native-accepted wire variants compare complete original bytes; HAMT
shards and other hash profiles remain unsupported. No transport or crypto capability is discovered on import.
