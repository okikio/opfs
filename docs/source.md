# Read a stable byte object

Use a byte source when the operation needs one object rather than a directory or a writable filesystem. Archives and
resumable uploads can use the same public source contract. A plain stream remains a one-shot input; it does not become
seekable or replayable by wrapping it in an interface.

```ts
import { createGcsClient } from "@okikio/opfs/gcs";
import { budgetSource, createSourceBudget, openObjectSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

// The application supplies and refreshes this token. No environment is consulted.
export async function preview(bucket: string, key: string, token: () => Promise<string>) {
  const client = createGcsClient({ bucket, token });
  const ledger = createSourceBudget({ maxBytes: 32 * 1024 * 1024, maxRequests: 100 });
  const source = budgetSource(await openObjectSource(client, key), ledger);
  const archive = await openZip(source);
  const member = archive.entries.find((entry) => !entry.directory && !entry.encrypted);
  if (!member) return null;
  const result = await archive.read(member.id, {
    length: Math.min(4096, member.size),
    maxSourceBytes: 8 * 1024 * 1024,
    maxDecodedBytes: 16 * 1024 * 1024,
  });
  return { name: member.name, ...result, sourceWork: ledger.inspect() };
}
```

This function returns bytes and their checksum status. The application chooses a renderer and treats active content as
untrusted. A prefix does not establish a complete member's CRC. Unsupported compression/encryption and exhausted budgets
reject explicitly rather than extracting the whole archive or downloading a codec.

`ByteSourceType` has a safe-integer `size` and an exact `read(offset, length, { signal })` operation. Short reads
reject. Empty reads need no provider request. `StreamSourceType` describes a one-shot Web Stream and optional length
separately. Do not invent size, range or reopen capabilities for an unknown-length stream.

`createByteSource()` snapshots bytes; later input mutations cannot change the source. `createBlobSource()` borrows an
immutable Blob. Each read returns an owned array. A caller-supplied identity can support restart comparison, but it is
not a content hash computed by the library and must change when the input changes.

`openObjectSource()` borrows only `head`, `get`, `capabilities.rangeRead` and optional `identity`; both object clients
and object drivers fit this read-only contract without sharing their different limit metadata. It performs one HEAD and
binds later ranges to a native generation, immutable version ID or strong ETag. A changed current object either leaves a
provider-addressable old revision readable or rejects; it must not silently change the bytes under an existing index.
GCS generations remain decimal strings, separate from ETags; B2 file IDs use the opaque `version` kind. S3/Azure reject
other providers’ generation and version conditions before network work. A backend with no revision requires explicit
`assumeStable: true`; its `stability` is `caller`, not `provider`. Weak ETags cannot establish provider-bound stability.

Automatic replay identity includes the configured service and bucket/container namespace, object key, revision and size.
A third-party backend can supply its stable `identity`, or the caller can supply an explicit `namespace` when opening
it. Without either, the source omits `identity`: range inspection can still work, but a resumable transfer cannot safely
identify it. Matching ETags in two different buckets must never make them the same replay source.

The default maximum per-read allocation is 8 MiB. Increase `maxReadBytes` explicitly for a larger individual directory
or member request. `budgetSource()` shares physical extent/request admission across readers, including nested readers
that reuse it. Failed requests consume their reserved budget. This ledger does not measure hidden transport work in a
third-party implementation. Archive readers additionally accept a shared archive ledger for aggregate decoded/output
work across nested reads; codec-internal allocation remains the codec's responsibility. A 4 KiB output request may
require much more fetched, decoded or authenticated data.

Sources and clients are borrowed. Reading owns its response reader and retires it after completion, failure or abort; it
never disposes an injected client. The snapshot itself starts no background work. For independently authored sources,
use the [extension guide](extensions.md) and optional source conformance suite. See [archives](archive.md) for exact
container profiles and [transfer recovery](transfer.md) for checkpoint identity and exclusive session ownership.
