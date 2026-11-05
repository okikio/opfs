---
"@okikio/opfs": minor
---

Read and transfer bounded opaque restic REST repository objects without loading a backup runtime.

```ts
import { ResticClient } from "@okikio/opfs/restic";

export async function firstPack(endpoint: string, authorization: string, subtle: SubtleCrypto) {
  const client = new ResticClient({ endpoint, credentials: () => authorization, subtle });
  const objects = await client.list("data");
  if (!objects.length) return undefined;
  return await client.readVerified({ kind: "data", id: objects[0]!.id });
}
```

Verified reads hash the complete bounded stored object before returning private bytes. The bytes remain encrypted pack
representations: this client does not restore snapshots, decrypt packs, coordinate locks or enforce retention. Native V2
listings and exact range responses retain their own limits. The [guide](../docs/restic.md) explains streamed
server-trusted downloads, explicit crypto and credential ownership, and unknown mutation outcomes. Genuine rest-server
and the independent official restic CLI compare complete produced pack bytes in both directions; copying a pack to
another repository does not establish that its key can decrypt it. No third-party runtime dependency is added.
