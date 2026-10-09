# Drivers and adapters

## Purpose

A driver owns backend-native storage. An adapter translates that driver into the small canonical filesystem primitive
contract. Keeping those roles separate lets applications use a driver directly, inspect real provider limits, and
measure adapter/facade overhead independently.

```text
backend/native API
      |
    driver
      |
    adapter
      |
FileSystemType
```

Use the convenience adapters for normal application code. Use explicit drivers when you need backend planning, physical
metrics, provider-specific operations, or a custom translation.

## First-party matrix

| Storage                  | Driver                | Adapter                | Native family |
| ------------------------ | --------------------- | ---------------------- | ------------- |
| browser OPFS             | `driver/opfs`         | `adapter/opfs`         | file          |
| Node filesystem          | `driver/node`         | `adapter/node`         | file          |
| Deno filesystem          | `driver/deno`         | `adapter/deno`         | file          |
| Bun filesystem           | `driver/bun`          | `adapter/bun`          | file          |
| memory                   | `driver/memory`       | `adapter/memory`       | record        |
| Deno KV                  | `driver/deno-kv`      | `adapter/deno-kv`      | record        |
| localStorage             | `driver/localstorage` | `adapter/localstorage` | record        |
| IndexedDB                | `driver/indexeddb`    | `adapter/indexeddb`    | record        |
| Cache Storage            | `driver/cache`        | `adapter/cache`        | record        |
| SQLite rows              | `driver/sqlite`       | `adapter/sqlite`       | record        |
| unstorage Storage        | `driver/unstorage`    | `adapter/unstorage`    | record        |
| RxDB collection          | `driver/rxdb`         | `adapter/rxdb`         | record        |
| db0 Database             | `driver/db0`          | `adapter/db0`          | record        |
| Drizzle database + table | `driver/drizzle`      | `adapter/drizzle`      | record        |
| S3                       | `driver/s3`           | `adapter/s3`           | object        |
| Azure Blob               | `driver/azure`        | `adapter/azure`        | object        |

Reusable family translators:

```text
driver/file   -> adapter/file
driver/record -> adapter/record
driver/object -> adapter/object
```

## File drivers

`FileDriverType` preserves real file-like operations. Required primitives are metadata, materialized read/write,
direct-child listing, one-directory creation, and single-entry removal. Optional direct operations include streams,
copy, move, positional files, and synchronous random access.

A third-party file driver can be created with `defineFileDriver()`:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createFileAdapter } from "@okikio/opfs/adapter/file";
import { defineFileDriver } from "@okikio/opfs/driver/file";

const driver = defineFileDriver(backend, {
  name: "my-files",
  capabilities: {
    read: true,
    write: true,
    streamRead: true,
    streamWriteModes: ["replace"],
    rangeRead: true,
    nativeCopy: false,
    nativeMove: false,
    positionalWrite: false,
    syncAccess: false,
  },
});

const fileSystem = createFileSystem(createFileAdapter(driver));
```

The backend must implement every capability it advertises. The adapter does not fabricate a native method from a flag.

### Browser OPFS

`createOpfsDriver(root)` owns native browser handles. `createOpfsAdapter(driver)` is the explicit translation. The
convenience `openFileSystem()` acquires `navigator.storage.getDirectory()`, creates the OPFS driver and adapter, then
creates the facade.

The driver retains the native root for advanced browser interop. Sync access is advertised only when the actual file
handle exposes the required method in the current realm.

### Node

`createNodeDriver({ root })` maps virtual `/` below one host directory. The host-path mapper rejects escape from that
root.

Node exposes:

- materialized and streaming reads;
- ranged reads;
- materialized and streaming writes;
- native file copy;
- native rename/move;
- asynchronous positional files;
- synchronous random access and flush.

Node built-ins resolve only when the explicit Node driver is created/imported. The root module does not import Node
runtime code.

### Deno

`createDenoDriver({ root })` uses Deno file APIs for persistence and `@std/path` only for the host-root mapper. It
supports the same major file routes as the Node driver where Deno provides the native primitive.

The driver requires filesystem permissions chosen by the host application. It does not request broad permissions itself.

### Bun

`createBunDriver({ root })` uses `Bun.file()` and `Bun.write()` where they improve the direct read/replace path, then
delegates operations that need stronger host-filesystem semantics to the Node-compatible file driver.

The Bun global is resolved lazily during driver creation. Importing the module in Node or Deno does not require Bun.

Materialized replacements use `Bun.write()`. Streamed writes use one Node-compatible file descriptor with bounded reads
and partial-write handling. This lane also settles empty streams and cancels stalled producers; `Bun.write(Response)`
can remain pending for an all-empty source in Bun 1.3.14.

## Record drivers

`RecordDriverType` is the native contract for value/document/database persistence.

Required logical operations:

```ts
interface RecordBackendType {
  get(path): Promise<RecordType | null>;
  set(record): Promise<void>;
  delete(path): Promise<void>;
  list(parent): AsyncIterableIterator<RecordListType>;
}
```

Optional byte lanes can avoid the generic base64 fallback:

```text
stat
readFile
openReadStream
writeFile
writeStream
```

Record capability metadata also identifies:

```text
replacement   atomic | best-effort
binary        native binary storage available
transactions  driver can use provider transactions inside its own native operations
```

A custom record driver uses `defineRecordDriver()` and then `createRecordAdapter()`.

The generic record adapter does not claim native streaming. If the driver does not provide `writeStream()`, the facade
can materialize an input only under `maxBufferedWriteBytes`.

`transactions: true` is deliberately narrower than "every filesystem write mode is transactional." Generic `append` and
`update` first read the current record and later replace it. Those two steps are not one backend transaction unless the
driver exposes that mode through a native `writeFile()` or `writeStream()` lane. A second process, tab, or client can
therefore race the generic fallback even when the underlying database supports transactions. Deno KV's native
partitioned write modes and object-store ETag conditions are examples of stronger routes that close this gap explicitly.

### Memory

The memory driver is deterministic and dependency-free. It is useful for tests, examples, and temporary state. It is not
durable storage.

### Deno KV

The Deno KV driver has a provider-aware partition layout. Important policy options are:

```text
partition     auto | always | never
partBytes     decoded bytes per raw part
inlineBytes   decoded body budget for one inline record
maxParts      logical-file part ceiling
concurrency   bounded physical part I/O
```

`partBytes` and `inlineBytes` are intentionally smaller than Deno KV's serialized value ceiling. The provider limit
applies after serialization, so accepting the full provider number as decoded application bytes would be unsafe.

The driver planner also evaluates the concrete path against a conservative serialized-key estimate before provider I/O.

`createDenoKvAdapter()` retains `adapter.driver: DenoKvDriverType`, including explicit `collect()`, `probe()` and
`maintenance`. V3 generation state owns part writes, manifest publication, reader pins and reclamation. A collector
checks an eligible state with zero admitted pins and claims its version before deletion. Zero retirement grace retains
live writers/readers. A paused reader can expire and must reopen; immutable bytes do not imply indefinite read
retention.

The default namespace is `okikio-opfs:v3`. Legacy logical entries require a quiescent export/import to a fresh prefix.
Configured writer/reader leases, reader and retry bounds, per-pass scan/deletion budgets, returned continuations and
optional aggregate partition retention admission are described in [storage ownership](storage.md). Ordinary operations
never start a background collection scan. `readOnly` blocks logical changes and collection while private reader leases
still require mutations. `inspect()` remains pure; `probe()` performs live I/O.

### localStorage

The localStorage driver maps canonical records into a private key prefix. It inherits Web Storage's synchronous
underlying API, but the package presents the normal asynchronous driver contract to keep the storage stack composable.
Directory listing snapshots matching key strings before yielding because deletions shift live Web Storage indices.
Bodies remain lazy. Recursive traversal still scans the storage area and inherits external writer/eviction races.

Applications should treat browser quota as dynamic. The driver does not invent a stable quota number.

### IndexedDB

The IndexedDB driver borrows or owns an injected database according to options. It uses an object store and a parent
index for direct-child listing. Replace, append, and update run through one readwrite transaction, so independent
browser owners using the same object store do not lose an append/update through the generic record adapter's split
read/replace sequence. The application remains responsible for database versioning/upgrades outside the driver unless
ownership is explicitly transferred.

### Cache Storage

The Cache driver stores records under private request URLs. Cache Storage is a record/value persistence mechanism here,
not an HTTP cache policy abstraction. The driver only interprets entries in its private namespace. Direct-child listing
starts from `cache.keys()` and inspects matching records, so repeated recursive traversal is substantially more
expensive than an indexed parent lookup. Do not treat Cache Storage as equivalent to IndexedDB for directory-heavy
workloads.

### unstorage

`createUnstorageDriver(storage)` consumes the high-level unstorage `Storage` object. This deliberately sits above
whichever unstorage provider driver the application selected.

Records use flat escaped canonical-path keys so a parent record does not block its children on an upstream filesystem
driver. Existing hierarchical record keys remain readable and appear in directory listings. New replacements take
precedence over old records, and removal clears both layouts. Directory listing scans the reserved namespace because
upstream filesystem depth limits count physical key directories differently from virtual filesystem parents.

Use `bridge/unstorage` for the opposite direction, where an existing `FileSystemType` must satisfy unstorage's Driver
contract.

### RxDB

`createRxDbDriver(collection)` targets `RxCollection`, not `RxStorage`. RxDB keeps responsibility for its selected
RxStorage, conflict mechanics, wrappers, replication, multi-instance behavior, and licensing.

The package exports `RxDbRecordJsonSchema` for the collection used by this integration. `path` is the primary key and
`parent` is indexed for direct-child listing.

### db0

`createDb0Driver(database)` targets the db0 `Database` contract and its reported dialect. The current SQL branches are
SQLite, libSQL, PostgreSQL, and MySQL.

The driver owns its filesystem-record table only when configured to initialize it. The injected database is borrowed
unless `disposeDatabase` is true.

### Drizzle

`createDrizzleDriver({ database, table })` accepts a caller-owned connected Drizzle database and a caller-owned table
shape. Drizzle is not one SQL dialect, so this generic driver does not own DDL or migrations.

Required logical columns are:

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

The portable replacement route is delete then insert, so the generic driver reports best-effort replacement rather than
claiming cross-process atomicity. A dialect-specific future driver can expose stronger transaction/upsert/binary
behavior.

### SQLite rows

`createSqliteDriver(database)` stores filesystem rows inside an already connected SQLite database. This is the
**database-backed filesystem** direction.

It is not a SQLite VFS and does not make SQLite store its database file on `FileSystemType`. See `ecosystems.md` for
that opposite direction.

## Object drivers

`ObjectDriverType` preserves object storage concepts required for efficient translation:

```text
stat object
get bytes/range
put bytes/stream
list prefix
remove object
native copy when available
```

An object driver can also report object-specific capability details, provider limits, continuation behavior,
partition/upload policy, and physical metrics.

Filesystem semantics can amplify provider requests. A single logical write can require file and directory
classification, parent validation, and the final PUT, so object-backed facade operations can issue several HEAD/LIST
requests before the data request. This is a known translation cost, not hidden native filesystem behavior. Use the
provider benchmark staircase to measure client, driver, adapter, and facade cost separately before changing validation
or consistency rules.

### S3

The S3 client owns REST, SigV4, request policy, multipart operations, copy, listing, and protocol errors.

`createS3Driver(client)` adds backend capability/limit/optimization inspection. `createS3Adapter(driver)` translates
object keys and directory prefixes into filesystem primitives.

The client optimizations include independently controllable delayed multipart promotion and derived signing-key caching.
See `s3.md`.

### Azure Blob

The Azure client owns Blob REST, authentication, block upload, server-side copy, listing, and provider errors.

`createAzureDriver(client)` adds backend inspection. `createAzureAdapter(driver)` supplies filesystem translation. Block
upload and server copy are independently disableable. Azure metadata is validated before provider I/O, and the shared
object adapter uses the Azure-compatible `okikio_opfs_kind` key for private directory markers. See `azure.md`.

## Adapter contract

`AdapterType` always references the driver it translates:

```ts
interface AdapterType {
  readonly name: string;
  readonly driver: DriverType;
  readonly capabilities: AdapterCapabilitiesType;
  // filesystem primitives...
}
```

`AdapterCapabilitiesType` describes native adapter routes, not every public filesystem operation.

```text
read
write
streamRead
streamWriteModes
rangeRead
nativeCopy
nativeMove
positionalWrite
syncAccess
```

The facade can still emulate operations. `FileSystemType.inspect().support` is the authority for the effective route
after adapter capabilities and facade optimization policy are composed.

Adapters may retain compact `limits` or `partition` summaries for translation diagnostics. Detailed backend limits and
their provenance live on the driver.

## Cancellation

Every async backend method that accepts `AbortSignal` checks it before expensive work and between bounded chunks. A
failed or aborted stream write cancels the upstream producer when practical.

Provider cleanup can outlive the caller signal. Protocol drivers/clients use a separate bounded cleanup signal when an
already aborted caller signal would make cleanup impossible.

## Ownership

Injected resources are borrowed by default.

Examples of explicit ownership transfer:

```text
disposeDatabase
disposeStorage
disposeDriver
disposeAdapter
```

A convenience adapter that creates a driver internally transfers ownership of that newly created driver to the adapter.
A caller that creates a driver explicitly can choose whether the adapter should dispose it. A driver exposes backend
disposal only when its own construction options transferred backend ownership; disposing an adapter therefore cannot
close a resource that the driver only borrowed.

`driver.inspect().ownership` reports that relationship as `none`, `borrowed`, or `owned`. `driver.inspect().provides`
reports the stable backend operations or capabilities available on the configured driver. Higher layers can therefore
explain backend ownership and breadth without inferring either from adapter flags.

A configured record driver can also be read-only. In that mode `driver.capabilities.write` is false, write primitives
are not exposed, and direct `set()`/`delete()` calls fail before backend mutation. The adapter reflects the same state
instead of relying on adapter-only policy.

## Import safety

Runtime and provider code stays behind explicit subpaths. Importing the package root does not:

- import Node/Bun/Deno-only modules;
- resolve credentials;
- open a database;
- connect to a network endpoint;
- configure global logging;
- start worker/process resources.

## Extension checklist

Before adding a driver/adapter, verify:

1. The driver is independently meaningful without `FileSystemType`.
2. Provider requirements and known limits are structured and attributed.
3. Unknown limits stay unknown rather than being treated as unlimited.
4. Observable optimizations can be disabled.
5. The driver planner can reject known bad inputs before I/O.
6. Every advertised direct operation has a real implementation.
7. Large work has explicit byte/part/concurrency/retry bounds.
8. Resource ownership is explicit.
9. The adapter contains translation, not duplicated provider behavior.
10. Tests exercise the driver directly and through the adapter/facade.
11. Benchmarks include the backend/client baseline and each added layer.

AWS Mountpoint and Azure BlobFuse can expose object storage through the native Node file driver. Run
`deno task test:filesystem-clients` to build the pinned ARM64 Linux fixture and mount both clients inside an isolated
Docker container. The task uses SeaweedFS and Azurite with development credentials, creates no host mounts, and releases
its containers and network. It requires a Docker engine that permits FUSE in a privileged container. The fixture uses
Mountpoint 1.24.0, BlobFuse 2.5.5, and Node 24.21.0; the vendor download URLs are pinned in
`tests/provider/Dockerfile.fuse`.

The fixture and mounted-client benchmark select the same explicit [host profile](host.md) for the configured mount mode.
Strong copy/move is a documented negative contract on these modes, checked before parents or staging effects. Explicit
best-effort copying retains an independent exact-byte positive oracle. Historical unprofiled native failures remain
diagnostic evidence; they are not accepted as successful publication.

The mounted-client corpus compares exact bytes through raw Node operations, the file driver, the adapter, and the
facade. It also covers ranges, Unicode names, empty files, streamed creation, concurrent writers, missing paths, and a
stalled producer abort followed by path reuse. These tests describe the mounted filesystem's behavior. They do not give
an object filesystem POSIX capabilities: Mountpoint rejects append with `EPERM`, and removing its temporary directory
can also return `EPERM`. BlobFuse's cache and upload configuration controls when other clients observe writes. Native
file writes can expose partial changes before close; use an object adapter's staged writes when that distinction
matters.

To benchmark the same real mounts after correctness passes, run `OPFS_FUSE_BENCH=1 deno task test:filesystem-clients`
after building the image. The fixture runs the existing 256 KiB raw-client, driver, adapter, and facade lanes inside the
client container and emits Mitata JSON in its benchmark phase.

`deno task test:linux` also runs the canonical Bun 1.3.14 portable and native filesystem corpus in the official
`oven/bun:1.3.14` Linux image. Each runtime container reads the repository through a read-only bind and runs without
network access after its image and dependencies are available.

## Raw HTTP body admission

Low-level `request()` admits genuine raw `ArrayBuffer` bodies across realms through their native range. A detached
buffer rejects before credentials or dispatch; a genuine empty buffer remains valid. Fixed ordinary backing with this
realm's native prototype and no own keys stays borrowed: keep bytes valid and unchanged and add no backing properties or
prototype changes until settlement. Resizable, shared, foreign, custom-prototype or own-metadata backing receives a
clean fixed copy before asynchronous hash/signing/authorization work and retries; every attempt keeps that captured
body. Hosts can inspect ordinary backing properties, including `detached`, during extraction, so native branding alone
does not protect wire bytes. A raw buffer copy costs its native length; a view copy costs its admitted range. Both
require caller cooperation during admission. Raw `SharedArrayBuffer` remains outside `BodyInit`; shared-backed views
have their separate fixed wire conversion. This rule does not snapshot every BodyInit variant or claim native Request
directly supports bare resizable buffers.

Low-level S3 and Azure `client.request()` bodies can be one-shot native streams. Default Fetch dispatch first checks
that the current native `Request` preserves a private stream body instead of converting it to text. The lazy check has
no network or caller-input effects. An unsupported default rejects with `TypeError` before credentials, source reads or
dispatch; it leaves the stream with its caller. Constructor support still does not prove service acceptance, CORS policy
or network request-stream support.

Use public `put()` to upload streams as bounded byte parts across browser runtimes. A custom `fetch` implementation can
instead consume the raw stream through its own transport; that injected implementation owns its stream-byte support and
physical reader retirement. Raw streams remain one-shot even when a service returns a retryable status. This guard does
not buffer unknown-size raw bodies or weaken the Azure Shared Key requirement for an explicit raw-stream Content-Length.

## Object directory scans and admission

`createObjectAdapter`, `createS3Adapter`, and `createAzureAdapter` accept `maxListPages` in their mapping options. The
positive safe-integer default is 10,000 pages per directory scan. This is an application safety policy, not a provider
maximum. Increase it explicitly for a namespace that legitimately needs more pages. An exhausted scan fails with
`too-large`; a repeated continuation cursor or an out-of-prefix result fails with `invalid-operation`. Neither becomes
an absent path or an empty directory. Existence checks stop on positive evidence; empty-directory removal and negative
lookups require exhaustion. Empty pages and marker-only pages can still have a continuation. Listing remains lazy and
returning from its iterator stops additional page requests. Provider errors retain their identity at the adapter
boundary and their `cause` through facade normalization. Cancellation is checked around page acquisition and before
mutation.

Conditional object backends apply fresh destination ETags to both materialized and streamed replacements. A fresh absent
object uses `ifNoneMatch: "*"`. Missing ETag evidence on an existing conditional object rejects before producer work.
This catches an exact-object writer racing admission; it does not atomically exclude a different writer creating a child
prefix, a directory marker, or a parent. Use cooperating namespace owners or application generations for that stronger
publication problem. Backends declaring conditional writes false retain their weaker provider contract.

Read-only record policy also rejects facade and KV/unstorage bridge mutation before parent reads, namespace claims, or
source acquisition. Backend `write: false` cannot be upgraded by a capabilities override. Construction snapshots policy
callbacks and flags; inspection returns detached data and cannot change execution routes or limits.

## Host cancellation admission

A signal supplied directly to a Node, Deno, or Bun file driver remains attached to its returned read stream. Aborting
cancels its native producer and errors further reads with `aborted`. Range reads and append/update writes recheck the
signal between acquired-file, metadata, positioning, partial I/O, and truncation steps. Acquired files close even when
cancellation wins during setup. Native copy checks again after private staging acquisition and before publication; move
checks again after namespace probes.

These checks prevent dispatch of subsequent work. A host operation already dispatched before the abort may still
complete, including creation, truncation, a partial write, or rename. Cancellation supplies no rollback or atomic
publication guarantee. Node and Deno complete reads/replacements use their native signal APIs; Bun signal-aware complete
reads/replacements delegate to the Node-compatible lane. Calls without a signal retain the ordinary Bun and native
append fast paths. [Node filesystem cancellation](https://nodejs.org/api/fs.html#fspromiseswritefilefile-data-options)
and [Deno filesystem APIs](https://docs.deno.com/api/deno/file-system/) describe their native boundaries.

Append with `truncate: true` is a mutable-file operation. Node and its Bun-compatible lane capture the acquired file's
EOF once, write from that cursor and truncate the same descriptor at the final cursor, as the Deno lane does. This
requires ordinary write/truncate rights; a Windows append handle alone cannot truncate. Bytes, empty input and streams
use the same rule, with or without a signal. A newly created file is acquired exclusively, so a file that appears after
the initial missing-path observation is reopened for update instead of being truncated during acquisition.

This append-and-truncate operation requires cooperating writers. A concurrent writer can change bytes or length after
the initial EOF observation; the final truncate can remove its later tail. Use the facade's cooperating path locks or
application coordination for this scenario. Ordinary Node append without truncation retains native append mode. All
writes and truncation remain attached to the acquired file even when its path is renamed or replaced; this is descriptor
ownership, not protection against hostile namespace changes or a promise of rollback.

## Native retirement failures

Node, Deno and browser OPFS writes await the resources they acquire. An ordinary operation failure remains the exact
reason when cleanup succeeds, including a thrown `undefined` or `null`. If producer cancellation, reader lock release,
file close or OPFS staged abort also fails, an `AggregateError` retains those independent events in ownership order.
Nested ownership scopes can retain nested aggregates. A repeated reason value does not remove a separate failure. Actual
reader EOF or read error releases its lock without cancelling the already-terminal native stream again.

Streaming file writes require genuine `Uint8Array` chunks. Buffer instances, byte-array subclasses and offset views are
accepted. A string, `DataView` or object that only imitates byte-array properties is rejected. Host stream replacement
can already have truncated a file before it reads an invalid chunk; host writes do not acquire OPFS rollback semantics.
OPFS staging instead aborts on invalid input or failed reader retirement before publication.

Native host copy owns an exclusively reserved sibling. Successful rename consumes that sibling name, so cleanup never
unlinks a new entry subsequently created there. No-replace link publication leaves the owned sibling to remove. If that
removal fails, the copy rejects even though destination bytes can already be visible. These are cooperating-owner host
semantics, not protection against hostile concurrent path swaps. OPFS close failure likewise reports the native failure;
the library cannot infer browser publication from a failed close or grant durability beyond the browser contract.

OPFS positional resources now use the same bounded operation queue as Node and Deno. The first close or abort stops new
admission, waits for accepted work, invokes its winning native action once and shares that action's actual terminal
promise with repeated calls. Failure settles the queue but does not prove physical retirement succeeded. This queue owns
one writable resource; application staging, publication and path coordination remain their own authorities.

Deno finite-range cancellation closes its descriptor and then joins the one already-admitted native read before
settling. Bytes or errors arriving from that read are never sent into the canceled stream. An actual read rejection
caused by retirement remains a cancellation failure, alongside any independent close failure; the driver does not
discard it by native error class or matching reason. A successfully closed descriptor alone does not certify that the
read settled.

For the Deno KV adapter, source, read-pin, and unpublished-generation retirement failures remain alongside the operation
failure. Only an actually missing state record, with both value and version absent, permits idempotent cleanup. Database
failures and invalid stored state still reject. Repeated read-pin release joins one physical retirement result.
