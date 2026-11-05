# Google Cloud Storage

Use the native GCS JSON API client when the application owns a bucket and an access-token policy. The protocol client
works independently; its driver adds inspection and limits, and the object adapter supplies filesystem paths.

This complete Deno application reads an explicitly supplied short-lived token. The library never discovers credentials
or reads the environment itself. Run it only against a bucket and prefix you own; the example creates a file.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createGcsClient } from "@okikio/opfs/gcs";
import { createGcsAdapter } from "@okikio/opfs/adapter/gcs";

const bucket = Deno.env.get("GCS_BUCKET");
const token = Deno.env.get("GCS_TOKEN");
if (!bucket || !token) throw new Error("Set GCS_BUCKET and GCS_TOKEN explicitly.");

const client = createGcsClient({ bucket, token });
await using filesystem = createFileSystem(createGcsAdapter(client, { prefix: "opfs-example/" }));
await filesystem.writeFile("/notes.txt", "Archive inspection starts here.");
console.log(await filesystem.readText("/notes.txt"));
```

Supply `token: async () => refreshedToken` through your authentication integration when refresh is needed. The callback
runs immediately before each request attempt. The application owns ADC, federation, service-account signing and token
caching. An omitted token supports public access or a controlled emulator; it does not discover a local Google account.
Browser use also needs bucket CORS policy for the actual operations and response headers.

## Revisions and byte ranges

`head()` returns `revision: { kind: "generation", value }` and `version` as opaque decimal strings. The ETag stays in
`etag`; it is not a substitute generation. A replacement uses the admitted generation through `ifGenerationMatch`.
`ifNoneMatch: "*"` selects `ifGenerationMatch=0` for create-only publication. Other ETag write conditions are refused
before transport. The object adapter uses the generation for read-modify-write replacement, preserving competing writers
rather than blindly overwriting them.

For a stable range, obtain metadata and pass its generation explicitly:

```ts
const stat = await client.head("opfs-example/notes.txt");
if (stat === null || stat.revision === undefined) throw new Error("Object revision unavailable.");
const bytes = await client.get("opfs-example/notes.txt", {
  at: 0,
  length: Math.min(8, stat.size),
  revision: stat.revision,
});
console.log(new Uint8Array(await new Response(bytes).arrayBuffer()));
```

The generation selects the exact object version. A provider may no longer retain an old generation; reopen metadata
deliberately rather than silently switching versions. Ranges validate HTTP 206, Content-Range, reported generation and
body extent. Ignored ranges reject and cancel their response instead of downloading the complete object. A zero-length
range returns an empty stream without checking object existence.

Objects served with `Content-Encoding` or `x-goog-stored-content-encoding` other than identity are refused: Fetch can
transparently decode them and break stored-byte identity. Store compressed archive bytes with an appropriate content
type and without HTTP content encoding when exact archive offsets are needed. The returned stream is caller-owned;
consume or cancel it. Plain reads do not certify payload checksum or publisher identity.

## Upload sessions and recovery

`put()` uses a resumable session for both bytes and streams. Stream buffers default to 8 MiB and use bounded lookahead
to identify the final chunk. `chunkSize` must be a positive multiple of the provider's 256 KiB nonfinal-chunk rule.
Upstream producers can allocate larger chunks before the library sees them. The provider object limit is 5 TiB, distinct
from this buffering choice.

Ordinary `put()` is one attempt and does not persist recovery state. For recoverable uploads, create the session
explicitly and protect its URI as a bearer credential:

```ts
const payload = new Uint8Array([1, 2, 3]);
const session = await client.createUpload("opfs-example/recovered.bin", {
  size: payload.byteLength,
  ifNoneMatch: "*",
});
// Persist session, payload identity and exact replay bytes atomically in protected storage.
const remote = await client.queryUpload(session);
if (!remote.complete) {
  const result = await client.writeUpload(session, payload.subarray(remote.offset), {
    offset: remote.offset,
    total: payload.byteLength,
    final: true,
  });
  if (!result.complete) throw new Error("Upload remains incomplete; reconcile before continuing.");
  console.log(result.receipt.version);
}
```

Persist checkpoints only after acknowledged extents. A lost acknowledgement requires `queryUpload()` before
continuation; bytes sent are not bytes retained. The query returns either an incomplete confirmed offset or a complete
receipt parsed from that operation's response. Never substitute a later HEAD for attributable completion. Source
identity and bytes must remain unchanged, and only one writer may own a session. This low-level API does not supply
persistence, leases or process recovery by itself.

Nonfinal extent lengths must be 256 KiB multiples. The confirmed resume offset itself may be unaligned after
interruption. Final extents carry the complete total and may be shorter. Mutating operations are not blindly retried;
GET and explicit status queries can use the shared retry policy. A `GcsPublicationError` identifies an unknown
acknowledgement outcome, with its original cause preserved. An ordinary `GcsError` retains HTTP status and response.
Session URLs can remain in rich response/cause data, so do not dump error objects into public logs.

`cancelUpload()` explicitly discards the incomplete remote session. Aborting a current request or a failed convenience
`put()` does not imply cancellation of the provider session; abandoned state can remain until provider expiry.
Applications needing explicit cleanup or pause/resume must retain the session through the low-level API. Disposing a
filesystem releases its own resources and does not erase an uploaded object or revoke the borrowed token supplier.

For the [checkpoint transfer coordinator](transfer.md), `createGcsUploadDestination(client, session)` wraps a known-size
session without I/O. The application still supplies a stable replay source, protected atomic checkpoint storage and
exclusive session ownership. `complete` requires a GCS publication receipt; a full retained byte offset alone is not
completion. Configure transfer chunks as 256 KiB multiples except for the final chunk. Unknown-size streams remain on
the direct client route.

`copy()` implements the same-bucket rewrite protocol with bounded continuation requests and generation conditions.
`maxRewriteRequests` defaults to 1024; exceeding it does not prove publication. Cross-bucket copy, compose,
customer-supplied encryption keys, IAM management and signed URL generation are not implemented. TLS/provider encryption
is separate from client-side payload encryption.

The adapter maps HTTP absence, permission denial, contention and quota failures into the existing filesystem categories,
preserving the provider error as `cause`. HTTP 409/412 becomes `locked`; it does not automatically retry an append
against a changed object. Unknown publication remains distinguishable through the retained `GcsPublicationError` cause
instead of being reclassified as a safe contention retry.

## Verification and limits

`tests/gcs.test.ts` exercises deterministic wire behavior, malformed acknowledgements, revisions, range refusal, token
refresh, session offsets, streaming and response cleanup. `tests/gcs-provider.test.ts` runs actual HTTP against a
digest-pinned fake-gcs-server owned by Testcontainers with ephemeral ports and disposal. It covers basic CRUD, ranges,
generation conflicts, adapter append, empty markers and continuation from an acknowledged extent.

The pinned emulator incorrectly turns a status query into partial publication; that specific interoperability case is
explicitly skipped there. Deterministic tests retain the documented 308/Range status contract. No emulator result proves
Google IAM, CORS, durability, retention, expiration or actual process-loss recovery against GCS. A controlled
live-service lane remains required before advertising those claims. No performance result is asserted by this guide.

References: [GCS JSON objects](https://docs.cloud.google.com/storage/docs/json_api/v1/objects),
[resumable upload protocol](https://docs.cloud.google.com/storage/docs/performing-resumable-uploads),
[preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions),
[rewrite](https://docs.cloud.google.com/storage/docs/json_api/v1/objects/rewrite), and
[fake-gcs-server](https://github.com/fsouza/fake-gcs-server/tree/v1.56.1).
