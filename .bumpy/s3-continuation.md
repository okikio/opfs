---
"@okikio/opfs": minor
---

### Continue a multipart S3 upload after process loss

The optional `transfer/s3` subpath creates and reopens explicit persisted sessions for the existing native S3 client.
`ListParts` reconciles retained part extents before another write. Completion remains separate from staging every byte:
a lost final acknowledgment can be attributed through a unique caller-owned metadata marker and exact object size. The
application must serialize all writers to the key, keep its replay source immutable, never reuse/copy the marker and
publish session/checkpoint records atomically.

See [the complete start/restart example](docs/s3-transfer.md) for persistence ownership, cancellation, remote cleanup
and unknown creation receipts. Parts default to 8 MiB, with a 5–64 MiB implementation range and 10,000-part ceiling.
Empty objects continue to use ordinary `put()`. A checkpoint identity is not a URL to fetch. Native client `listParts()`
remains independently useful for explicit provider inspection.

```ts
import type { S3ClientType } from "@okikio/opfs/s3";
import type { ByteSourceType } from "@okikio/opfs/source";
import { createS3Session, createS3UploadDestination } from "@okikio/opfs/transfer/s3";
import { createTransferCheckpoint, resumeTransfer } from "@okikio/opfs/transfer";

export async function copy(client: S3ClientType, source: ByteSourceType, token: string) {
  const session = await createS3Session(client, { key: "report.bin", size: source.size, token });
  const destination = createS3UploadDestination(client, session);
  let checkpoint = createTransferCheckpoint(source, destination);
  // In-memory illustration only: durably save session and checkpoint before promising process recovery.
  return await resumeTransfer({
    source,
    destination,
    checkpoint,
    chunkBytes: session.partBytes,
    save: async (value) => {
      checkpoint = value;
    },
  });
}
```

Tests kill separate Node processes after acknowledged part and final publication, reopen saved state and compare the
published bytes with the AWS SDK against disposable SeaweedFS. This is compatible-server recovery evidence, not proof of
AWS IAM, production durability, encryption policy or competing writer safety. The client and source remain borrowed.
