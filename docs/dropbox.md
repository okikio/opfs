# Read and upload Dropbox files

Use the native Dropbox client when an application already owns an OAuth token and account context. It reads metadata and
file bytes, lists direct children, and uploads stored files through single requests or sequential upload sessions. It
does not mount Dropbox as an OPFS filesystem.

This example reads one retained revision. The application supplies Fetch and OAuth; the library does not discover
accounts, refresh tokens or select scopes.

```ts
import { DropboxClient } from "@okikio/opfs/dropbox";

export async function preview(
  token: string,
  fileId: string,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string> {
  const files = new DropboxClient({ token: () => token, fetch });
  const metadata = await files.stat(fileId, signal);
  if (metadata.kind !== "file" || metadata.rev === undefined) {
    throw new TypeError("Select a stored file.");
  }
  // The native revision route avoids switching to a newly edited file between
  // separate preview reads. Dropbox still controls revision retention/access.
  const bytes = await files.read(`rev:${metadata.rev}`, {
    at: 0,
    length: 1024,
    signal,
  });
  return new TextDecoder().decode(bytes);
}
```

The application needs the relevant `files.metadata.read`, `files.content.read` or `files.content.write` scope. Team
tokens can also require team scopes. An explicit `namespaceId` sets `Dropbox-API-Path-Root`; `selectUser` sets
`Dropbox-API-Select-User`. These values and the token callback must describe the same account context for the lifetime
of a client and any retained cursors or sessions. Tokens may refresh within that context. Construct another client to
change context. No persistent replay identity is inferred from credentials.

## Native addresses and listing

`stat()` and downloads accept literal Dropbox paths, `id:...`, namespace paths (`ns:123/...`) and retained `rev:...`
read references. Writing accepts paths, IDs and namespace paths. The empty string is only the root listing address. This
client performs no path normalization or case folding. Dropbox owns those rules; optional returned display/lowercase
paths are metadata, not the identity of a portable filesystem entry. File IDs survive some path changes, while a path
can later identify another resource.

`listPage(path)` returns `{ entries, cursor, hasMore }`. `continuePage(cursor)` uses a native opaque cursor in the same
context. `list(path)` follows these pages with bounded page/entry counts, rejects continuation cycles and preserves
provider order. It does not deduplicate native changes or claim a snapshot. The initial listing requests direct children
without deleted entries. If the server returns a deleted change record, the decoder preserves its `deleted` kind instead
of inventing a file ID or byte size.

## Byte evidence and ownership

`download(path, options)` returns `{ file, bytes }`. The caller owns `bytes` after successful acquisition and must
consume it to EOF or cancel it. Aborting the supplied signal also retires an idle or active stream. Fetch/token
capabilities must honor abort; this client cannot force a broken foreign capability to settle.

A complete download requires HTTP 200. A requested range requires HTTP 206, an exact finite `Content-Range` and a total
equal to the returned file size. EOF can clamp the requested end. Encoded representations, mismatched IDs or revisions,
missing metadata and inconsistent declared lengths are rejected before transfer. The stream then checks actual bytes
against the admitted extent: extra bytes and premature EOF fail. This requires consuming to EOF; receiving the first
chunk alone does not establish complete receipt. Cancelling early explicitly abandons that proof. Admission and
cancellation failures are retained together when cleanup also fails.

`read()` accumulates a finite result within `maxBytes`. It refuses an extent whose response metadata exceeds that policy
before accumulating it. A zero length returns local empty bytes without object existence evidence or I/O; `download()`
requires a nonempty extent because it promises remote metadata. Reads starting beyond EOF retain the provider's HTTP
failure behavior. Stored-file downloads reject `is_downloadable:false`; exportable documents need a separate export API,
which this profile does not implement.

These are server-trusted bytes over the caller-selected authenticated channel. A range is not verified by the full-file
`contentHash`. No `ByteSourceType` or canonical filesystem projection is exposed in this slice.

## Check complete content

`contentHash(bytes, { subtle, maxBytes? })` implements Dropbox's hash: SHA-256 each 4 MiB block, concatenate the binary
block hashes, then SHA-256 that concatenation. This differs from hashing the file once. Empty input hashes an empty
concatenation. The cryptography capability is explicit; the function does not acquire a global crypto object.

```ts
import { contentHash } from "@okikio/opfs/dropbox";

export async function verify(
  bytes: Uint8Array,
  expectedHash: string,
  subtle: Pick<SubtleCrypto, "digest">,
): Promise<void> {
  if (await contentHash(bytes, { subtle }) !== expectedHash) {
    throw new Error("Dropbox content hash mismatch.");
  }
}
```

The function snapshots input before its first await. It retains that complete copy, a block copy of at most 4 MiB and 32
bytes per block, in addition to WebCrypto's internal allocations. Default input admission is 8 MiB; callers can raise it
to at most 150 MiB. It is deliberately a finite computation, not a streaming whole-large-file hash implementation.
Callers still own synchronization when supplying shared memory; copying does not provide an atomic concurrent snapshot.
Comparison proves bytes match an expected hash, not the authenticity of that expected value. Provider metadata may omit
the hash.

## Upload and recover

`upload({ path, mode }, bytes, { contentHash?, signal? })` uses explicit `add`, `overwrite` or `{ update: knownRev }`
behavior. Every commit sets `autorename:false` and `strict_conflict:true`. Revision mismatches, deleted update targets
and same-content conflicts therefore retain native strict conflict behavior. It is a provider revision condition, not an
HTTP ETag condition or a general transaction. Returned paths can differ in display/case normalization; receipts validate
target ID when one was requested, byte size, and the expected hash when supplied.

For a larger file, use sequential sessions:

```ts
import { DropboxClient } from "@okikio/opfs/dropbox";

export async function uploadParts(
  files: DropboxClient,
  path: string,
  parts: AsyncIterable<Uint8Array>,
  size: number,
  expectedWholeFileHash: string,
  signal: AbortSignal,
) {
  let session = await files.startUpload(new Uint8Array(), signal);
  for await (const part of parts) {
    session = await files.appendUpload(session, part, signal);
    // An application that needs restart recovery persists this private session
    // only after acknowledging each extent, alongside its fixed source identity.
  }
  return await files.finishUpload(session, { path, mode: "add" }, {
    size,
    contentHash: expectedWholeFileHash,
    signal,
  });
}
```

The caller owns the immutable source, exclusive use of its session and durable checkpoint storage. `startUpload()`
returns `{ sessionId, offset }`. `appendUpload()` returns the next acknowledged offset only after HTTP 200/null.
`finishUpload()` sends an empty body and requires the cursor offset to equal the expected full size. Its returned file
metadata is the publication receipt. The optional expected whole-file hash is checked against that receipt; it is not
sent as the final call's `content_hash`, which would describe only that call's bytes. Native session append/start
currently do not compute per-call hashes. A successful append alone does not prove published file content.

A known `DropboxError` can expose `tag` and `correctOffset` from `incorrect_offset`. This is native buffer-offset
evidence useful after a lost append acknowledgement; it is not a file receipt. The client does not resend, reconcile or
advance a caller checkpoint automatically. There is no independent session status/abort endpoint in this implemented
profile and no invented `UploadDestinationType` mapping. An application can explicitly send an empty append at its known
cursor to obtain a success or native offset conflict; this does not recover a committed file after a lost finish
receipt.

`DropboxPublicationError` means a dispatched mutation lacks a validated acknowledgement, including transport loss,
server errors, or malformed final receipts. Do not blindly create, append or finish again. In particular, a session
reported closed/not found does not prove what was committed. Looking up the destination path does not attribute an
earlier ambiguous overwrite. All requests use one attempt even if the injected request policy allows retries. Known HTTP
rejections remain `DropboxError`; they still need operation-specific recovery, not a generic retry loop.
Credential/admission failures occur before dispatch and do not become unknown publication errors.

## Limits and credential boundary

| Limit                                                                           | Owner                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| 150 MiB per content upload request                                              | Dropbox protocol                               |
| 2,199,019,061,248 bytes per session file; session lifetime up to 7 days         | Dropbox protocol                               |
| 8 MiB finite read/upload default; configurable through `maxBytes` up to 150 MiB | Application policy with implementation ceiling |
| 8 MiB JSON/error response; 64 KiB argument/result header                        | Implementation safety                          |
| 1,000 pages and 100,000 entries by default; ceilings 100,000 and 1,000,000      | Traversal policy with implementation ceilings  |
| 16 consecutive empty body chunks                                                | Implementation no-progress bound               |

Finite read collection can retain chunks plus an output copy. Uploads retain an owned request snapshot. Streamed
downloads do not buffer the complete file; the transport still owns its own chunk/queue allocations. A custom Fetch
capability must implement normal Web stream ownership and cancellation.

Only the configured RPC/content endpoints receive OAuth headers. Endpoints require HTTPS without URL credentials, query
or fragment; `allowHttp:true` is an explicit private-fixture policy. Every request rejects redirects rather than
forwarding headers to a Location target. API arguments stay in the JSON body or ASCII-escaped header, never the URL.
Error messages exclude URLs, session IDs and server bodies. Foreign errors retained as `cause` can contain
application/transport details; avoid serializing them into public logs. Session IDs and cursors must be kept private.

This profile does not implement concurrent sessions, batch/async jobs, temporary capability links, exports,
copy/move/delete, a filesystem adapter or a durable transfer engine. Those require their own native semantics and
evidence.

## Protocol sources and proof

The
[Dropbox schema at immutable commit
8bd09da79bbeeb69d9f68992d849ebac8daf54f0](https://github.com/dropbox/dropbox-api-spec/blob/8bd09da79bbeeb69d9f68992d849ebac8daf54f0/files.stone)
was retrieved with SHA-256 `3fe39757c02939243be7eac560cade99deaf242e957eb1cfa6f14b189ba0f4a3`. Current primary
documentation explains
[request formats](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/request-response-formats),
[ASCII JSON argument encoding](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/json-encoding),
[content hashes](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash) and
[sequential upload sessions](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/upload-session-start).

Focused tests use injected Fetch protocol fixtures, plus fixed hash vectors produced independently with Python hashlib.
They cover wire authority, revisions/ranges, body retirement, malformed acknowledgements, byte ownership and session
offset conflicts. They do not connect to Dropbox or certify every account, team namespace, retention policy or server
behavior. No maintained genuine local Dropbox service was used.
