# Google Drive stored files

Drive addresses files by ID. Two files may have the same name, and a folder name does not identify a unique path. This
native client therefore operates on IDs without a filesystem driver or adapter.

```ts
import { DriveClient } from "@okikio/opfs/drive";

// Your application obtains and refreshes this OAuth token. No ambient credentials are read.
const accessToken = "replace-with-an-OAuth-access-token";
const drive = new DriveClient({ token: () => accessToken });
const bytes = new TextEncoder().encode("hello");
const upload = await drive.createUpload({ name: "hello.txt", mimeType: "text/plain", size: bytes.length });
const result = await drive.writeUpload(upload, 0, bytes);
if (!result.complete) throw new Error("Upload is incomplete; query its session before continuing.");

// The receipt's ID identifies this creation even if another hello.txt already exists.
const stream = await drive.download(result.file.id, { at: 0, length: 5 });
console.log(await new Response(stream).text()); // hello
await drive.trash(result.file.id); // Reversible: drive.update(id, { trashed: false }).
// drive.remove(id) is a separate permanent deletion, including native folder deletion semantics.
```

The application chooses OAuth scopes and account access. `token(url, signal)` receives a copied admitted target URL for
each request; it owns token refresh and cancellation. Returned stream consumers must drain or cancel the stream. Custom
`endpoint` and `uploadEndpoint` URLs are explicit trust boundaries for private gateways or tests. Tokens are never
forwarded through HTTP redirects. Importing or constructing the client performs no I/O.

## IDs, pages and shared drives

`stat(id)` returns metadata. `download(id, { at, length, signal })` first checks that the resource represents a stored
file, then requests `alt=media`. Nonempty ranges require a valid HTTP 206 and exact finite Content-Range; ignored
ranges, encoded bodies and mismatched extents are rejected and their bodies cancelled. A zero-length read is local and
gives no evidence that a remote ID exists. Downloads are mutable reads: metadata and content can change between
requests. Neither `version` nor file ID supplies immutable source identity or a revision precondition. This client does
not produce a replay-safe `ByteSourceType`.

`listPage({ parent, sharedDriveId, pageSize, pageToken })` retains native IDs, duplicate names, continuation tokens and
`incompleteSearch`. Default scope is the authenticated user's corpus; `sharedDriveId` explicitly selects the `drive`
corpus and shared-drive support parameters. `parent: "root"` uses Drive's root alias. Trashed resources are excluded.
There is no synthesized path resolver or shortcut traversal.

`list(options)` follows pages, including empty intermediate pages, within `maxPages` (default 1000) and `maxEntries`
(default 100000). It rejects incomplete searches and repeated tokens. It is not a transactionally consistent snapshot:
concurrent changes can affect results. `pageSize` defaults to 100 and cannot exceed 1000. Provider JSON responses have
an independent 8 MiB encoded control-body ceiling. Token expiration and rejected page tokens require caller recovery;
the client does not silently restart a listing.

## Resumable create and content replacement

`createUpload({ size, mimeType, name, parent })` creates a stored-file resumable session. To replace an existing file's
content, provide `fileId` instead; replacement does not move parents and has no optimistic concurrency guarantee.
Workspace-native MIME types, folders and shortcuts are refused for stored-content creation.
`update(id, { name,
trashed })` changes metadata separately. `trash(id)` sets `trashed: true`; `remove(id)` permanently
deletes by ID. Native permanent deletion of a folder can affect descendants, so this operation is not a canonical
one-entry filesystem removal.

Keep the returned `{ url, size, fileId? }` secret and persist it only in caller-controlled storage. Restored sessions
must target the configured upload origin and exact create/update route, with `uploadType=resumable` and `upload_id`. The
only admitted query fields are `uploadType`, `upload_id`, `fields` and `supportsAllDrives`, each at most once; alternate
query-based credentials are refused. Only then is the OAuth callback acquired. No session redirects are followed. Drive
sessions expire, typically after one week; HTTP 404 is surfaced and never silently starts another creation.

`writeUpload(session, acknowledgedOffset, bytes)` accepts at most 8 MiB per call, an implementation memory policy. It
copies genuine Uint8Array backing bytes before awaiting credentials, including views whose JavaScript properties have
been shadowed. Nonfinal chunks must be positive multiples of 256 KiB; the final chunk may be smaller. A partial server
acknowledgement determines the next offset, which need not match the sent extent. `queryUpload(session)` uses an empty
status PUT and interprets a missing Range as offset zero. A 308 response remains incomplete even when its acknowledged
offset equals the fixed total. Only HTTP 200/201 with a valid stored-file receipt, matching fixed byte count, and
matching update ID confirms completion. This checks attribution and extent, not cryptographic content integrity; the
caller must keep the source unchanged and own the session exclusively.

`destination(session)` exposes the fixed-size `UploadDestinationType` seam with protocol `drive-resumable`. The caller
must use transfer chunks of a positive 256 KiB multiple, at most 8 MiB, and an independently stable source identity.
There is no terminate or forced-finish claim. An unconfirmed final or zero-byte publication stays unconfirmed until
Drive supplies a complete receipt.

Mutations are never automatically retried, even if the request policy allows read retries. `DrivePublicationError` means
the client lacks a validated mutation acknowledgement; reconcile a content write through its existing session before
retrying. `DriveError.status` exposes HTTP failure codes without including tokens or session URLs. A lost
metadata-update or permanent-delete acknowledgement requires application-specific reconciliation; do not treat the
absence of a response as proof that nothing changed.

## Scope and evidence

This profile supports stored-file metadata, bounded pagination, media reads, reversible trash, explicit permanent
deletion, and fixed-size resumable content creation/replacement. Workspace exports, revision downloads, permissions,
shortcut resolution, folder creation, transactional path projection, conditional replacement, upload cancellation and
cryptographic integrity verification are outside this profile. Export has different size/range behavior and is not
silently substituted for stored-file download.

`tests/drive.test.ts` uses injected protocol responses to exercise IDs, duplicate names, shared-drive corpus selection,
range evidence and cleanup, auth admission, acknowledged offsets, final receipts, chunk budgets and unknown publication.
These are protocol-level tests, not live Google Drive, OAuth, quota or shared-drive conformance evidence. No emulator or
service credentials are required.

Primary contracts: Google's [upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[download and export guide](https://developers.google.com/workspace/drive/api/guides/manage-downloads),
[files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list),
[files.update](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update), and
[files.delete](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/delete).
