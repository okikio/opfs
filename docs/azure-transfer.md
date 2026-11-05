# Continue an Azure block upload after restart

Persist an upload descriptor and transfer checkpoint before the first block. After a process restart, reopen the same
client, descriptor and immutable source, then call `resumeTransfer()` again:

```ts
import { createAzureClient } from "@okikio/opfs/azure";
import { createAzureSession, createAzureUploadDestination } from "@okikio/opfs/transfer/azure";
import { createTransferCheckpoint, resumeTransfer } from "@okikio/opfs/transfer";
import type { ByteSourceType } from "@okikio/opfs/source";
import type { AzureSessionType } from "@okikio/opfs/transfer/azure";
import type { TransferCheckpointType } from "@okikio/opfs/transfer";

export async function upload(
  source: ByteSourceType,
  token: string,
  credentials: { endpoint: string; container: string; sas: string },
  saveSession: (value: AzureSessionType) => Promise<void>,
  saveCheckpoint: (value: TransferCheckpointType) => Promise<void>,
): Promise<void> {
  const client = createAzureClient({
    endpoint: credentials.endpoint,
    container: credentials.container,
    credential: { kind: "sas", token: credentials.sas },
  });
  const session = await createAzureSession(client, {
    key: "uploads/report.bin",
    size: source.size,
    token,
    blockBytes: 4 * 1024 * 1024,
    mediaType: "application/octet-stream",
  });
  await saveSession(session);
  const destination = createAzureUploadDestination(client, session);
  const checkpoint = createTransferCheckpoint(source, destination);
  await saveCheckpoint(checkpoint);
  await resumeTransfer({
    source,
    destination,
    checkpoint,
    chunkBytes: session.blockBytes,
    save: saveCheckpoint,
  });
}
```

The application supplies storage for both durable values, atomically replaces each checkpoint, and reopens an unchanged
source with the same nonempty identity after restart. Source identity is the application's assertion of immutable replay
bytes; the library cannot verify it by comparing a label. The caller also owns credentials, source and client lifetime.
The descriptor stores no credentials. Its backend identity, key, token, destination baseline and layout remain sensitive
application data, and the transfer checkpoint contains an encoded copy in its opaque destination identity URL.

`createAzureSession()` validates the layout, requires the client's configured backend identity, and captures the current
blob ETag or absence with HEAD. It allocates no remote upload resource. Save the returned descriptor before staging.
`createAzureUploadDestination(client, persistedSession)` performs no I/O and rejects another backend identity before any
request. To restart, pass the saved descriptor to that factory and the saved checkpoint to `resumeTransfer()`; do not
call `createAzureSession()` again for the same attempt.

## Staging and final publication are separate

Each fixed-width Base64 block ID contains a caller-supplied fresh token and block index. The token must contain 22–40
URL-safe ASCII characters, be unpredictable, and never be reused for another upload or copied to another object. The
caller must exclude all other writers to the blob name and this session, and preserve the source bytes for the entire
attempt. There is no distributed lease, stale-writer fencing, content-hash proof or safe concurrent upload protocol
here.

Azure's [Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block) acknowledges retained staging;
it does not publish those bytes as the blob. Status first checks the current blob, then explicitly requests the
[uncommitted block list](https://learn.microsoft.com/en-us/rest/api/storageservices/get-block-list). Retained IDs and
sizes must form the exact contiguous prefix of the saved layout. Gaps, foreign IDs, duplicates and changed extents
reject. An acknowledged remote prefix can be ahead of the checkpoint when the process died before saving it;
reconciliation accepts it only under exclusive session ownership and unchanged source bytes. If Azure has discarded
previously saved progress, the transfer coordinator rejects the rollback. It never silently restarts a partially saved
attempt.

`finish()` requires all bytes to be staged, then sends a conditional
[Put Block List](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block-list). It selects only
`Uncommitted` blocks in index order; committed blocks cannot substitute for missing staged data. The original ETag
becomes `If-Match`, or original absence becomes `If-None-Match: *`. This closes a destination-change race between the
baseline/status HEAD and final publication. A different current baseline is refused before commit when observed; a race
after that check is still enforced by Azure. These conditions protect final replacement, not concurrent staging under
reused block IDs.

The commit atomically writes reserved metadata `opfs_session`, `opfs_size` and `opfs_block_bytes`. A lost commit receipt
raises `AzureCommitError` with `effect: "unknown"`. On the next explicit continuation, matching unique session metadata
and exact size/layout attribute final publication to this attempt. The complete staged byte count alone never does. The
caller must not copy or reuse those metadata values. A same-size foreign blob or a changed destination cannot be
accepted as successful recovery. Final HTTP 4xx rejection other than timeout remains an `AzureError`; transport loss,
server failure or invalid acknowledgement remains uncertain. No dispatched block or final publication is automatically
retried by this module.

An empty source still needs final publication: its initial zero-byte staging status is incomplete, and an empty block
list conditionally creates or replaces the blob. The successful commit receipt must include an HTTP ETag. A later
continuation independently checks the session metadata rather than assuming a previous local return is still current. A
valid receipt remains acknowledged publication even if the caller aborts immediately afterward.

## Bounds, cancellation and abandoned staging

This first profile admits at most 10,000 blocks and at most 4 MiB per block, with 4 MiB as the default. The block-count
ceiling is an implementation limit below Azure's 50,000 committed-block limit; it keeps XML within the shared bounded
control parser. Four MiB blocks remain legal on older Azure service versions as well as current ones. The maximum layout
is 10,000 × 4 MiB (about 39 GiB); smaller blocks lower the maximum admitted object size. These limits apply to this
continuation module, independently of the client's other upload paths. Every write must match the persisted block size
except for the exact shorter final block. Native byte extents are checked before copying or I/O. Each operation owns at
most one copied block plus its bounded control document; the coordinator also retains the currently read source block.

Use `resumeTransfer.chunkBytes === session.blockBytes`. Uploads are sequential and checkpointed only after remote
acknowledgement. Wrong chunk size or changed replay identity rejects instead of changing the persisted layout. Status
and write operations borrow the caller's signal; aborting a request may leave an acknowledged block or uncertain final
publication on the server. Pausing the coordinator saves a paused checkpoint between acknowledged chunks and leaves
staging intact. Raw Azure client `request()` owns signed transport and response bodies are bounded and retired through
the existing control-response reader.

There is no `terminate()` implementation. Azure offers no operation that safely deletes only this session's uncommitted
blocks while preserving an existing or ambiguously published blob. Do not use deletion or an empty overwrite as a
pretend abort. Stopping locally does not remove remote blocks. Azure normally garbage-collects uncommitted blocks after
one week without a successful Put Block or Put Block List for that blob; activity by another writer affects that
lifetime. The application owns abandoned-attempt bookkeeping and any explicit destructive cleanup policy. Blob leases,
encryption scopes, tags, custom user metadata, parallel upload and cross-writer recovery are outside this first profile.

## Verification

`tests/azure-transfer.test.ts` uses authored protocol responses to check exact layout admission, stage reconciliation,
unknown final publication, empty objects, backend mismatch, native-byte extent checks, changed destination baselines,
malformed direct XML scalars, conditional rejection and pre-aborted operations. These are protocol-contract tests.

`tests/azure-transfer-provider.test.ts` uses the repository's disposable Testcontainers Azurite fixture. It saves the
actual session and checkpoint files, kills a child after a successful block response before checkpoint persistence,
restarts and kills it after final publication before completion persistence, then starts another child to reconcile
without rereading source bytes. The independent Azure SDK checks retained block size, final bytes and session metadata.
This is emulator process-loss and independent-consumer evidence. It does not establish deployed Azure permissions,
retention timing, latency or concurrent-writer safety.
