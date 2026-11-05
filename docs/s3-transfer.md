# Continue an S3 multipart upload after restart

Use `transfer/s3` when an application must keep a multipart upload across process loss. Ordinary `client.put()` owns one
invocation; it does not persist a resumable session. The new session descriptor stores the backend, object key, upload
ID, part size and a unique publication marker. The separate transfer checkpoint binds that session to an immutable
replay source and records acknowledged progress.

The following complete function starts or reopens a transfer. The application supplies an authenticated client, an
immutable source and an atomic storage operation. `save()` must durably publish the entire record before resolving. Its
implementation, key management and exclusive writer ownership belong to the application.

```ts
import type { S3ClientType } from "@okikio/opfs/s3";
import type { ByteSourceType } from "@okikio/opfs/source";
import { createS3Session, createS3UploadDestination, S3SessionSchema } from "@okikio/opfs/transfer/s3";
import type { S3SessionType } from "@okikio/opfs/transfer/s3";
import { createTransferCheckpoint, resumeTransfer, TransferCheckpointSchema } from "@okikio/opfs/transfer";
import type { TransferCheckpointType } from "@okikio/opfs/transfer";

type SavedType = { session: S3SessionType; checkpoint: TransferCheckpointType };

export async function upload(
  client: S3ClientType,
  source: ByteSourceType,
  key: string,
  token: string,
  save: (record: SavedType) => Promise<void>,
  saved?: SavedType,
): Promise<SavedType> {
  const session = saved
    ? S3SessionSchema.parse(saved.session)
    : await createS3Session(client, { key, size: source.size, token });
  if (session.key !== key) throw new TypeError("Saved upload targets a different key.");
  const destination = createS3UploadDestination(client, session);
  const checkpoint = saved
    ? TransferCheckpointSchema.parse(saved.checkpoint)
    : createTransferCheckpoint(source, destination);
  await save({ session, checkpoint });
  const result = await resumeTransfer({
    source,
    destination,
    checkpoint,
    chunkBytes: session.partBytes,
    save: (checkpoint) => save({ session, checkpoint }),
  });
  return { session, checkpoint: result };
}
```

Use a fresh unpredictable token of 22–128 URL-safe characters for each new session, for example a caller-generated UUID
with hyphens removed. Never reuse it, copy it to another object or allow another writer to this key during continuation.
The client does not generate tokens, discover credentials, acquire a distributed lease or start retries in the
background. The source identity must describe the same immutable bytes after restart. A filename and size alone cannot
establish that condition. Empty objects use ordinary `put()`; this continuation profile requires positive size.

## What recovery establishes

Each continuation reads `ListParts`, validates the complete contiguous part layout, then saves reconciled progress. The
part size defaults to 8 MiB, admits 5 MiB through 64 MiB and must match `resumeTransfer.chunkBytes`. Only the last part
may be shorter. At most 10,000 part receipts are retained; provider pages and XML responses have independent bounds. A
wrong chunk, gap, changed size, repeated cursor or backend mismatch fails before another part is uploaded. No ETag is
interpreted as a hash of the original source.

If the server accepted a part before the process died, the next process finds that part and skips its acknowledged
extent. If final completion lost its receipt, a missing upload is reconciled against the current object's exact size and
`opfs-session` metadata. Some compatible servers return an empty part listing after completion; the same metadata check
handles that case. This attribution is valid only under the token uniqueness and exclusive ownership contract. A missing
upload with no matching object fails; it is never silently replaced by a new session. An overwritten final object also
fails reconciliation. There is no promise to recover a historical version after another writer replaces it.

Creation has a separate uncertainty window. A server can allocate an upload before its creation receipt is lost or
before the first durable session save. Application cleanup must identify and retire abandoned uploads; blindly creating
another session can leak remote state. Protect saved records as operational data even though this descriptor does not
contain credentials. The checkpoint destination is an opaque `https://opfs.invalid/` identity, never a URL to fetch.

Cancellation stops active requests but retains staged parts. `destination.terminate()` aborts the multipart upload; it
never deletes an already published object. The application closes its borrowed client and source. Multipart server
expiry and permissions can invalidate a saved session independently of local checkpoint retention.

## Evidence and limits

Protocol tests cover lost part/completion receipts, malformed layouts and publication-token conflicts. The disposable
SeaweedFS test kills separate Node processes after server acknowledgments but before client/checkpoint observation, then
uses a new process to continue and the AWS SDK to compare all published bytes. This proves the exercised compatible
server behavior, not AWS IAM, encryption policy, production durability or concurrent writer safety. Run it with
`deno task test:s3-transfer-provider` after provisioning Docker. Runtime-only tests are separate from serial static and
installed-package gates.

The wire contracts follow Amazon's [ListParts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html) and
[CompleteMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html) APIs. The
client parses the complete completion body because an HTTP 200 response can contain an embedded service error.
