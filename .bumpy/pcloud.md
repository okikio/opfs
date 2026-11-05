---
"@okikio/opfs": minor
---

Use pCloud native IDs with exact uint64 identities, explicit signed origins and unknown-publication errors.

```ts
import { PcloudClient } from "@okikio/opfs/pcloud";

async function previewFile(
  fileId: string,
  getToken: () => Promise<string>,
  allowedContentOrigins: readonly string[],
): Promise<Uint8Array> {
  const cloud = new PcloudClient({
    endpoint: "https://eapi.pcloud.com", // Europe; US accounts use api.pcloud.com.
    token: () => getToken(),
    downloadOrigins: allowedContentOrigins,
    maxBytes: 8 * 1024 * 1024,
  });
  return cloud.read(fileId, { at: 0, length: 4096 });
}
```

See the [pcloud guide](../docs/pcloud.md) for caller-owned resources, finite work and unsupported profiles.
