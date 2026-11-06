---
"@okikio/opfs": minor
---

Use Git LFS Batch/basic transfers without discovering Git configuration or forwarding repository credentials to actions.

```ts
import { LfsClient } from "@okikio/opfs/content/lfs";

export async function read(
  endpoint: string,
  actionOrigin: string,
  oid: string,
  size: number,
  subtle: Pick<SubtleCrypto, "digest">,
): Promise<Uint8Array> {
  const client = new LfsClient({ endpoint, downloadOrigins: [actionOrigin], subtle });
  return await client.readVerified({ oid, size });
}
```

Canonical pointer bytes, bounded batches, explicit action-origin grants and distinct upload/verify acknowledgments keep
native authority visible. Whole-object verification uses injected SHA-256 before exposing immutable copied ranges;
unverified downloads remain streams. Unknown upload outcomes require reconciliation rather than automatic retry. The
[Git LFS guide](../docs/lfs.md) includes authenticated composition, secret ownership, finite memory costs and recovery.
An independent official CLI and disposable Gitea server check complete transfer bytes in both directions. This native
client does not publish refs, transform pointer extensions, resume uploads or create a filesystem projection.
