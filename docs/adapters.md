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

`transactions: true` is deliberately narrower than "every filesystem write mode is transactional." Generic `append`
and `update` first read the current record and later replace it. Those two steps are not one backend transaction unless
the driver exposes that mode through a native `writeFile()` or `writeStream()` lane. A second process, tab, or client can
therefore race the generic fallback even when the underlying database supports transactions. Deno KV's native partitioned
write modes and object-store ETag conditions are examples of stronger routes that close this gap explicitly.

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

`DenoKvDriverType.collect()` performs explicit maintenance for superseded and crash-left physical generations. It scans
only the private part namespace and always retains the currently published generation. A superseded published generation
uses a retirement marker committed atomically with the new logical entry after an optimistic version check. The default
one-hour grace therefore starts when visibility changes rather than when the generation was originally created. An
unpublished crash leftover has no retirement marker and uses its generation creation time. The pass
stops after the caller's deletion budget. Ordinary reads and writes never start this scan implicitly.

### localStorage

The localStorage driver maps canonical records into a private key prefix. It inherits Web Storage's synchronous
underlying API, but the package presents the normal asynchronous driver contract to keep the storage stack composable.
Directory listing scans the private key namespace, so recursive traversal cost grows with the number of stored entries.

Applications should treat browser quota as dynamic. The driver does not invent a stable quota number.

### IndexedDB

The IndexedDB driver borrows or owns an injected database according to options. It uses an object store and a parent
index for direct-child listing. Replace, append, and update run through one readwrite transaction, so independent browser
owners using the same object store do not lose an append/update through the generic record adapter's split read/replace
sequence. The application remains responsible for database versioning/upgrades outside the driver unless ownership is
explicitly transferred.

### Cache Storage

The Cache driver stores records under private request URLs. Cache Storage is a record/value persistence mechanism here,
not an HTTP cache policy abstraction. The driver only interprets entries in its private namespace. Direct-child listing
starts from `cache.keys()` and inspects matching records, so repeated recursive traversal is substantially more expensive
than an indexed parent lookup. Do not treat Cache Storage as equivalent to IndexedDB for directory-heavy workloads.

### unstorage

`createUnstorageDriver(storage)` consumes the high-level unstorage `Storage` object. This deliberately sits above
whichever unstorage provider driver the application selected.

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

Filesystem semantics can amplify provider requests. A single logical write can require file and directory classification,
parent validation, and the final PUT, so object-backed facade operations can issue several HEAD/LIST requests before the
data request. This is a known translation cost, not hidden native filesystem behavior. Use the provider benchmark staircase
to measure client, driver, adapter, and facade cost separately before changing validation or consistency rules.

### S3

The S3 client owns REST, SigV4, request policy, multipart operations, copy, listing, and protocol errors.

`createS3Driver(client)` adds backend capability/limit/optimization inspection. `createS3Adapter(driver)` translates
object keys and directory prefixes into filesystem primitives.

The client optimizations include independently controllable delayed multipart promotion and derived signing-key caching.
See `s3.md`.

### Azure Blob

The Azure client owns Blob REST, authentication, block upload, server-side copy, listing, and provider errors.

`createAzureDriver(client)` adds backend inspection. `createAzureAdapter(driver)` supplies filesystem translation. Block
upload and server copy are independently disableable. Azure metadata is validated before provider I/O, and the shared object
adapter uses the Azure-compatible `okikio_opfs_kind` key for private directory markers. See `azure.md`.

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
