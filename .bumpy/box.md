---
"@okikio/opfs": minor
---

Read Box file versions and use native part-based upload evidence. Signed download hops receive no OAuth or account
context; pending commits remain distinct from validated final file receipts.

```ts
import { BoxClient } from "@okikio/opfs/box";

export async function preview(
  token: string,
  fileId: string,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string> {
  const files = new BoxClient({
    token: () => token,
    fetch,
    downloadOrigins: ["https://dl.boxcloud.com"],
  });
  const bytes = await files.read(fileId, { at: 0, length: 1024, signal });
  return new TextDecoder().decode(bytes);
}
```

See the [box guide](../docs/box.md) for finite limits, ownership, unsupported profiles and recovery.
