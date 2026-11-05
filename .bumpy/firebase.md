---
"@okikio/opfs": minor
---

Read and publish Firebase Storage objects through explicitly supplied Firebase Rules authentication.

```ts
import { FirebaseClient } from "@okikio/opfs/firebase";

async function publish(bucket: string, idToken: string): Promise<string> {
  const client = new FirebaseClient({ bucket, credentials: () => ({ idToken }) });
  const bytes = new TextEncoder().encode("Firebase example");
  const receipt = await client.upload("notes/example.txt", bytes, { contentType: "text/plain" });
  return receipt.generation;
}
```

The native client keeps Firebase ID tokens and App Check separate from GCS IAM. Exact streamed reads, bounded delimiter
pages, mutable metadata and multipart uploads preserve native service semantics. Resumable uploads distinguish received
offsets, final session status and validated object metadata receipts; they do not pretend a final offset proves
publication. The [Firebase guide](../docs/firebase.md) covers secret session ownership, complete resume examples and
unknown-outcome recovery. Independent official SDK/Rules emulator tests prove the exercised flows, including a nonfinal
chunk followed by status reconciliation and final publication; production IAM and App Check enforcement are separate.
