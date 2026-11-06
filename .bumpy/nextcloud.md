---
"@okikio/opfs": minor
---

Upload native Nextcloud chunks with explicit session intent and publication receipts.

```ts
import { NextcloudClient } from "@okikio/opfs/nextcloud";

export async function upload(
  endpoint: string,
  user: string,
  authorization: string,
  sessionName: string,
  bytes: Uint8Array,
): Promise<void> {
  const client = new NextcloudClient({ endpoint, user, credentials: () => authorization });
  const session = await client.createUpload(sessionName, "note.bin", bytes.length);
  const parts = [];
  for (let at = 0, part = 1; at < bytes.length; at += session.chunkSize, part++) {
    parts.push(await client.putPart(session, part, bytes.subarray(at, at + session.chunkSize)));
  }
  await client.finishUpload(session, parts);
}
```

This example requires nonempty bytes and an exclusively caller-owned session name. Persisted descriptors contain intent;
part acknowledgments do not prove current remote state. An uncertain final MOVE retains the descriptor and operation for
explicit reconciliation. The [guide](../docs/nextcloud.md) explains create-only publication, finite copied chunks,
authentication ownership and recovery. Genuine Nextcloud and independent SabreDAV verify complete assembled bytes,
contention and aborted/missing chunks. Local-backend wire evidence does not establish multipart offload or remotely
verified resumability. Generic file access remains the separate WebDAV client.
