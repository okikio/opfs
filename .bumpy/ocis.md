---
"@okikio/opfs": patch
---

Document native ownCloud Infinite Scale reads and the create-only condition it does not enforce.

```ts
import { createWebdavClient } from "@okikio/opfs/webdav";

export async function preview(collection: string, authorization: string, account: string, path: string) {
  const client = createWebdavClient({
    endpoint: collection,
    namespace: account,
    headers: () => ({ authorization }),
  });
  const source = await client.openSource(path);
  return await source.read(0, Math.min(1024, source.size));
}
```

Pinned Infinite Scale 8.2.2 and independent rclone tests qualify complete bytes, selected ranges and listing through the
existing WebDAV client. Native stale GET returns a changed ETag, which the client rejects before exposing bytes; stale
conditional PUT returns 409 without changing the file. An existing-resource PUT with `If-None-Match: *` succeeds and
actually overwrites it, so this profile does not qualify atomic creation. The read-only example does not imply an
immutable filename or transaction. No new provider wrapper or dependency is added. The [guide](../docs/ocis.md)
distinguishes native protocol constraints, cooperative facade semantics and untested operations.
