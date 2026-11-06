---
"@okikio/opfs": minor
---

### Read HTTP resources and use native WebDAV, B2 and Swift storage

Optional `http`, `webdav`, `b2` and `swift` subpaths add explicit caller-owned authentication without ambient credential
discovery. WebDAV uses file drivers/adapters; B2 and Swift use object drivers/adapters. HTTP opens one resource rather
than inventing a directory listing:

```ts
import { openHttpSource } from "@okikio/opfs/http";

export async function preview(url: URL, token: string): Promise<Uint8Array> {
  const source = await openHttpSource(url, {
    headers: { authorization: `Bearer ${token}` },
    maxReadBytes: 4096,
  });
  return await source.read(0, Math.min(4096, source.size));
}
```

HEAD must provide a known length and strong validator. Redirects do not forward credentials. Exact range reads fail on
ignored ranges or changed revisions. B2 preserves immutable opaque file IDs separately from ETags and GCS generations;
filesystem removal creates a hide marker so deleting a current version cannot accidentally reveal an older one.

See the HTTP, WebDAV, B2 and Swift guides for complete filesystem examples, concurrency restrictions and recovery.
WebDAV and Swift have disposable real-server fixtures. B2 has deterministic protocol-fixture evidence only, and its
bounded uploads are not resumable. The WebDAV file driver refuses removal because native collection DELETE is recursive
and cannot atomically require a regular-file resource type. Native DELETE remains an explicit client operation. None of
these additions imply certification for every deployment or middleware.
