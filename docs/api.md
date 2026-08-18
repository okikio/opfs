# Public API guide

## Purpose

The public API is organized by layer. Normal application code can use the root filesystem facade and convenience
adapters. Storage libraries and infrastructure code can use the explicit client, driver, adapter, bridge, and
integration subpaths.

```text
client -> driver -> adapter -> FileSystemType -> bridge
```

No public constructor requires a global registry.

## Filesystem root

### `openFileSystem(options?)`

Opens the current browser realm's native Origin Private File System and returns `FileSystemType`.

```ts
import { openFileSystem } from "@okikio/opfs";

await using fileSystem = await openFileSystem();
await fileSystem.writeFile("/state.json", "{}", { parents: true });
```

This convenience path composes native OPFS root -> OPFS driver -> OPFS adapter -> filesystem facade.

### `createFileSystem(adapter, options?)`

Creates the adapter-independent facade.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const fileSystem = createFileSystem(
  createNodeAdapter({ root: "./data" }),
  {
    coordination: "local",
    maxBufferedWriteBytes: 64 * 1024 * 1024,
    metrics: "basic",
    disposeAdapter: true,
  },
);
```

Important `FileSystemOptionsType` fields:

- `coordination`: `auto | web-locks | local | none`;
- `lockPrefix`: stable namespace for cooperating facade locks;
- `maxBufferedWriteBytes`: maximum facade-owned materialization for fallback routes;
- `metrics`: `none | basic | timing`;
- `optimizations`: independent facade route switches;
- `disposeAdapter`: transfer adapter ownership to the facade.

## Filesystem methods

`FileSystemType` exposes the portable API:

```text
getDirectoryHandle
getFileHandle
getFile
stat
exists
mkdir
ensureDir
ensureFile
readFile
readText
openReadStream
writeFile
readDir
walk
copy
move
remove
emptyDir
openWritableFile
openSyncFile
inspect
plan
getMetrics
close
root
```

All path methods use the canonical virtual namespace. Public input is normalized before adapter/driver calls.

## Read APIs

### `readFile(path, options?)`

Returns `Uint8Array`.

Options include:

```text
at       zero-based offset
length   maximum bytes after at
signal   cancellation
```

A driver/adapter with native range support can avoid materializing the complete file. Otherwise the facade can emulate
the range and reports that route through `inspect()`/`plan()`.

### `readText(path, options?)`

Reads file bytes and decodes text. UTF-8 is the default encoding.

### `openReadStream(path, options?)`

Returns `ReadableStream<Uint8Array>`.

When a native stream exists and `optimizations.streamRead` is enabled, the facade forwards it. Otherwise a readable
backend can be adapted to a materialized stream. `inspect().support.streamRead` identifies the effective route.

## Write APIs

### `writeFile(path, data, options?)`

Accepted input:

```text
string
Blob
ArrayBuffer
ArrayBufferView
ReadableStream<Uint8Array>
AsyncIterable<Uint8Array>
```

Write modes:

```text
replace
append
update
```

Important options:

```text
at
truncate
parents
mediaType
signal
```

A streaming source uses a driver-native stream route only when the selected write mode supports it and the route is
enabled. Otherwise the facade materializes the stream under `maxBufferedWriteBytes`. Crossing that limit cancels the
producer when possible and fails with `too-large`.

## Directory and tree APIs

### `readDir(path, options?)`

Returns a lazy direct-child iterator.

### `walk(path, options?)`

Returns a lazy recursive iterator. Options control depth, root inclusion, file inclusion, directory inclusion, and
cancellation. The facade does not collect the complete tree first.

### `copy(source, destination, options?)`

Copies one file or directory tree. The facade uses native/server-side copy when the adapter provides it and the route is
enabled. Otherwise it composes read/write work with bounded concurrency.

### `move(source, destination, options?)`

Uses native move when available. The fallback is copy then remove and is not atomic. `plan()` returns a structured
warning for that route. On host filesystems, facade checks cannot exclude an independent process changing the source or
destination between checks and the native rename/copy call; applications that need stronger cross-process serialization
must own that policy outside the facade.

### `remove(path, options?)`

Removes one entry or recursively removes descendants when requested. The virtual root cannot be removed.

### `emptyDir(path?, options?)`

Removes children while keeping the directory. Root is the default.

## OPFS-shaped handles

Every facade exposes `root: DirectoryHandleType`.

`DirectoryHandleType`:

```text
kind
name
path
getDirectoryHandle
getFileHandle
removeEntry
resolve
entries
keys
values
isSameEntry
Symbol.asyncIterator
```

`FileHandleType`:

```text
kind
name
path
getFile
createWritable
createSyncAccessHandle
isSameEntry
```

These are package facades, not native browser handle instances. `path` is a package-specific canonical virtual path.

## Writable files

`createWritable()` returns `WritableFileStreamType` with OPFS-style commands:

```ts
await writable.write(bytes);
await writable.write({ type: "write", position: 10, data: bytes });
await writable.write({ type: "seek", position: 20 });
await writable.write({ type: "truncate", size: 100 });
await writable.close();
```

The staged image commits on close and is discarded on abort. The writable keeps the complete staged file image in
JavaScript memory, and `keepExistingData` must first read the current complete file snapshot. Large sequential writes should
therefore prefer `writeFile()` because that path can select a native streaming driver route. Use `openWritableFile()` when
the selected adapter exposes direct asynchronous positional writes.

`openWritableFile()` exposes a direct asynchronous positional resource only when the adapter reports that capability.

## Synchronous files

`openSyncFile(path, options?)` returns `SyncFileType` only when the selected adapter exposes native synchronous random
access.

Operations:

```text
read
write
writeAll
getSize
truncate
flush
close
```

The facade keeps the path lock for the complete resource lifetime. `writeAll()` handles partial native writes.

## Inspection

### `fileSystem.inspect()`

Returns `InspectionType`:

```ts
const inspection = fileSystem.inspect();

inspection.driver;
inspection.adapter;
inspection.support;
inspection.optimizations;
inspection.maxBufferedWriteBytes;
inspection.metricsMode;
inspection.metrics;
inspection.driverMetrics;
```

`inspection.driver` contains:

- `provides`: stable operation/capability identifiers exposed by this configured driver;
- `ownership`: `none`, `borrowed`, or `owned` for the long-lived backend resource;
- backend-native requirements and their current availability;
- provenance-aware provider, implementation, user, and probe limits;
- independently controllable driver optimization state.

`provides` is intentionally an open string vocabulary. A third-party driver can add a provider-specific operation
without waiting for a core enum revision. The stable core driver families still expose typed operational methods
separately.

`inspection.adapter` contains the translation layer's native route flags and compact translation summaries.

`inspection.support` contains effective routes after facade fallback and optimization policy:

```text
native
emulated
partitioned
unsupported
```

`inspection.metrics` is logical facade work. `inspection.driverMetrics`, when present, is physical backend/protocol
work.

## Planning

### `fileSystem.plan(input)`

Preflights a concrete request without touching storage.

Supported high-level operations are currently:

```text
read
write
copy
move
```

Example:

```ts
const plan = fileSystem.plan({
  operation: "write",
  path: "/archive.bin",
  source: "stream",
  size: 800 * 1024 * 1024,
  inputBytes: 800 * 1024 * 1024,
  mode: "replace",
});

if (!plan.supported) {
  console.log(plan.problems);
  console.log(plan.actions);
}
```

`PlanType` includes:

```text
operation
supported
support
driver
bufferBytes
partBytes
parts
problems[]
actions[]
```

Problems have a stable code, layer, severity, message, and optional referenced limit. Actions have a stable kind and
optional code/detail.

## Driver API

`@okikio/opfs/driver` exports the generic driver definition model:

- `ProblemLayerSchema` / `ProblemLayerType`;
- `ProblemSeveritySchema` / `ProblemSeverityType`;
- `ActionKindSchema` / `ActionKindType`;
- `ProblemSchema` / `ProblemType`;
- `ActionSchema` / `ActionType`;
- `DriverOperationSchema` / `DriverOperationType`;
- `DriverPlanInputSchema` / `DriverPlanInputType`;
- `DriverPlanSchema` / `DriverPlanType`;
- `DriverInspectionSchema` / `DriverInspectionType`;
- `DriverType`;
- `DefineDriverOptionsType`;
- `defineDriver()`.

`defineDriver()` validates definition metadata. Concrete storage should normally use one of the family contracts below.

## File-driver API

`@okikio/opfs/driver/file` exports:

- `FileDriverCapabilitiesSchema` / `FileDriverCapabilitiesType`;
- `FileDriverSignalOptionsType`;
- `FileDriverReadOptionsType`;
- `FileDriverWriteOptionsType`;
- `FileDriverCopyOptionsType`;
- `FileDriverMoveOptionsType`;
- `FileDriverDirectoryEntryType`;
- `FileDriverFileStatType`;
- `FileDriverDirectoryStatType`;
- `FileDriverStatType`;
- `FileDriverWritableFileType`;
- `FileDriverSyncFileType`;
- `FileDriverType`;
- `FileBackendType`;
- `DefineFileDriverOptionsType`;
- `defineFileDriver()`.

The associated adapter is `createFileAdapter(driver)` from `@okikio/opfs/adapter/file`.

## Record-driver API

`@okikio/opfs/driver/record` exports:

- `RecordListType`;
- `RecordReplacementSchema` / `RecordReplacementType`;
- `RecordDriverCapabilitiesSchema` / `RecordDriverCapabilitiesType`;
- `RecordBackendType`;
- `RecordDriverType`;
- `DefineRecordDriverOptionsType`;
- `defineRecordDriver()`.

The associated adapter is `createRecordAdapter(driver)` from `@okikio/opfs/adapter/record`.

## Object-driver API

`@okikio/opfs/driver/object` exports:

- `ObjectDriverCapabilitiesSchema` / `ObjectDriverCapabilitiesType`;
- `ObjectStatType`;
- `ObjectEntryType`;
- `ObjectListType`;
- `ObjectGetOptionsType`;
- `ObjectPutOptionsType`;
- `ObjectCopyOptionsType`;
- `ObjectListOptionsType`;
- `ObjectBackendType`;
- `ObjectDriverType`;
- `DefineObjectDriverOptionsType`;
- `defineObjectDriver()`.

The associated adapter is `createObjectAdapter(driver)` from `@okikio/opfs/adapter/object`.

## Adapter API

`@okikio/opfs/adapter` exports:

- `AdapterType`;
- `FileSystemOptionsType`;
- `defineAdapter()`.

Every `AdapterType` has a `driver` reference. Adapter capability flags describe direct translation routes. They do not
replace `driver.inspect()` or `FileSystemType.inspect()`.

## First-party file constructors

### Browser OPFS

```ts
import { createOpfsDriver } from "@okikio/opfs/driver/opfs";
import { createOpfsAdapter } from "@okikio/opfs/adapter/opfs";

const root = await navigator.storage.getDirectory();
const driver = createOpfsDriver(root);
const adapter = createOpfsAdapter(root); // convenience path creates its own driver
```

`createOpfsDriver(root)` returns `OpfsDriverType`. `createOpfsAdapter(root)` returns `OpfsAdapterType` and retains
`nativeRoot`.

### Node

```ts
createNodeDriver({ root: "./data" });
createNodeAdapter({ root: "./data" });
```

Types: `NodeDriverOptionsType`, `NodeAdapterOptionsType`.

### Deno

```ts
createDenoDriver({ root: "./data" });
createDenoAdapter({ root: "./data" });
```

Types: `DenoDriverOptionsType`, `DenoAdapterOptionsType`.

### Bun

```ts
createBunDriver({ root: "./data" });
createBunAdapter({ root: "./data" });
```

Types: `BunDriverOptionsType`, `BunAdapterOptionsType`.

## First-party record constructors

### Memory

```ts
createMemoryDriver();
createMemoryAdapter();
```

### Deno KV

```ts
const driver = createDenoKvDriver(database, {
  partition: "auto",
  partBytes: 48 * 1024,
  inlineBytes: 32 * 1024,
  maxParts: 10_000,
  concurrency: 8,
});
```

Exports include:

```text
DENO_KV_MAX_KEY_BYTES
DENO_KV_MAX_VALUE_BYTES
DENO_KV_MAX_ATOMIC_BYTES
DENO_KV_SAFE_PART_BYTES
DENO_KV_SAFE_INLINE_BYTES
DENO_KV_DEFAULT_PART_BYTES
DENO_KV_DEFAULT_INLINE_BYTES
DENO_KV_DEFAULT_MAX_PARTS
DENO_KV_DEFAULT_CONCURRENCY
DENO_KV_DEFAULT_COLLECT_AGE_MS
DENO_KV_DEFAULT_COLLECT_DELETES
DenoKvEntryType
DenoKvCheckType
DenoKvCommitType
DenoKvAtomicType
DenoKvType
DenoKvDriverOptionsType
DenoKvCollectOptionsType
DenoKvCollectResultType
DenoKvDriverType
```

The driver requires Deno KV's atomic check/set/delete contract for the small logical visibility commit. It uses the
versionstamp returned by the initial exact read to reject stale writers before a new manifest becomes visible. File body
parts remain outside the atomic operation.

The specialized `DenoKvDriverType` also exposes `collect(options?)` for bounded, age-gated reclamation of superseded and
unpublished physical parts. Published generations use their retirement time for the grace period, which lets an in-flight reader finish against the
immutable generation it already resolved while that configured grace remains active. Unpublished crash leftovers use generation creation
time. The adapter path re-exports the same provider constants, Deno KV structural contracts, and maintenance types plus
`createDenoKvAdapter()` and `DenoKvAdapterOptionsType`.

### localStorage

`driver/localstorage` exports `LocalStorageType`, `LocalStorageDriverOptionsType`, and `createLocalStorageDriver()`.
`adapter/localstorage` exports `createLocalStorageAdapter()`.

### IndexedDB

`driver/indexeddb` exports `IndexedDbDriverOptionsType`, `IndexedDbOpenOptionsType`, and `createIndexedDbDriver()`.
`adapter/indexeddb` exports `createIndexedDbAdapter()`.

### Cache Storage

`driver/cache` exports `CacheDriverOptionsType` and `createCacheDriver()`. `adapter/cache` exports
`createCacheAdapter()`.

### unstorage

`driver/unstorage` exports `UnstorageStorageType`, `UnstorageDriverOptionsType`, and `createUnstorageDriver()`.
`adapter/unstorage` exports `createUnstorageAdapter()`.

### RxDB

`driver/rxdb` exports the structural collection/document/query contracts, `RxDbRecordJsonSchema`, and
`createRxDbDriver()`. `adapter/rxdb` exports `createRxDbAdapter()`.

### db0

`driver/db0` exports `Db0PrimitiveType`, statement/database contracts, `Db0DriverOptionsType`, and `createDb0Driver()`.
The constructor is asynchronous because table initialization can perform database I/O.

`adapter/db0` exports `createDb0Adapter()`.

### Drizzle

`driver/drizzle` exports:

```text
DrizzleTableType
DrizzleRowType
DrizzleDriverOptionsType
createDrizzleDriver
```

`adapter/drizzle` exports `createDrizzleAdapter()`.

### SQLite

`driver/sqlite` exports:

```text
SqliteStatementType
SqliteDatabaseType
SqliteDriverOptionsType
createSqliteDriver
```

`adapter/sqlite` exports `createSqliteAdapter()`.

## Object clients and drivers

### S3 client

`@okikio/opfs/s3` exports:

- `S3AddressingSchema` / `S3AddressingType`;
- `S3CredentialsSchema` / `S3CredentialsType`;
- `S3CredentialSourceType`;
- `S3_LIMITS`;
- `S3ClientOptionsType`;
- `S3RequestOptionsType`;
- `S3CompleteOptionsType`;
- `S3UploadType`;
- `S3PartType`;
- `S3Error`;
- `S3ClientType`;
- `createS3Client()`.

Important client optimization options:

```text
delayedMultipart
signingKeyCache
```

The driver paths are:

```ts
createS3Driver(options);
createS3DriverFromClient(client);
```

The convenience adapter is:

```ts
createS3Adapter(client, options?);
```

For explicit layering, use `createObjectAdapter(createS3DriverFromClient(client))`.

### Azure Blob client

`@okikio/opfs/azure` exports:

- `AZURE_STORAGE_VERSION`;
- `AzureStorageVersionSchema` / `AzureStorageVersionType`;
- `AzureCredentialType`;
- `AzureClientOptionsType`;
- `AzureRequestOptionsType`;
- `AzureClientType`;
- `AzureError`;
- `AZURE_LIMITS`;
- `createAzureClient()`.

Important optimization options:

```text
blockUpload
serverCopy
```

The driver paths are:

```ts
createAzureDriver(options);
createAzureDriverFromClient(client);
```

The convenience adapter is `createAzureAdapter(client, options?)`.

## Bridge API

`@okikio/opfs/bridge/kv` exports:

- `KeyValueMetaType`;
- `KeyValueBridgeOptionsType`;
- `KeyValueBridgeType`;
- `createKeyValueBridge()`.

The bridge includes `inspect()`, `plan()`, and `getMetrics()` so consumers can reason about the storage stack beneath
the KV projection.

`@okikio/opfs/bridge/unstorage` exports:

- `UnstorageBridgeMetaType`;
- `UnstorageBridgeTransactionOptionsType`;
- `UnstorageBridgeType`;
- `UnstorageBridgeOptionsType`;
- `createUnstorageBridge()`.

## Integration API

`@okikio/opfs/integration/definition` exports:

- `IntegrationDirectionSchema` / `IntegrationDirectionType`;
- `IntegrationDirectionsSchema` / `IntegrationDirectionsType`;
- `IntegrationType`;
- `defineIntegration()`.

`@okikio/opfs/integration` exports current first-party direction definitions:

```text
UnstorageIntegration
RxDbIntegration
Db0Integration
DrizzleIntegration
DrizzleIntegrationSourceType
```

Direction metadata never makes an unsupported reverse contract executable.

## Schema and path API

`@okikio/opfs/schema` owns project serializable schemas and their inferred types. Important groups include:

```text
PathSchema / PathType
WriteModeSchema / WriteModeType
CoordinationModeSchema / CoordinationModeType
AdapterCapabilitiesSchema / AdapterCapabilitiesType
SupportModeSchema / SupportModeType
MetricsModeSchema / MetricsModeType
PartitionModeSchema / PartitionModeType
RecordSchema / RecordType
DriverKindSchema / DriverKindType
LimitKindSchema / LimitKindType
LimitSourceSchema / LimitSourceType
LimitUnitSchema / LimitUnitType
LimitSchema / LimitType
RequirementStateSchema / RequirementStateType
RequirementSchema / RequirementType
DriverOptimizationSchema / DriverOptimizationType
```

`@okikio/opfs/path` exposes canonical virtual-path helpers:

```text
ROOT_PATH
normalizePath
splitPath
joinPath
dirname
basename
isAncestorPath
validateName
PathType
```

`normalizePath()` preserves Unicode code points exactly. It does not apply NFC, NFD, or another Unicode normalization
form. Canonically equivalent spellings therefore remain distinct virtual paths unless the selected backend aliases them.

## Error API

The root module exports:

```text
FileSystemError
getErrorName
getErrorMessage
toFileSystemError
```

`FileSystemError` carries stable code, operation, optional canonical path, and original cause.

## Shared HTTP request API

`@okikio/opfs/request` exports the retry and transport contracts used by the direct S3 and Azure clients.

- `RequestPolicySchema` / `RequestPolicyType`: retries, delay, jitter, and optional per-attempt timeout.
- `FetchType`: the standard callable Fetch shape accepted for dependency injection. It intentionally does not include
  runtime-specific properties such as Bun's `fetch.preconnect()`.
- `RequestMetrics` / `RequestMetricsType`: concrete HTTP request, retry, response, failure, and optional duration counters.
- `sendRequest()`: shared attempt orchestration used by protocol clients. Request preparation runs before the concrete
  Fetch counter starts, so a deterministic signing or credential failure is not reported as network I/O.

## Browser capability API

The root exports `probeOpfs()` and `getOpfsContext()`.

`probeOpfs()` returns a non-throwing current-realm report. It probes actual APIs/policy rather than maintaining a
browser-brand table.

`@okikio/opfs/iframe` exports:

```text
supportsUnpartitionedOpfsRequest
requestUnpartitionedFileSystem
```

The application remains responsible for the permission/user-activation flow.

## Metrics API

`@okikio/opfs/metrics` exports logical facade metrics plus `DriverMetricsType`.

Logical facade metrics count operations, failures, logical bytes, native/emulated/partitioned routes, buffering, and
optional timing.

Driver metrics are physical and provider-specific enough to include request/retry/part/physical-byte/cleanup information
without forcing that data into logical filesystem counters.

## Lifecycle

`FileSystemType` implements async disposal. Closing is idempotent. The adapter is disposed only when ownership was
transferred. Each adapter/driver/bridge has its own explicit ownership option for injected resources.

```ts
await using fileSystem = createFileSystem(adapter, {
  disposeAdapter: true,
});
```

Cancellation and disposal remain distinct. A caller can cancel one operation without implicitly disposing a shared
storage resource.
