---
"@okikio/opfs": minor
---

Use native unencrypted Seafile libraries with API tokens isolated from data capability URLs.

```ts
import { SeafileClient } from "@okikio/opfs/seafile";
import type { SeafileClientOptionsType } from "@okikio/opfs/seafile";

export async function save(options: SeafileClientOptionsType, bytes: Uint8Array) {
  const client = new SeafileClient(options);
  const receipt = await client.upload("/", "preview.bin", bytes);
  return { receipt, bytes: await client.read("/" + receipt.name) };
}
```

The caller owns the library, user token and separate origin/path grants for upload and download capabilities. Native
collision handling can choose another file name; the receipt preserves it. Explicit replacement is unconditional and an
uncertain upload is not safe to replay. Exact-range streams and bounded materialization retain cancellation and framing
checks. Encrypted libraries are inspectable but refuse data operations; file IDs do not prove content hashes. The
[guide](../docs/seafile.md) distinguishes protocol tests from native provider evidence and explains recovery.
