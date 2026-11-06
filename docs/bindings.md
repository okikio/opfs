# Cloudflare runtime bindings

Pass bindings from your Worker entrypoint to the library. The application owns the binding declaration, permissions,
namespace or bucket selection, and lifetime. Modules do not read `env`, discover credentials, or load Cloudflare
packages. For example, this function writes and reads a file through an injected R2 bucket:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createR2Client } from "@okikio/opfs/r2";
import type { R2BindingType } from "@okikio/opfs/r2";
import { createR2Adapter } from "@okikio/opfs/adapter/r2";

export async function note(bucket: R2BindingType): Promise<Uint8Array> {
  const client = createR2Client(bucket, {
    identity: "application-owned-account/bucket",
    maxUploadBytes: 8 * 1024 * 1024,
    maxReadBytes: 8 * 1024 * 1024,
  });
  const fs = createFileSystem(createR2Adapter(client), { coordination: "local" });
  try {
    await fs.writeFile("/note.txt", "hello");
    return await fs.readFile("/note.txt");
  } finally {
    await fs[Symbol.asyncDispose]();
  }
}
```

The library borrows the bucket. Disposing the filesystem does not delete it or close an injected service. The identity
is an application assertion identifying the account and bucket, not an inferred security guarantee. Native clients and
drivers remain independently usable when a filesystem projection is unnecessary.

## R2 reads, conditions and publication

`createR2Client()` exposes object mechanics; `createR2Driver()` or `createR2DriverFromClient()` adds inspectable storage
limits; `createR2Adapter()` translates the client through that driver to filesystem operations. These use the
[Workers binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/), independently of the S3
endpoint and its signing client.

Metadata retains the native upload `version` separately from `etag` and `{ kind: "etag", value: httpEtag }`. Only the
quoted HTTP ETag can condition native reads and writes. A version string is not a downloadable revision selector in this
profile. Failed conditional GET returns metadata without a body; failed conditional PUT returns `null`. Both become
`R2Error` with code `locked`, translated to a filesystem error by the adapter. A missing GET becomes `not-found`.
Conditional deletion is unsupported and rejects before invoking the binding. No conditional delete or multipart safety
is inferred from conditional upload support.

`get(key, { at, length, revision, signal })` asks the binding for an exact native range. The receipt must describe that
range, allowing its end to clamp to EOF. Returned chunks are checked against the admitted extent and `maxChunkBytes`
(default 1 MiB); EOF must match the promised extent. `maxReadBytes` limits each returned read, defaulting to 64 MiB. A
zero-length read is local and proves neither existence nor revision. The consumer owns draining or cancelling a returned
stream. Aborting its signal cancels a pending body read. Before a binding promise settles, cancellation cannot interrupt
the native call; a subsequently acquired body is cancelled before rejection. Binding bytes are stored object bytes;
there is no Fetch transport decoding layer in this path.

Uploads accept materialized `Uint8Array` values, copying native byte extents after admission. The hard implementation
ceiling is 64 MiB; `maxUploadBytes` can lower it. This is separate from
[R2's larger provider limits](https://developers.cloudflare.com/r2/platform/limits/) and does not limit the size of an
existing object that can be read in bounded ranges. This profile deliberately omits streaming writes: R2 requires
streams with a native known length, and an ordinary application `ReadableStream` does not provide that evidence. Copy,
multipart and version selection are also unsupported here. Custom metadata is admitted under a conservative 8192-byte
JSON control budget. Listing requests both native metadata families, preserves opaque cursors even through empty pages,
and bounds pages to 1000 entries including delimited prefixes.

PUT success requires a valid matching receipt, including admitted size, metadata and media type. A native rejection or
malformed success receipt becomes `R2PublicationError` with `outcome: "unknown"`. No write is automatically replayed. A
native `null` conditional receipt is a known failure. A dispatched mutation is not cancelled retroactively: an
acknowledged receipt remains successful even if the caller aborts while the native promise is settling. Applications
must reconcile uncertain publication before retrying. R2 filesystem append/update uses the generic object's ETag-bound
read/replace protocol; local coordination alone does not serialize other deployments.

## Workers KV owns a different layout and consistency contract

Reserve a prefix exclusively for this library's versioned layout. Do not point it at existing arbitrary KV records:

```ts
import { createCloudflareKvDriver } from "@okikio/opfs/driver/cloudflare-kv";
import type { CloudflareKvBindingType } from "@okikio/opfs/driver/cloudflare-kv";

export async function save(namespace: CloudflareKvBindingType): Promise<void> {
  const driver = createCloudflareKvDriver(namespace, {
    prefix: "my-application/files-v1/",
    maxReadBytes: 2 * 1024 * 1024,
    maxUploadBytes: 2 * 1024 * 1024,
    cacheTtl: 30,
  });
  await driver.put("note.txt", new TextEncoder().encode("hello"));
  const page = await driver.listKeys({ prefix: "" });
  for (const key of page.keys) console.log(key.key, key.size, key.expiration);
}
```

One physical key is the reserved prefix followed literally by the logical object key. One native `put` stores raw binary
bytes and associated strict JSON metadata `{ opfs: 1, key, size, mediaType?, metadata }`. There are no base64 trees,
separate index records or cross-key transactions. The metadata includes the exact logical key; absent, malformed,
foreign-version or copied-to-another-key envelopes reject rather than becoming filesystem objects. Reservation is a
caller ownership requirement. Inspecting a record cannot establish ownership or prevent a concurrent foreign writer, and
this driver cannot implement create-only or compare-and-swap checks.

The provider's [standard KV value and metadata limits](https://developers.cloudflare.com/kv/platform/limits/) are 25 MiB
and 1024 JSON bytes respectively. The envelope consumes some of that metadata budget. Physical keys are bounded to 512
UTF-8 bytes including the reserved prefix. The prefix must end in `/` and is bounded to 256 bytes. Invalid Unicode is
rejected instead of being lossily encoded. `maxReadBytes` and `maxUploadBytes` lower the whole-value policies; neither
can exceed 25 MiB. `maxChunkBytes` defaults to 1 MiB. These are standard Workers KV APIs; KV Instant's different layout
and API are unsupported.

`getWithMetadata({ type: "stream" })` acquires one native value and its associated envelope. The driver validates the
metadata before collecting bytes, cancels immediately when the declared extent exceeds the read budget, and checks every
native chunk and final size. A requested range is sliced from that bounded full-value buffer. It does not reduce native
transfer volume and is not advertised as native range or streaming-read support. A caller abort cancels a blocked body
read. `head` cancels the acquired body without collecting it and reports the associated metadata's size; it does not
prove that the bytes were read. Binding calls themselves have no cancellation parameter.

KV [observations are eventual](https://developers.cloudflare.com/kv/concepts/how-kv-works/), including missing values,
metadata and listings. An acknowledged write does not establish subsequent read visibility, authoritative absence,
directory ownership, a snapshot, or cross-region ordering. No ETag or revision is invented. Explicit revision reads and
conditional writes/deletes reject before native IO. Filesystem append/update and directory operations remain cooperative
read/replace operations with those limitations; use a different backend when concurrent atomic mutation is required.

`createCloudflareKvAdapter(namespace, options, projection?)` uses the generic object projection. Directory markers are
zero-byte values with the same envelope and directory metadata, not a second storage engine. `expirationTtl` applies to
all writes including those markers; it must be at least 60 seconds and defaults to no expiration. Expiring a marker does
not expire its children. `cacheTtl` must be at least 30 seconds when supplied. Native
[listing](https://developers.cloudflare.com/kv/api/list-keys/) preserves `expiration` through `listKeys()`, while
portable object listing omits that provider-specific fact. Continue every returned cursor, including after an empty
page. A native page cannot establish complete current directory membership. Failed PUT or DELETE becomes
`CloudflareKvPublicationError` with `outcome: "unknown"`; it is not automatically replayed.

## Evidence and limits

`tests/r2.test.ts` and `tests/cloudflare-kv.test.ts` use authored structural binding fixtures. They check admission,
actual documented receipt shapes, cancellation, rejected conditions, byte extent checks, reserved-layout collisions,
empty-page cursor continuation, TTL forwarding, directory metadata and unknown publication classification. These tests
are protocol-contract evidence, not independent Workers execution, deployed service conformance or latency observations.
No Cloudflare package, remote account or production credentials are needed for them. Real Worker/binding execution and
live concurrent-writer behavior remain unverified by this slice.
