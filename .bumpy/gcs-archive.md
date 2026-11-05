---
"@okikio/opfs": minor
---

Publish GCS objects with explicit native Archive storage-class intent and retain the class in publication receipts.

```ts
import { createGcsClient } from "@okikio/opfs/gcs";

export async function saveArchive(bucket: string, token: string, key: string, bytes: Uint8Array) {
  const client = createGcsClient({ bucket, token });
  return await client.put(key, bytes, { storageClass: "ARCHIVE", ifNoneMatch: "*" });
}
```

The finite upload selector also supports STANDARD, NEARLINE and COLDLINE. Omitting it retains the bucket default.
Reported classes remain distinct from user metadata, including unknown response values. Explicit upload sessions retain
requested class intent; a final receipt that omits or changes it has unknown publication outcome and needs
reconciliation. Archive objects remain online: Google's minimum storage duration is a billing rule, not a deletion lock
or a thaw workflow. The [guide](../docs/gcs.md) describes the native client boundary and pending class transitions.
Independent official Google SDK and pinned emulator tests compare complete bytes in both directions, class metadata and
generation-bound ranges. They do not establish live IAM, billing, retention or durability behavior. The SDK is
test-only; production retains its native Web API implementation.
