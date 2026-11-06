# Firebase Storage objects

Read and publish objects through Firebase Security Rules without installing a production SDK:

```ts
import { FirebaseClient } from "@okikio/opfs/firebase";

// Call this from your application with its selected bucket and current ID token.
export async function publishNote(bucket: string, idToken: string): Promise<string> {
  const client = new FirebaseClient({ bucket, credentials: () => ({ idToken }) });
  const bytes = new TextEncoder().encode("hello Firebase");
  const receipt = await client.upload("notes/hello.txt", bytes, {
    contentType: "text/plain",
    customMetadata: { purpose: "example" },
  });
  console.log(receipt.name, receipt.size, receipt.generation);
  const preview = await client.read("notes/hello.txt", { at: 0, length: 5 });
  return new TextDecoder().decode(preview);
}
```

The caller supplies a bucket such as `your-project.firebasestorage.app` and an existing Firebase ID token. Longer-lived
clients should use a callback that asks the application's authentication owner for a fresh token. This library does not
discover or initialize a Firebase application. An absent `credentials` callback makes anonymous requests, still subject
to deployed Rules. The API defaults to `https://firebasestorage.googleapis.com/v0/`. An explicit `endpoint` and
`allowHttp: true` select a local emulator; environment variables never select credentials or production targets.

## Authentication and paths

This is a native Firebase client, separate from [`GcsClient`](gcs.md). Firebase ID tokens use the header
`Authorization: Firebase <ID token>`. App Check tokens use `X-Firebase-AppCheck`; optional `appId` supplies
`X-Firebase-GMPID`. These values do not become GCS IAM OAuth credentials. The caller's credential callback receives a
detached admitted URL and the operation signal. The callback owns whether the same account remains selected across
operations. Cookies and referrer context are omitted, every redirect is refused, and no mutation is retried
automatically.

Object names are literal Unicode strings with a 1,024 UTF-8 byte limit. Slashes, dot segments inside names and `%` are
encoded once as part of the complete object identifier. Standalone `.` and `..` names are refused because the URL parser
would reinterpret those complete path segments. This client does not normalize names into filesystem paths or create
directory resources. NUL and malformed Unicode are refused before I/O. Firebase's delimiter listing can omit names that
its SDK does not support, including repeated slashes and trailing slash objects. A successful listing therefore does not
prove that all GCS objects in the backing bucket have been enumerated.

`stat()` returns validated bucket/name/size plus canonical decimal `generation` and `metageneration` strings. These can
exceed JavaScript's precise integer range; they are not ETags. This initial profile does not claim conditional
generation writes, version-bound reads, or an immutable `ByteSource`. `updateMetadata()` updates the current object;
`deleteObject()` deletes the current named object. No OPFS driver or adapter is supplied because those native operations
do not establish the canonical filesystem's concurrency and one-entry semantics.

## Read, preview and list

`download(name, { at, length, signal })` returns `{ metadata, bytes, length, evidence: "server-trusted" }`. The caller
owns the readable stream and must consume it to EOF or await cancellation. Ranges require HTTP 206, a finite matching
`Content-Range`, identity encoding and exact actual byte count. Ignored ranges, extra bytes and truncation fail.
Ordinary ranges may end at EOF. Metadata and content requests are separate: an equal-size overwrite between them remains
possible, so this is neither immutable revision evidence nor a digest proof.

`read()` materializes a selection with a default 8 MiB policy; `maxBytes` can raise or lower it up to the
implementation's 64 MiB `FIREBASE_BUFFER_BYTES` ceiling. It preflights size before opening content, rejects changed
extents and allocates one result array. A zero-length `read()` performs no remote operation and proves no existence.
`download()` refuses a zero-length selection. Whole downloads stream without a whole-object allocation. Native transport
buffering and consumer retention are additional costs.

`listPage(prefix, { pageToken, limit, signal })` uses literal prefix and `/` delimiter. Include a final slash when
asking for the immediate children of a virtual folder, such as `"notes/"`. It returns item names and prefix names
separately, with an optional continuation token. The page limit is 1–1,000. `list()` yields pages incrementally with
defaults of 1,000 pages and 100,000 entries; configurable safety ceilings are 100,000 pages and 1,000,000 entries.
Repeated tokens, foreign buckets, repeated entries and out-of-prefix names fail. Pages do not form a snapshot during
concurrent mutations. Listing requires Firebase Rules version 2 and a rule that allows `list`, separately from `get`
when configured that way.

`getDownloadLink()` explicitly exposes an optional native download-token URL. Treat its entire value as a secret: it is
a bearer capability, distinct from the Rules-authenticated `read()` and `download()` paths. The client never silently
switches a denied Rules read to this capability, and it never fetches a returned token URL or forwards authentication to
it. Revocation, retention and safe display of that URL belong to the application.

## Upload and resume

`upload()` copies a materialized byte view before awaiting credentials. The default upload policy is 8 MiB, configurable
through the same `maxBytes` ceiling of 64 MiB. Its multipart envelope needs additional memory for metadata and another
payload copy. A copy of concurrently modified shared memory is not an atomic snapshot; the caller must synchronize
access. Writable metadata is bounded to 64 KiB of JSON characters, with bounded individual fields; MIME header injection
and collisions with the fixed multipart boundary are refused. Custom metadata admits at most 128 own entries,
1,024-character keys, 8,192-character values and 65,536 total key/value characters before copying. Prototype-sensitive
keys (`__proto__`, `constructor`, `prototype`) are refused in JSON and custom maps. A receipt must match bucket, name
and complete size and contain valid generation fields. It is server evidence, not an independently calculated content
digest. Concurrent writes can replace that object immediately afterward.

Firebase's resumable upload protocol uses `X-Goog-Upload-*` commands, not the GCS client's `Content-Range` sessions:

```ts
import { FirebaseClient } from "@okikio/opfs/firebase";
import type { FirebaseSessionType, FirebaseUploadType } from "@okikio/opfs/firebase";

export async function submitResumable(
  client: FirebaseClient,
  session: FirebaseSessionType,
  bytes: Uint8Array,
): Promise<FirebaseUploadType> {
  const status = await client.statusUpload(session);
  // A nonzero received extent cannot be attributed to this new source here.
  if (status.state === "active" && status.offset === 0) {
    return await client.writeUpload(session, 0, bytes, { finalize: true });
  }
  return status;
}
```

First create a session with `client.startUpload(name, bytes.length)` and retain it before calling this function. The
example accepts that caller-owned session, so it remains available for reconciliation if status or upload throws. It
returns the native result for inspection and sends one bounded final chunk only when the acknowledged offset is zero.
Larger sources must submit aligned nonfinal chunks and reconcile offsets explicitly. The caller must keep the supplied
bytes unchanged until the function finishes querying its session and reaches the client's chunk copy.

`FirebaseSessionType` contains a secret URL plus bucket, literal name and fixed safe-integer total size. Persist it only
under application-controlled secret storage. Every operation captures and validates the URL's exact API origin, bucket
route and selected name before acquiring credentials. Only the native upload query fields are admitted. There is no
cross-origin credential forwarding or caller-selected arbitrary API route.

The caller must exclusively own the session and an unchanged source. `writeUpload()` copies each submitted chunk before
awaits and requires explicit `finalize`. Nonfinal chunks and their starting offsets must align to 256 KiB
(`FIREBASE_CHUNK_BYTES`). Each copied chunk uses the configured `maxBytes` budget. A final chunk may be smaller, and an
empty final command supports zero-byte files or an already acknowledged complete extent.

The results deliberately distinguish three states:

| State       | Evidence and recovery                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`    | Native acknowledgment gives a received offset, even when that offset equals total size. Publication has not been established.                                                            |
| `final`     | `statusUpload()` received native final session status and complete offset. This result has no object metadata receipt.                                                                   |
| `published` | A final upload response supplied matching complete object metadata, including generation. This is the response's receipt, not proof that the current path still selects that generation. |

After an ambiguous write, explicitly call `statusUpload()` before deciding what to do. Do not resend an extent blindly.
A final status cannot be upgraded into a full receipt by reading the current object's metadata: another writer may have
replaced it. For that reason this profile does not expose a generic transfer destination that would erase the
distinction. `cancelUpload()` explicitly cancels the native session and does not promise to delete an already published
object. Source immutability, checkpoint storage, source identity and application recovery are caller-owned.

Every mutation that was dispatched but did not deliver a validated acknowledgment throws `FirebasePublicationError` with
`outcome: "unknown"`, including HTTP errors, malformed receipts or cleanup failure. This is a conservative recovery
classification, not a claim that a rejected request changed storage. Before dispatch, input, credential and abort errors
retain their original identity. `FirebaseError.status` reports sanitized HTTP status for reads and appears as a cause
for unknown mutations. Own URL and JSON parser errors omit secret inputs, but arbitrary injected Fetch/authentication
errors can themselves contain secrets, including in `cause`. Applications must redact foreign errors before logging
them.

## Sources and verification limits

Protocol research used the official Firebase SDK at immutable commit
[`1ffc994f68f272f0cea12387a588fffe4c590066`](https://github.com/firebase/firebase-js-sdk/tree/1ffc994f68f272f0cea12387a588fffe4c590066/packages/storage/src/implementation),
retrieved on 2026-11-05. SHA-256 hashes of the unmodified source bytes:

| File          | SHA-256                                                            |
| ------------- | ------------------------------------------------------------------ |
| `requests.ts` | `00515778d08aac49c015b81ee6275a7540e7a4c307c7dd5bfac0b58a165966e7` |
| `request.ts`  | `0e68040975f5fe87be70717724c39ee028b4939c93a9639db6267cb7d7f43380` |
| `metadata.ts` | `c058c3dcea93531526b3ad416a336ca31fe166f9a3e1c21bf5f4c7442b03212e` |
| `location.ts` | `3478b2477de08bc5bd45f64de88c8d40532a0e188c9d44e14cae0e09ebd1a119` |

The official [download guide](https://firebase.google.com/docs/storage/web/download-files),
[list guide](https://firebase.google.com/docs/storage/web/list-files),
[Rules guide](https://firebase.google.com/docs/storage/security) and
[emulator contract](https://firebase.google.com/docs/emulator-suite/connect_storage) explain the corresponding public
boundaries. These pages are mutable documentation; the source commit above pins the inspected wire implementation.

Authored protocol tests cover malformed responses, bounds, extent finality, cancellation admission, literal names,
credential boundaries, copied inputs, unknown mutation outcomes and distinct resumable receipts. The separate provider
fixture builds the official CLI 15.35.0 and official SDK 13.2.0 inside a Testcontainers-owned container, with pinned
native Node/JRE image indexes and verified primary tarball integrity. The Rules runtime 1.1.3 JAR has SHA-256
`0cd52db6f6271d62078f805220706377c849220b73bd68aa27078d977df9c900`, matching the CLI's published artifact metadata. The
fixture's npm test-tool transitive dependencies resolve during image construction; they are not a production import or a
fully frozen transitive dependency graph. Provider execution requires Docker, image/registry download access and Node's
existing testcontainers dependency; no host Firebase login, fixed host port or global SDK installation is used.

The CLI release source is pinned at
[`a1752da3d225af0a44a33f32cfa78ded6b550dca`](https://github.com/firebase/firebase-tools/tree/a1752da3d225af0a44a33f32cfa78ded6b550dca/src/emulator/storage).
The published CLI's `lib/emulator/storage/apis/firebase.js` has SHA-256
`502279c0bdfa86c3a7373963b0b3c909454dd8571f7685f21179732b549719e6`; its `lib/emulator/storage/upload.js` has SHA-256
`a11c8110f3a5f99b0cc6b0199cde14a95d181c96f2c749ed21bd2f79053cc3bc`. These sources explain the emulator's empty
content-coding list and HTTP 200 cancellation acknowledgment without a status header. A real content coding still fails
exact byte reads. Authenticated Rules tests use explicit unsigned emulator-only tokens and the official SDK's
`mockUserToken`; those tokens are not valid production authentication.

The emulator does not simulate Cloud IAM, production App Check enforcement, bucket configuration, retention or every GCS
API. Its Rules and SDK interoperability evidence must not be read as production IAM/authentication conformance or a live
Firebase deployment test. No benchmark, SDK-equivalence certification or complete GCS feature claim is made.
