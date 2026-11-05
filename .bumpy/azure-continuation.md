---
"@okikio/opfs": minor
---

### Reconcile Azure staged blocks across process loss

The optional `transfer/azure` subpath captures a blob's initial ETag or absence and persists a fixed block layout with a
caller-owned unique token. Restart reads the uncommitted block list instead of trusting process memory. Final
publication applies the captured condition and session metadata atomically; a matching marker and extent distinguish an
acknowledged publication from fully staged bytes after a lost final receipt.

See [the complete continuation example](docs/azure-transfer.md) for application-owned atomic persistence, immutable
source identity and exclusive writer ownership. The first profile admits at most 10,000 blocks of 4 MiB each; these
implementation bounds are narrower than modern Azure service limits. Cancellation retains staged blocks. No terminate
operation is invented because deleting a blob cannot safely stand in for aborting only its uncommitted blocks.

```ts
import type { AzureClientType } from "@okikio/opfs/azure";
import type { ByteSourceType } from "@okikio/opfs/source";
import { createAzureSession, createAzureUploadDestination } from "@okikio/opfs/transfer/azure";
import { createTransferCheckpoint, resumeTransfer } from "@okikio/opfs/transfer";

export async function copy(client: AzureClientType, source: ByteSourceType, token: string) {
  const session = await createAzureSession(client, { key: "report.bin", size: source.size, token });
  const destination = createAzureUploadDestination(client, session);
  let checkpoint = createTransferCheckpoint(source, destination);
  // In-memory illustration only: durably save both records before promising process recovery.
  return await resumeTransfer({
    source,
    destination,
    checkpoint,
    chunkBytes: session.blockBytes,
    save: async (value) => {
      checkpoint = value;
    },
  });
}
```

Disposable Azurite tests kill fresh Node processes after block and publication acknowledgments, reopen the saved state
and compare final bytes and metadata through the Azure SDK. This establishes the exercised emulator behavior, not
production Azure authorization, durability or concurrent session safety. Borrowed clients and sources remain
caller-owned.
