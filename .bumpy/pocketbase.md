---
"@okikio/opfs": minor
---

Use native PocketBase record-file fields with separate API and protected-file authority.

```ts
import { PocketbaseClient } from "@okikio/opfs/pocketbase";

export async function read(
  endpoint: string,
  authorization: string,
  recordId: string,
): Promise<Uint8Array | undefined> {
  const client = new PocketbaseClient({
    endpoint,
    collection: "documents",
    field: "files",
    credentials: () => authorization,
  });
  const record = await client.getRecord(recordId);
  const name = record.files[0];
  if (!name) return undefined;
  const token = await client.fileToken();
  return await client.read(record.id, name, { token });
}
```

Native record IDs, server-returned filenames and collection schemas remain distinct. Protected downloads receive only an
explicit file token; the client never forwards ordinary API authorization to file requests. Bounded multipart uploads
copy inputs before credentials, while missing mutation acknowledgments retain unknown outcomes. File-field removal and
whole-record deletion preserve separate server permissions. The [PocketBase guide](../docs/pocketbase.md) teaches public
and protected reads, append/replace meaning, finite budgets and recovery. A disposable official server and independent
SDK verify complete bytes and access rules. This client supplies no immutable source, CAS, resumable upload or
filesystem.
