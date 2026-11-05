---
"@okikio/opfs": minor
---

### Use injected Cloudflare R2 and Workers KV storage

Optional `r2`, `driver/r2`, `adapter/r2`, `driver/cloudflare-kv` and `adapter/cloudflare-kv` subpaths compose
caller-owned Worker bindings without discovering global services or importing a provider SDK. R2 preserves its HTTP ETag
conditions, exact ranges and upload version as separate facts. KV uses a reserved binary-value layout and bounded
whole-value reads; its metadata, listing and absence remain eventually consistent. Neither binding profile adds
multipart upload.

See [complete binding examples and limits](docs/bindings.md). Focused tests exercise the documented structural binding
contract, not a deployed Cloudflare account. Unknown native mutation outcomes require caller reconciliation.

```ts
import { createR2Client } from "@okikio/opfs/r2";
import type { R2BindingType } from "@okikio/opfs/r2";

export async function save(bucket: R2BindingType): Promise<number> {
  const client = createR2Client(bucket, { maxUploadBytes: 1024 });
  const receipt = await client.put("hello.txt", new TextEncoder().encode("hello"));
  return receipt.size;
}
```
