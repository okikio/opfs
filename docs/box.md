# Read and upload Box files

Use `BoxClient` when an application owns Box OAuth and wants native file IDs, retained versions, exact byte reads or
part-based uploads. This is a provider client, not an OPFS filesystem mount. Folders and web links remain native item
kinds; names are not resolved into portable paths.

The application grants the exact signed-download origin it expects. Signed-capability hops receive no OAuth or account
context headers, even when their target origin is the API origin.

```ts
import { BoxClient } from "@okikio/opfs/box";

export async function preview(
  token: string,
  fileId: string,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string> {
  const files = new BoxClient({
    token: () => token,
    fetch,
    downloadOrigins: ["https://dl.boxcloud.com"],
  });
  const bytes = await files.read(fileId, { at: 0, length: 1024, signal });
  return new TextDecoder().decode(bytes);
}
```

Use the origins appropriate to your Box deployment; no wildcard suffix is trusted. The example origin is a common Box
download host, not a promise that every account uses it. `token(url, signal)` owns acquisition, scopes, refresh and a
stable account context. Optional `asUser` explicitly chooses a Box user. Refreshing tokens must preserve that account
and authorization context. Create another client when changing it, and keep sessions and markers in their original
context. Construction does not discover credentials or accounts.

## Select IDs and versions

`statFile(fileId)` returns stored-file metadata with current `versionId` and a safe byte `size`.
`statVersion(fileId, versionId)` reads a specific retained version. IDs stay decimal strings even when too large for
safe JavaScript integer conversion. Native metadata `etag` is an opaque Box condition, not an automatically quoted
strong HTTP representation validator.

`listPage(folderId, { marker?, signal? })` lists direct native children with `usemarker=true`. Folder ID `"0"` is the
native root. The result retains `file`, `folder` and `web_link` kinds and an optional `nextMarker`. `list()` follows
pages within configured page/entry budgets, detects repeated markers and preserves provider order. It does not
deduplicate, resolve names or claim an atomic directory snapshot.

Without an explicit version, a download first reads current file metadata and then requests that selected `versionId`.
This prevents a subsequent edit from silently switching the requested version. Box still controls version retention and
access; an old version can become unavailable. The client exposes no persistent `ByteSourceType` identity or filesystem
projection.

## Download bytes and release the stream

`download(fileId, { versionId?, at?, length?, signal? })` returns `{ fileId, version, bytes }`. The caller owns `bytes`
and must consume it to EOF or cancel it. `read()` does that work and returns a bounded byte array. A zero-length
`read()` returns empty local bytes without checking existence; `download()` requires a nonempty extent because it
acquires version metadata.

API download requests use manual redirects. A redirect is followed only if its exact origin was explicitly granted
through `downloadOrigins`. OAuth and `As-User` headers are stripped at every signed-capability hop, even on the same
origin. Only range/identity-encoding headers are carried forward. At most three redirects are followed, and repeated
URLs, fragments and URL credentials are rejected. Capability query strings are opaque secrets. APIs and mutations do not
follow redirects.

A full body requires HTTP 200; ranges require HTTP 206 and an exact finite `Content-Range` with a total equal to
selected-version metadata. EOF may clamp the requested end. Encoded representations and inconsistent declared sizes fail
before transfer. The byte owner detects actual extra bytes and truncated EOF while consuming. Receiving the first bytes
does not establish a complete receipt; cancelling early abandons that proof. Admission failures preserve independent
cleanup failures. The signal retires idle or active owned streams. Borrowed Fetch/token capabilities must honor abort;
the library cannot force a broken capability to settle.

`BoxPendingError.retryAfterSeconds` means content is not ready. The client does not sleep or retry. These reads trust
the authenticated provider and signed capability, not a cryptographic range proof. Native SHA-1 metadata is a legacy
checksum; it does not authenticate an untrusted file or offer modern collision resistance.

## Upload a finite file

The materialized `upload(target, bytes, options?)` API separates creation from replacement:

```ts
import { BoxClient } from "@okikio/opfs/box";

export async function save(
  files: BoxClient,
  folderId: string,
  name: string,
  bytes: Uint8Array,
  signal: AbortSignal,
) {
  return await files.upload({ kind: "create", folderId, name }, bytes, { signal });
}
```

Replacement uses `{ kind: "replace", fileId, ifMatch? }`. This profile also requires `options.name` for multipart
replacement: the pinned Box schema requires the name field although its prose calls it optional. It is an explicit
native filename/rename choice, not a name inferred from an ID. Pass the known name to retain it. Chunked replacement
does not require a name.

The client snapshots native byte extents, the target and options before OAuth awaits, then appends multipart
`attributes` before `file`. Default byte admission is 8 MiB, with a configurable local ceiling of 64 MiB. This ceiling
is an implementation bound, not a Box account upload entitlement. The owned snapshot, Blob/FormData storage and
transport serialization can each add memory. Callers must synchronize shared memory while supplying input; copying does
not provide an atomic snapshot against concurrent mutation.

Creation requires HTTP 201; replacement requires HTTP 200. Exactly one final file receipt must match size, the existing
file ID for replacement, and the requested parent when returned for creation. An optional `options.sha1` checks the
final whole-file checksum. Box unusually names its optional SHA-1 request header `Content-MD5`; the client follows that
documented wire contract. The checksum is error detection, not an authenticity claim. `ifMatch` is passed as the native
opaque ETag value without inventing quoting or stronger semantics.

## Upload parts and commit explicitly

Use a session when the file cannot fit a single admitted request. The caller owns the fixed source, exclusive session
use, its whole-file SHA-1 checksum and any durable checkpoint. Box chooses a part size; this profile refuses a session
whose part size exceeds `maxBytes` or whose part count exceeds `maxParts`. Provider minimum file size and account
permissions are enforced by Box.

```ts
import { BoxClient } from "@okikio/opfs/box";
import type { BoxPartType } from "@okikio/opfs/box";

export async function uploadParts(
  files: BoxClient,
  folderId: string,
  name: string,
  size: number,
  wholeFileSha1: string,
  readPart: (at: number, length: number) => Promise<Uint8Array>,
  subtle: Pick<SubtleCrypto, "digest">,
  signal: AbortSignal,
) {
  const upload = await files.startUpload({ kind: "create", folderId, name }, size, signal);
  const parts: BoxPartType[] = [];
  for (let at = 0; at < size; at += upload.partSize) {
    const bytes = await readPart(at, Math.min(upload.partSize, size - at));
    parts.push(await files.uploadPart(upload, at, bytes, { subtle, signal }));
  }
  // A pending result is returned to the application's scheduler, not hidden in
  // an automatic retry loop. Retain upload + parts to make that later attempt.
  return await files.commitUpload(upload, parts, { sha1: wholeFileSha1, signal });
}
```

`uploadPart()` snapshots the part and session before awaiting the explicitly borrowed `subtle.digest` capability. It
computes the part SHA-1, sends native `Digest` and `Content-Range` headers, and validates the returned part ID, offset,
size and checksum. Nonfinal parts must equal `partSize`; offsets align to it and the last part can be smaller. An
acknowledged part is not a file publication receipt or a contiguous-prefix claim. One full copied part and
WebCrypto/transport allocations are the relevant memory costs. This SHA-1 profile rejects sessions/part receipts
produced only with another hash.

`statusUpload()` reports `processedParts` as a count. It does not identify which extents exist. `partsPage()` exposes
native offset/limit/total positions; `listParts()` follows them within budgets, advances by returned limit and rejects
overlaps, duplicate IDs, malformed extents and a changing collection bound. Native positions can be sparse, so returned
entry count is not the next offset or proof that every source part is present. Recovery assumes exclusive session use;
there is no portable contiguous `UploadDestinationType` mapping.

`commitUpload()` snapshots and validates all part receipts before credentials, sorts by source offset and requires a
complete gap-free cover. Its `sha1` option is the checksum of the **entire fixed source**, supplied by the caller. It is
not the checksum of the last part or a concatenation of part hashes. Box requires this legacy whole-file SHA-1 `Digest`
for protocol compatibility. The client does not provide an unbounded or incremental whole-large-file hash engine in this
profile.

A commit has two distinct results:

- `{ complete: false, retryAfterSeconds }` comes only from HTTP 202 with bounded integer `Retry-After` seconds. The
  application may schedule another explicit commit attempt after that advice. No file receipt or completed checkpoint is
  implied.
- `{ complete: true, file }` requires HTTP 201 with exactly one validated file, matching full size, SHA-1 and target
  ID/parent conditions.

The primary Box upload guide documents 202 even though the current generated reference lists only 201. `abortUpload()`
explicitly cancels an upload session and requires HTTP 204. It neither deletes a published file nor proves what happened
after an ambiguous commit.

## Recover without guessing publication

`BoxPublicationError` means a dispatched mutation has no validated receipt: transport loss, server failure, a redirected
mutation or malformed successful body can produce it. Do not blindly repeat creation or part uploads. Inspect the same
session and its part receipts before deciding which extent is missing. A lost commit receipt remains unknown; a missing
session or a current file at the destination cannot attribute the earlier publication. Do not automatically abort after
an ambiguous commit. Explicit pending202 advice is different from a lost acknowledgement.

Known HTTP rejections remain `BoxError.status`; credential/admission errors before dispatch do not become unknown
outcomes. Every request is single-attempt, even when an injected request policy enables retries. The application owns
retry policy, delays, durable checkpoints and safe recovery. Cleanup failures can be retained alongside an acknowledged
response; they do not erase it.

## Limits and security boundary

| Bound                                  | Implemented policy                                    |
| -------------------------------------- | ----------------------------------------------------- |
| Finite upload/read bytes               | 8 MiB default, configurable to 64 MiB                 |
| Pages / entries                        | 1,000 / 100,000 default, ceilings 100,000 / 1,000,000 |
| Session parts                          | 10,000 default and ceiling                            |
| Native part page                       | At most 1,000 entries; offset at most 10,000          |
| Control JSON body                      | Shared 8 MiB safety bound                             |
| Capability/session URLs                | 16,384 characters                                     |
| Pending Retry-After                    | Integer seconds, 0 through 86,400                     |
| Download redirects / empty byte chunks | Three redirects / 16 consecutive empty chunks         |

The API/upload endpoints require HTTPS without URL credentials, query or fragment. `allowHttp:true` is an explicit
private-fixture policy. Signed download origins are separate from OAuth upload origins. Server-advertised session
endpoints must have an explicitly granted upload origin, an exact configured upload path and the same session ID; this
profile also requires all session endpoints to share one origin. `uploadOrigins` grants additional exact authorities
without broadening paths. Invalid endpoints fail before any follow-up token acquisition. Resumed session context is
subject to the same admission rules.

Keep session URLs and signed download queries private. Fixed error messages omit them and raw provider bodies. Foreign
transport/application errors retained as causes can contain other sensitive details; do not serialize those causes into
public logs.

This client does not implement Box collaboration/permissions changes, trash or permanent deletion,
export/representations, folder mutations, a filesystem adapter, SSH/runtime discovery, automatic polling, durable
orchestration or modern content authentication through SHA-1.

## Sources and verification limits

Protocol decisions use the
[immutable Box OpenAPI](https://github.com/box/box-openapi/blob/ab1f6b9e91c85057ee6c3b74cf7b9926a237f3b7/openapi.json),
retrieved with SHA-256 `6d1530ea42928345f9dea1d14ccda66863b0a1aa8062098eebb4666a7d2b5de4`, and the
[immutable pending-commit guide](https://github.com/box/developer.box.com/blob/3c63a08ade54f7d6dc779f9e505d198ae9d248e4/content/guides/uploads/chunked/commit-session.md),
SHA-256 `f1637ed74ce8bb3d98986839b1dae52eeca33561b4f119300f3346d6059a5867`. Current primary references cover
[downloads](https://developer.box.com/reference/get-files-id-content),
[marker listing](https://developer.box.com/reference/get-folders-id-items),
[part receipts](https://developer.box.com/reference/put-files-upload-sessions-id) and
[commits](https://developer.box.com/reference/post-files-upload-sessions-id-commit).

Focused tests use injected Fetch wire fixtures and fixed SHA-1/base64 vectors independently checked with Python hashlib.
They exercise native IDs, signed credential isolation, ranges/EOF and cleanup, multipart ownership, part gaps, session
authority, pending202/final201 and unknown mutations. Tiny session fixtures exercise protocol mechanics, not Box's
minimum-size acceptance. There is no live Box account or genuine Box server/emulator proof in this lane.
