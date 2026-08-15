Ecosystem integrations
======================

`@okikio/opfs` integrates with another storage ecosystem at the highest stable abstraction the application already owns. It does
not duplicate every provider driver from that ecosystem.

That rule gives two complementary directions:

```text
existing storage resource                existing OPFS filesystem
          |                                      |
          v                                      v
      adapter                                reverse driver
          |                                      |
          v                                      v
    FileSystemType                         KV / unstorage API
```

The forward path lets filesystem-shaped application code use another storage system. The reverse path lets another ecosystem
consume any backend already reachable through `FileSystemType`.

Bridge descriptors make asymmetry part of the contract
------------------------------------------------

`@okikio/opfs/bridge` groups the existing forward adapter and reverse driver for an ecosystem. It does not force every
integration to be symmetric.

| Bridge | ecosystem -> OPFS | OPFS -> ecosystem | Why the reverse side is absent when unsupported |
| --- | --- | --- | --- |
| `UnstorageBridge` | yes | yes | both stable shapes exist |
| `RxDbBridge` | yes | no | `RxStorage` also owns queries, conflicts, change streams, cleanup, and storage-instance semantics |
| `Db0Bridge` | yes | no | a filesystem is not a SQL query/dialect engine |
| `DrizzleBridge` | yes | no | a filesystem does not own Drizzle schema, dialect, or query-builder behavior |
| `KeyValueBridge` | no | yes | the generic reverse KV shape does not define persistence semantics needed to build an adapter |

`defineBridge()` validates that direction declarations agree with real constructors. An unsupported direction must include a
reason. Third-party integrations can therefore publish capability honestly without inventing a method that only works for a
small subset of the upstream contract.

Unstorage works in both directions without a provider explosion
---------------------------------------------------------------

The forward adapter accepts the high-level unstorage `Storage` contract:

```ts
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import { createFileSystem } from "@okikio/opfs";
import { createUnstorageAdapter } from "@okikio/opfs/adapter/unstorage";

const storage = createStorage({ driver: memoryDriver() });
const fileSystem = createFileSystem(createUnstorageAdapter(storage));
```

Unstorage remains responsible for its selected driver, mounts, provider SDKs, retry behavior, and provider-specific limits. The
OPFS adapter only uses the stable high-level operations it needs to persist records.

This is intentionally broader than maintaining separate OPFS adapters for every unstorage driver. Current unstorage drivers span
browser storage, Cloudflare, Azure, S3, Deno KV, filesystem, Redis, databases, blobs, HTTP, and other providers. Duplicating that
catalog here would create a second compatibility matrix that would drift from upstream.

The reverse direction is more powerful after the generic key-value driver:

```text
unstorage Storage
      |
      v
@okikio/opfs unstorage Driver
      |
      v
KeyValueDriverType
      |
      v
FileSystemType
      |
      +-- native OPFS
      +-- Node / Deno / Bun
      +-- S3 / Azure Blob
      +-- localStorage / IndexedDB / Cache
      +-- Deno KV / SQLite
      +-- RxDB / db0 / Drizzle / unstorage
      `-- custom adapter
```

`createKeyValueDriver()` owns the collision-safe filesystem mapping. `createUnstorageDriver()` only translates that contract to
unstorage's driver method names and `maxDepth` flag. Both reverse views retain `inspect()`, `plan()`, and `getMetrics()` from the
backing filesystem. An ecosystem caller can therefore reject a value above `maxFileBytes`, see when a streamed write would
buffer or partition, disable a native route on the filesystem, and observe the same counters without a second capability table.

The extra key directory is required because a KV store can contain both `foo` and `foo:bar`:

```text
foo      -> /key-foo/value
foo:bar  -> /key-foo/key-bar/value
```

A naive `:` to `/` conversion would try to make `/foo` both a file and a directory. The private `value` leaf removes that
conflict while reversible segment encoding keeps `%`, `~`, spaces, slashes inside a key segment, and other URI-sensitive text
distinct.

RxDB stays above RxStorage
--------------------------

RxDB already defines `RxStorage` as its storage-engine abstraction. An RxCollection adds document behavior, indexes, conflict
handling, and the selected RxStorage implementation.

`createRxDbAdapter()` therefore accepts an existing collection instead of implementing another RxStorage engine. The exported
`RxDbRecordJsonSchema` uses canonical `path` as the primary key and indexes `parent` for direct-child listing.

```text
RxDB application
      |
      v
RxCollection
      |
      +--> selected RxStorage
      |
      v
createRxDbAdapter()
      |
      v
FileSystemType
```

This keeps the adapter compatible with the collection regardless of whether the application selected memory, IndexedDB, OPFS,
filesystem, SQLite, remote, worker, or another RxStorage family. RxDB keeps ownership of replication, multi-instance behavior,
licensing, storage wrappers, and conflicts.

db0 and direct SQLite share the same SQL record model
------------------------------------------------------

`createDb0Adapter()` targets db0's high-level `Database` contract and its reported dialect. The SQL generation currently covers
SQLite, libSQL, PostgreSQL, and MySQL branches. It depends on database behavior rather than connector names, so a new db0
connector does not need a new OPFS adapter when it presents the same database contract.

`createSqliteAdapter()` is the focused direct SQLite path for applications that already own a small connected statement API. It
reuses the SQLite branch of the same SQL record contract instead of maintaining a second table layout and upsert implementation.

The default SQL table is `opfs_entries`. The path identity and parent path are stored separately so direct-child listing can use
a provider-appropriate index. The db0 path uses portable parameter placeholders and lets the db0 connector translate them where
its dialect requires a different native parameter shape.

Drizzle keeps schema ownership with the application
---------------------------------------------------

Drizzle spans several SQL dialects and runtime drivers. A universal OPFS-owned Drizzle table would either choose one dialect or
hide dialect-specific DDL details.

`createDrizzleAdapter()` therefore receives:

1. an already-connected Drizzle database;
2. a table built for that database dialect;
3. the required logical columns.

Required logical fields are:

```text
path
parent
name
kind
data
size
lastModified
mediaType
```

`path` must be unique or primary. `size` and `lastModified` must round-trip JavaScript safe integers. The bridge uses the common
select/insert/delete builder shape and keeps Drizzle an optional peer dependency.

Inside one `FileSystemType`, normal coordination serializes same-path mutations. Separate processes or hosts are not serialized
by an in-memory facade lock. A database-backed deployment that needs cross-process replacement atomicity must use transactions,
leases, advisory locks, or another mechanism provided by its actual database/driver.

S3-compatible providers are configured by capability, not brand guesses
------------------------------------------------------------------------

The direct S3 client is meant to work with AWS S3 and compatible XML/SigV4 services, but "S3-compatible" is not a promise that
all operations, preconditions, limits, checksums, or control-plane features are identical.

The client options deliberately separate the parameters that compatible services vary:

```text
endpoint
bucket
region
addressing: path | virtual
headers
copy: boolean
conditionalWrite: boolean
partSize
copyPartSize
concurrency
credentials
```

The safe rule is to read the selected provider's current primary documentation and enable only the capabilities it actually
implements for the operations used by the filesystem.

A few current examples show why this matters:

| Provider family | Current nuance that affects this client |
| --- | --- |
| AWS S3 | baseline SigV4, multipart upload, CopyObject, UploadPartCopy, conditional completion |
| Cloudflare R2 | S3-compatible endpoint with its own supported-operation set; `auto` is a documented region value |
| DigitalOcean Spaces | implements a documented subset of the S3 API and its own published object/multipart limits |
| Google Cloud Storage XML API | S3-compatible multipart exists, but documented multipart precondition behavior differs |
| Backblaze B2 S3 API | S3-compatible surface with its own unsupported/changed AWS control-plane features |

For a Google Cloud Storage XML multipart path that does not support the preconditions expected by optimistic object
read-modify-write, create the client with `conditionalWrite: false`. That does not make append/update magically atomic; it makes
the absence of that safety property explicit.

Cloudflare R2 and other services can also disable `copy` if their selected endpoint/path does not provide the server-side copy
contract expected by the adapter. The filesystem then falls back to the normal streamed/materialized copy path instead of
calling a native capability that was never real.

The S3 request escape hatch is intentional
-----------------------------------------

A filesystem does not need to model every S3 object or bucket feature. The direct client therefore exposes signed
`request(options)` in addition to `ObjectStoreType`.

Use the filesystem/object layer for portable file behavior. Use the lower-level request API when the application needs a
provider-specific control such as an object-lock header, tag operation, checksum policy, versioning call, or another S3 operation
whose semantics should not be flattened into a generic filesystem method.

The same principle applies to Azure Blob
----------------------------------------

Azure Blob has enough differences that the package implements a native Azure REST client rather than translating Azure through
an S3 compatibility layer.

`createAzureClient()` supports SAS, Microsoft Entra bearer tokens, Shared Key, and custom-header credentials. Its service version is explicit. Its streamed
writes use Azure block APIs, and its large server-side copies use Put Block From URL when synchronous Copy Blob From URL is too
small.

The object adapter above Azure is still the same `createObjectAdapter()` used by S3. The provider client owns Azure-specific
HTTP mechanics; the object adapter owns the file/directory translation.

Choose the integration that matches the resource you already own
-----------------------------------------------------------------

| Existing application resource | Preferred integration |
| --- | --- |
| browser OPFS root | `createOpfsAdapter()` or `openFileSystem()` |
| host directory | Node, Deno, or Bun adapter |
| unstorage `Storage` | `createUnstorageAdapter()` |
| RxDB collection | `createRxDbAdapter()` |
| db0 `Database` | `createDb0Adapter()` |
| connected SQLite statement API | `createSqliteAdapter()` |
| Drizzle database + table | `createDrizzleAdapter()` |
| Deno KV database | `createDenoKvAdapter()` |
| localStorage/sessionStorage-like Web Storage | `createLocalStorageAdapter()` |
| IndexedDB | `createIndexedDbAdapter()` / `openIndexedDbAdapter()` |
| Cache Storage `Cache` | `createCacheAdapter()` |
| S3-compatible endpoint | `createS3Client()` + `createS3Adapter()` |
| Azure Blob container | `createAzureClient()` + `createAzureAdapter()` |
| custom KV/document layer | `createRecordAdapter()` |
| custom object storage | `createObjectAdapter()` |
| any `FileSystemType` needed as KV | `createKeyValueDriver()` |
| any `FileSystemType` needed by unstorage | `createUnstorageDriver()` |

Adding an extra ecosystem layer only because this package already has an adapter for it usually makes the system harder to
reason about. Use the direct adapter/client/driver for the abstraction the application already owns, and use bridge descriptors
when code needs to inspect both directions as one integration.
