---
"@okikio/opfs": minor
---

Add explicit original Glacier vault archive uploads, retrieval jobs, completed-output previews, and multipart
operations.

```ts
import { createGlacierClient } from "@okikio/opfs/glacier";
import type { GlacierOptionsType } from "@okikio/opfs/glacier";

export async function readPreview(options: GlacierOptionsType, completedJobId: string) {
  const client = createGlacierClient(options);
  const source = await client.openOutput(completedJobId);
  return await source.read(0, Math.min(source.size, 4096));
}
```

Applications inject Fetch, SubtleCrypto, a clock, credentials, and vault scope. They own retrieval cost, polling,
durable IDs, and explicit cleanup. The client never starts a paid retrieval from a byte read. Completed job output is
finite and can expire; pending/failed jobs are refused. Exact output reads distinguish byte admission from service or
caller checksum evidence.

Single uploads and multipart parts copy bounded input and calculate distinct linear and Glacier tree hashes. Multipart
completion checks complete ordered part coverage without buffering the entire archive. Native page APIs retain sparse
parts and nullable markers; bounded reconciliation detects duplicate extents and repeated markers. Lost publication
receipts produce explicit unknown outcomes, while known IDs survive later validation or cleanup failure. Completion has
no promised durable retry window.

This native vault API does not fulfill S3 Glacier storage classes or create a synthetic filesystem. See the
[Glacier guide](../docs/glacier.md) for complete examples, limits, checksum provenance, retrieval charges, recovery, and
independent verification boundaries.
