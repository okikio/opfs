---
"@okikio/opfs": minor
---

Read and mutate native Yandex Disk paths with explicit content credentials and asynchronous operation receipts.

```ts
import { YandexClient } from "@okikio/opfs/yandex";

async function readPrefix(
  path: string,
  getToken: () => Promise<string>,
  contentOrigins: readonly string[],
  initialOAuthOrigins: readonly string[],
): Promise<Uint8Array> {
  const disk = new YandexClient({
    token: () => getToken(),
    downloadOrigins: contentOrigins,
    downloadAuthOrigins: initialOAuthOrigins,
    maxBytes: 8 * 1024 * 1024,
  });
  return disk.read(path, { at: 0, length: 4096 });
}
```

The initial download receives the operation's OAuth token only on a separately granted origin; redirects permanently
strip it. Upload links receive no OAuth. Pending mutation receipts require caller-owned reconciliation, and mutable
paths are not immutable file identities. See the [Yandex guide](../docs/yandex.md) for bounded listing, extent checks,
recursive deletion choices and the authored protocol evidence.
