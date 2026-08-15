Adapter guide
=============

An adapter translates the package's canonical virtual filesystem operations into one concrete backend. The filesystem facade
owns filesystem semantics. The adapter owns backend mechanics.

That distinction lets the required backend contract stay small:

```text
stat        read one entry's metadata
readFile    read one file or range
writeFile   commit one materialized write
readDir     lazily list direct children
createDir   create exactly one directory
remove      remove one file or empty directory
```

The facade builds parent creation, recursive walking, recursive copy/remove, OPFS-shaped handles, write-command staging,
coordination, and normalized errors on top. A backend can add native operations when it can do better than the facade fallback.

```text
openReadStream    native streaming read
writeStream       native streaming for declared write modes
copy              native/server-side file copy
move              native rename/move
openWritableFile  long-lived asynchronous positional writes
openSyncFile      synchronous random access
```

`AdapterCapabilitiesType` must describe these native paths truthfully. `streamWriteModes` is a list rather than one boolean
because replacement, append, and update can have different backend costs. `nativeCopy` is separate from `nativeMove` because
object stores often copy efficiently but cannot rename an object atomically.

Adapters can also expose `limits` and `partition`. Limits are hard facts known by the configured backend, such as maximum file,
value, key, part, batch, or concurrency sizes. Missing fields mean unknown, not unlimited. Partition describes a durable physical
layout used when one logical file spans multiple provider values. These fields feed `FileSystemType.inspect()` and `plan()` but
do not change the required adapter method set.

Route-changing optimizations live on the facade, not inside capability flags. `optimizations.streamRead`, `streamWrite`,
`rangeRead`, `nativeCopy`, and `nativeMove` can force the safe fallback for differential testing or application policy. An adapter
should therefore implement the best native route it can and let the caller decide whether to use it.

Use `createFileSystem()` to put the public API over any adapter:

```ts
import { createFileSystem } from "@okikio/opfs";

const fileSystem = createFileSystem(adapter, {
  coordination: "auto",
  maxBufferedWriteBytes: 64 * 1024 * 1024,
});
```

The first-party adapters cover three different storage shapes
-------------------------------------------------------------

Native filesystems expose files and directories directly. Record stores expose values keyed by logical identity. Object stores
expose whole-object replacement, ranges, prefixes, and provider-side copy. Keeping those shapes separate is what prevents one
"universal" adapter from hiding important performance and consistency behavior.

| Public subpath | Backend | Translation layer |
| --- | --- | --- |
| `adapter/opfs` | browser OPFS | native filesystem |
| `adapter/node` | Node `fs` | native filesystem |
| `adapter/deno` | Deno filesystem | native filesystem |
| `adapter/bun` | Bun + Node-compatible fs | native filesystem |
| `adapter/memory` | in-memory map | records |
| `adapter/record` | custom value/document store | records |
| `adapter/localstorage` | Web Storage | records |
| `adapter/indexeddb` | IndexedDB | records |
| `adapter/cache` | Cache Storage | records |
| `adapter/deno-kv` | Deno KV | records |
| `adapter/sqlite` | connected SQLite | records through db0-compatible SQL |
| `adapter/unstorage` | unstorage `Storage` | records |
| `adapter/rxdb` | RxDB `RxCollection` | records |
| `adapter/db0` | db0 `Database` | records |
| `adapter/drizzle` | Drizzle database + table | records |
| `adapter/object` | custom object store | objects |
| `adapter/s3` | direct S3/S3-compatible client | objects |
| `adapter/azure` | direct Azure Blob client | objects |

Native browser and host filesystems
-----------------------------------

`openFileSystem()` is the convenience path for native browser OPFS:

```ts
import { openFileSystem } from "@okikio/opfs";

const fileSystem = await openFileSystem();
```

The explicit form is useful when the caller already owns the native root:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createOpfsAdapter } from "@okikio/opfs/adapter/opfs";

const root = await navigator.storage.getDirectory();
const fileSystem = createFileSystem(createOpfsAdapter(root));
```

The OPFS adapter reports synchronous access only when an actual file handle exposes `createSyncAccessHandle()`. The package
does not infer the feature from a browser name or from "worker" alone.

Node, Deno, and Bun map virtual `/` below one configured host directory:

```ts
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const adapter = createNodeAdapter({ root: "./data" });
```

The host path mapper resolves the configured root once and rejects every virtual path whose resolved host path would leave that
root. Host adapters expose ranges, streams, native copy, native move, and synchronous random access when the underlying runtime
provides them.

Bun uses Bun's file APIs where they provide a direct read/write path and uses Bun's Node-compatible filesystem surface for the
operations whose exact semantics already live there. Importing the Bun adapter does not require the `Bun` global until adapter
creation.

Record stores start small and can add byte lanes
-----------------------------------------------

The required `RecordStoreType` stays intentionally small:

```ts
interface RecordStoreType {
  get(path): Promise<RecordType | null>;
  set(record): Promise<void>;
  delete(path): Promise<void>;
  list(parent): AsyncIterableIterator<RecordListType>;
}
```

This complete-record path is enough for memory, Web Storage, RxDB, unstorage, and SQL-backed integrations. File records use
base64 because the same durable shape must round-trip through JSON-oriented stores. Base64 is a compatibility format, not a claim
that every record backend is suitable for large binaries.

A store with a more capable physical layout can add optional lanes without implementing the filesystem facade again:

```text
stat             metadata without file body
readFile         direct/range byte read
openReadStream   backpressure-preserving logical stream
writeFile        selected direct materialized modes
writeStream      selected direct stream modes
```

`RecordStoreCapabilitiesType` declares `rangeRead`, `streamRead`, `writeModes`, and `streamWriteModes`. The record adapter turns
only those declared lanes into native adapter capabilities. If a lane is absent, the complete-record implementation remains the
fallback. This is the extension point for third-party KV/document stores that can do better than one large JSON-shaped record.

`createMemoryAdapter()` uses the complete-record path for deterministic tests and temporary data.

`createLocalStorageAdapter(storage)` accepts an injected Web Storage object. Web Storage is synchronous, quota-limited, and
string-only underneath the adapter. It does not claim a portable maximum item size or native streaming.

`openIndexedDbAdapter()` can open its own IndexedDB database, while `createIndexedDbAdapter(database)` can borrow an existing
one. The store is keyed by canonical `path` and indexed by `parent` so direct directory listing stays indexed. Ownership remains
with the caller unless the adapter option explicitly transfers it.

`createCacheAdapter(cache)` stores records in an injected `Cache` using synthetic request URLs. No network request is made. Cache
Storage quota, eviction, and persistence policy remain browser decisions.

Deno KV uses an explicit partition layout
-----------------------------------------

`createDenoKvAdapter(kv)` accepts an already-open Deno KV database. Deno KV has a 2 KiB serialized key limit and a 64 KiB
serialized value limit, so treating one filesystem file as one KV value would create a small and surprising file ceiling. The
default adapter policy is `partition: "auto"`.

```text
logical entry key
  [prefix, "entry", parentPath, name]

list one parent
  prefix [prefix, "entry", parentPath]
  -> direct children only

small file
  entry -> normal FileRecord

large file
  [prefix, "part", canonicalPath, generation, 0]
  [prefix, "part", canonicalPath, generation, 1]
  ...
  entry -> manifest committed last
```

Default decoded sizes are 32 KiB inline and 48 KiB per raw binary part. `maxParts` defaults to 10,000 and part I/O concurrency
to 8. Callers can set `partition: "never" | "auto" | "always"`, `inlineBytes`, `partBytes`, `maxParts`, and `concurrency`. The
adapter exposes these as inspectable limits/partition policy.

Manifest-last publication is the visibility rule. A reader sees the previous complete generation until all new parts exist and
the new manifest is stored. A process crash before the manifest commit can leave unreachable new-generation parts. That is a
storage leak, not a partially visible logical file. The adapter does not currently run a global orphan scavenger because doing so
would require a separate ownership/retention policy.

Large-file hot paths avoid generic reconstruction:

- `stat()` reads the entry/manifest only.
- `list()` uses the direct-parent key prefix, so it reads direct-child metadata only and never scans descendant entry keys or body parts.
- range reads fetch only overlapping parts.
- stream reads load one physical part at a time under consumer backpressure.
- materialized append/update builds a new generation part-by-part and never joins the previous large file into one record.
- streamed replacement writes parts with bounded concurrency and publishes the manifest last.

Append/update still copy the untouched logical bytes into a new immutable generation because Deno KV has no provider-side range
copy primitive. The copy is bounded by `partBytes` and `concurrency`; the tradeoff is provider I/O proportional to the resulting
file size rather than JavaScript memory proportional to that size. Streamed append/update is not advertised as a direct lane,
so an incoming stream must still fit under the facade `maxBufferedWriteBytes` ceiling before this bounded patch path runs.

`partition: "never"` disables the partitioned streaming write lane. A large streamed write then follows the facade's normal
bounded materialization rule and fails `too-large` once it exceeds `maxBufferedWriteBytes`. This gives applications a deliberate
way to reject the changed durable layout. Deno KV remains an unstable Deno API, so real integration tests run with
`--unstable-kv`.

`createSqliteAdapter(database)` accepts a small connected SQLite statement interface. It deliberately reuses the same SQL record
mapping used by the SQLite branch of `createDb0Adapter()` instead of creating a second schema and upsert implementation.

Existing ecosystem adapters stay above the abstraction the application already owns:

```text
unstorage Storage   -> RecordStoreType
RxDB RxCollection   -> RecordStoreType
db0 Database        -> RecordStoreType
Drizzle DB + table  -> RecordStoreType
```

Bridge descriptors group these forward adapters with reverse drivers when a real reverse contract exists. They do not fabricate
a reverse direction for RxDB, db0, or Drizzle. See [ecosystems.md](./ecosystems.md).

Object stores keep object-store semantics visible
-------------------------------------------------

`ObjectStoreType` is the common client contract for S3, Azure Blob, and custom object storage. It models the operations those
systems actually have:

```text
HEAD exact key
GET full object or range
PUT replacement
DELETE exact key
LIST prefix + delimiter
COPY inside provider, when supported
```

Its metadata includes byte size, media type, last modification time, ETag, provider version identity, and user metadata. Its
capabilities state whether range read, streaming read, streaming replacement, provider-side copy, and conditional writes are
really available.

`createObjectAdapter()` maps that model to filesystem paths. A normal file maps to one object key. An empty directory maps to a
trailing-slash marker with private metadata, and prefix listing recognizes both those markers and foreign provider prefixes.

```text
/photos             -> photos/
/photos/a.jpg       -> photos/a.jpg
/photos/2026/b.jpg  -> photos/2026/b.jpg
```

A raw object namespace can physically contain both `mixed` and `mixed/child`. The filesystem view resolves the exact `mixed`
object as the file because `stat("/mixed")` does the same. That rule keeps read, stat, and write behavior internally consistent
when foreign object layouts do not obey filesystem restrictions.

Replacement can stream when the provider supports it. Append and update cannot normally mutate object bytes in place, so the
adapter performs:

```text
HEAD current object
      |
      v
GET current bytes
      |
      v
apply append/update in memory
      |
      v
conditional PUT replacement
```

When conditional writes are enabled and an existing object does not return an ETag, the adapter fails rather than quietly
performing an unsafe read-modify-write. When the file is being created through append/update, it uses create-only semantics where
the provider exposes them.

The S3 client implements the protocol directly
-----------------------------------------------

`createS3Client()` uses Web Fetch, Web Crypto, `@std/encoding`, and `@std/xml`. It does not depend on the AWS SDK.

```ts
import { createS3Client } from "@okikio/opfs/s3";
import { createS3Adapter } from "@okikio/opfs/adapter/s3";

const client = createS3Client({
  endpoint: "https://s3.us-east-1.amazonaws.com",
  bucket: "example",
  region: "us-east-1",
  credentials: async () => await credentials.get(),
  addressing: "path",
  concurrency: 4,
});

const adapter = createS3Adapter(client, { prefix: "app" });
```

Signature Version 4 includes the request authority in canonical headers. Browser Fetch forbids application code from setting
the `Host` header, so the client signs `url.host` while leaving actual Host or `:authority` transmission to Fetch. Static browser
credentials are usually a security mistake; browser deployments should use appropriately scoped short-lived credentials or a
trusted service design.

A streamed replacement uses multipart upload with bounded part concurrency:

```text
ReadableStream
      |
      v
fixed-size chunker
      |
      +--> UploadPart 1 --+
      +--> UploadPart 2 --+--> CompleteMultipartUpload
      +--> UploadPart N --+
                 |
            failed operation
                 |
                 `--> wait active parts -> AbortMultipartUpload
```

The client applies `If-Match` and `If-None-Match` to multipart completion, which is the commit operation that current S3 exposes
for these preconditions. It waits for already-started parts before aborting so a late part cannot arrive after the abort request.

S3 has two failure cases that are easy to miss. `CompleteMultipartUpload` can return HTTP 200 and then stream an XML error, and
`CopyObject` can also return an embedded error in HTTP 200. The client parses and rejects both bodies.

`CopyObject` has a 5 GB source limit. Larger copies use `UploadPartCopy` ranges into a multipart destination. The copy part size
increases when necessary to stay within S3's 10,000-part limit. Source bytes stay inside the object provider rather than crossing
JavaScript memory or network twice.

The filesystem copy contract intentionally preserves file bytes, media type, and user metadata where the client can do so. It
does not claim to clone every S3 control-plane property such as ACLs, tags, object-lock state, or every checksum policy. Use the
low-level signed `client.request()` API when the S3 object itself, rather than its filesystem view, is the thing being managed.

S3-compatible does not mean behavior-identical. Configure the client from the selected provider's current contract:

- Cloudflare R2 commonly uses the `auto` region and has provider-specific supported/unsupported S3 operations.
- DigitalOcean Spaces implements a compatible subset rather than every AWS S3 feature.
- Google Cloud Storage's XML multipart API documents different precondition behavior; disable `conditionalWrite` when the
  selected path does not provide the safety contract expected by the object adapter.
- Other compatible providers should be treated the same way: verify endpoint, signing region, addressing, copy, conditional
  requests, multipart limits, checksums, and error behavior before enabling a capability flag.

The Azure Blob client keeps Azure's own model
--------------------------------------------

`createAzureClient()` also uses Web Fetch and `@std/xml`, but it does not force Azure Blob through an S3-shaped client.

```ts
import { createAzureClient } from "@okikio/opfs/azure";
import { createAzureAdapter } from "@okikio/opfs/adapter/azure";

const client = createAzureClient({
  endpoint: "https://account.blob.core.windows.net",
  container: "example",
  credential: { kind: "sas", token },
});

const adapter = createAzureAdapter(client, { prefix: "app" });
```

Credentials can be SAS, refreshable bearer tokens, or a custom header callback. The service version is explicit and defaults to
the version pinned by this package. Block-size limits are selected from that service version rather than one timeless constant.

Streamed replacements use Put Block followed by Put Block List. Azure has no abort call for uncommitted blocks, so a failure
waits for already-started requests, leaves the old committed blob untouched, and allows Azure to garbage-collect the uncommitted
blocks later.

Copy Blob From URL has a smaller synchronous copy limit. Larger files use Put Block From URL ranges followed by Put Block List.
This keeps large copies server-side without hiding a size cliff behind `nativeCopy: true`.

Custom adapters must preserve the same invariants
-------------------------------------------------

Use `defineAdapter()` for a backend that already exposes filesystem-like primitives:

```ts
import { defineAdapter } from "@okikio/opfs/adapter";

export const adapter = defineAdapter({
  name: "provider",
  capabilities: {
    read: true,
    write: true,
    streamRead: false,
    streamWriteModes: [],
    rangeRead: false,
    nativeCopy: false,
    nativeMove: false,
    positionalWrite: false,
    syncAccess: false,
  },
  async stat(path) { /* ... */ },
  async readFile(path, options) { /* ... */ },
  async writeFile(path, bytes, options) { /* ... */ },
  async *readDir(path, options) { /* direct children only */ },
  async createDir(path, options) { /* parent already exists */ },
  async remove(path, options) { /* file or empty directory */ },
});
```

Every adapter receives canonical virtual paths. It must respect requested ranges and write modes. It must yield direct children,
not recursive descendants, from `readDir()`. It must not configure logging, inspect process environment, or open unrelated
resources during module evaluation.

Injected resources are borrowed by default. Transfer ownership only through an explicit option such as `disposeDatabase`,
`disposeStore`, or `disposeAdapter`. A filesystem closing must never surprise another subsystem by disposing infrastructure that
it still owns.
