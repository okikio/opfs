# Nextcloud chunk uploads

Use the native chunk-upload client when you need to split a known-size file into independently acknowledged requests.
For ordinary file reads and collection operations, use the existing [WebDAV client](webdav.md). This module does not
create a filesystem, discover an account, or configure Nextcloud.

```ts
import { NextcloudClient } from "@okikio/opfs/nextcloud";
import type { NextcloudReceiptType } from "@okikio/opfs/nextcloud";

export async function uploadReport(
  endpoint: string,
  user: string,
  authorization: string,
  sessionName: string,
  bytes: Uint8Array,
): Promise<NextcloudReceiptType> {
  const client = new NextcloudClient({
    endpoint, // Deployment root, for example https://cloud.example/installation/
    user, // Native user UID, not an automatically discovered display name.
    credentials: () => authorization, // Complete native Authorization header, such as Basic <app-password encoding>.
  });
  // The caller chooses a fresh session name and exclusively owns this session and fixed source bytes.
  const session = await client.createUpload(sessionName, "Reports/report.bin", bytes.byteLength);
  const acknowledged = [];
  for (let part = 1, offset = 0; offset < bytes.byteLength; part++, offset += session.chunkSize) {
    acknowledged.push(await client.putPart(session, part, bytes.subarray(offset, offset + session.chunkSize)));
  }
  return await client.finishUpload(session, acknowledged);
}
```

The destination's parent collection must already exist. An empty source is outside this chunk-upload profile; use a
separately chosen ordinary WebDAV PUT for an empty file. The default final MOVE uses native `Overwrite: F`. Passing
`overwrite: true` to `createUpload` selects native replacement, not an atomic comparison against a file revision.

## Sessions, acknowledgements and recovery

`createUpload(name, target, size, options)` sends MKCOL to the user's upload collection. It returns a frozen
`NextcloudUploadType` containing the deployment root, native user UID, upload name, literal destination path, fixed
positive total size, fixed chunk size and overwrite choice. No credentials are stored in this descriptor. The target and
user can still be private application data, so protect persisted descriptors accordingly.

`openUpload(saved)` validates a persisted descriptor with `NextcloudUploadSchema`, validates its literal paths and part
limits, then requires the exact configured deployment and user. It performs no network request. Validation does not
prove that the server session exists, belongs to the current authentication principal, has not expired, or contains any
uploaded parts. Reopening it is a caller assertion under the same exclusive ownership and source-byte contract.

`putPart(session, part, bytes)` accepts one-based ordinals and sends zero-padded chunk names. Every part must match its
planned extent. It copies the bytes before an asynchronous credential callback; keep the complete source unchanged
across the whole upload. The returned `{ part, size }` is a successful PUT acknowledgement. It is not a hash, a remote
part inventory or proof that another actor has not subsequently replaced that part.

`finishUpload(session, acknowledged)` requires every planned acknowledgement in order. The list is caller-held evidence
and can be forged or become stale. The client cannot inspect arbitrary backend multipart state and does not claim a
remotely reconciled contiguous offset. Final MOVE addresses the session's `.file` and includes the exact Destination and
`OC-Total-Length`. A 201 or 204 receipt acknowledges the MOVE; it does not independently verify full stored bytes,
establish publisher authenticity or create an immutable byte source. No `UploadDestinationType` or automatic resumable
transfer adapter is exposed.

After any dispatched request lacks its complete accepted acknowledgement, `NextcloudPublicationError` retains the
operation and frozen upload descriptor with `outcome: "unknown"`. Its cause can be a sanitized `NextcloudError` with the
native HTTP status, a network failure or a cleanup failure. A 207 partial response and a redirect are failures. There is
no automatic mutation retry. In particular, a failed final MOVE may already have published the destination. Preserve the
session, target, source and acknowledgement ledger; investigate through an independently chosen WebDAV read or server
administration before deciding whether to retry or replace anything. A later matching file is useful recovery evidence
but cannot attribute that file to the uncertain MOVE in the presence of other writers.

`abortUpload(session)` sends DELETE only to that named upload collection. It cannot undo an already published file,
establish the result of an uncertain final MOVE, or serve as a general file/collection deletion API. Aborting and
finalizing the same session concurrently is outside the ownership contract. Nextcloud documents expiry after 24 hours of
inactivity; this client does not promise that deadline or create a background renewal task.

## Bounds and credential ownership

Nextcloud documents chunk numbers 1–10000 and chunk sizes from 5 MB through 5 GB except for the smaller last chunk. This
implementation conservatively requires a fixed chunk size of at least 5 MiB, defaults to 8 MiB and caps it at
`NEXTCLOUD_BUFFER_BYTES` (64 MiB). That cap is a local allocation policy, not a provider limit. The source itself can be
larger; each PUT materializes only its planned chunk. The caller controls concurrent requests; there is no aggregate
memory admission policy across concurrent PUTs. There are at most 10000 parts and total size must be a positive safe
integer. Literal UTF-8 targets are bounded to 8192 characters, components to 1024, and session names to 128 ASCII
letters, digits, underscores or hyphens. Empty, dot, control, backslash and malformed UTF-16 components are refused.
Literal percent characters are encoded once. These limits intentionally exclude some possible server names.

The configured root must end in `/`, include any deployment prefix, and contain no URL credentials, query or fragment.
HTTPS is the default; `allowHttp: true` is an explicit test/local deployment choice. All request URLs and Destination
headers remain in that exact configured scope. The injected callback returns only a complete Authorization header; there
is no OAuth, app-password, cookie or environment discovery. Fetch uses manual redirects, omitted ambient credentials and
no referrer. The client never forwards authentication to a redirect target.

Request policy deadlines and caller abort signals use the shared HTTP request owner. A pre-aborted operation does not
acquire credentials. Cancellation after dispatch cannot undo a mutation. Response bodies are retired even when a status
is rejected; cancellation/cleanup failures are retained. No control body is materialized by this profile. Client-created
diagnostics omit URLs and authorization. Caller-injected Fetch and credential errors are preserved as primary causes and
can themselves contain secrets; callers own their error logging policy.

## Source authority and verification limits

The wire contract is pinned to Nextcloud's
[chunk-upload documentation](https://github.com/nextcloud/documentation/blob/f1d07b3fbaca460e09fce7d0f0fab36051505d13/developer_manual/client_apis/WebDAV/chunking.rst)
and
[server 33.0.8 implementation](https://github.com/nextcloud/server/blob/1eb01d37e6fe2a15bf0bb5f042f0d37a65a72246/apps/dav/lib/Upload/ChunkingV2Plugin.php).
The documentation SHA-256 is `db31b838cd0731f2d835d8b5ecb58048bb8631b790550c2d31ec8b1ebedfc01d`; the server file SHA-256
is `793b45d1c5de19e486ea347b6de1b783e6a8c8d2f997f1bfa4288d4a8350ff9f` (retrieved 2026-11-05).

Nextcloud can use ordinary chunk storage when the distributed cache or storage backend does not support its offload
extension. Sending the documented v2-compatible wire requests does not prove which internal backend was selected. The
disposable interoperability fixture uses the official 33.0.8 Apache image index
`sha256:9ed3924f92f651aab622b23557b3f3dbcf04f7678567f50a41dbace2463c0a52`, SQLite and local file storage. Testcontainers
owns its mapped port, native HTTP readiness, 1 GiB memory limit and disposal. Fixture credentials exist only in that
server.

The independent HTTP producer/reader is bundled SabreDAV from server dependency commit
`63903c180be19a9e6aac8e0aa8e0595753bdcfdb`. Its `sabre/dav/lib/DAV/Client.php` SHA-256 is
`547109530c5318efff5759a573f165ea3c6901e96b99004cdc3bcdeed528c44c`. The fixture uses that PHP client to compare the
entire assembled payload with independently constructed bytes. This establishes local-backend wire interoperability, not
S3 multipart offload, an encrypted external mount, application-permission breadth, shared-link support, server
certification or a production performance result. No SDK or new third-party package enters the production client.
