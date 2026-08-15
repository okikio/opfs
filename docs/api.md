Public API guide
================

This guide is organized by developer task. Exact low-level schemas and types are also available through the explicit package subpaths.

Open or create a filesystem
---------------------------

### `openFileSystem(options?)`

Opens the browser's native Origin Private File System and returns `FileSystemType`.

```ts
import { openFileSystem } from "@okikio/opfs";

const fileSystem = await openFileSystem();
```

Use this only when native browser OPFS is the chosen backend. Server runtimes should create a runtime adapter and pass it to `createFileSystem()`.

### `createFileSystem(adapter, options?)`

Creates the adapter-independent facade.

```ts
const fileSystem = createFileSystem(adapter, {
  coordination: "auto",
  lockPrefix: "my-app:filesystem",
  maxBufferedWriteBytes: 64 * 1024 * 1024,
  metrics: "basic",
  optimizations: { nativeCopy: true },
  disposeAdapter: false,
});
```

`FileSystemOptionsType`:

- `coordination`: `auto`, `web-locks`, `local`, or `none`.
- `lockPrefix`: stable lock namespace used for cooperating filesystem facades.
- `maxBufferedWriteBytes`: maximum stream/file size the facade may materialize for a fallback route.
- `metrics`: `none`, `basic`, or `timing`. `none` is intended for baseline overhead measurements.
- `optimizations`: partial override for `streamRead`, `streamWrite`, `rangeRead`, `nativeCopy`, and `nativeMove`. Every route defaults to enabled.
- `disposeAdapter`: transfers adapter disposal ownership to the facade when true.

`coordination` is runtime-validated by `CoordinationModeSchema`.


Inspect and plan before I/O
---------------------------

### `inspect()`

Returns a synchronous `InspectionType` for the configured filesystem stack. It contains:

```text
adapter
native capabilities
effective support
known hard limits
optional partition layout
resolved optimization policy
maxBufferedWriteBytes
metrics mode and current metrics snapshot
```

Effective support uses `native | emulated | partitioned | unsupported`. Native capability flags never include facade emulation.
This makes a caller able to distinguish a fast provider range read from a full-read-and-slice fallback, or a Deno KV partitioned
stream from a complete-record materialization.

### `plan(input)`

Creates a deterministic `PlanType` without touching the backend. Supported operations are `read`, `write`, `copy`, and `move`.
For writes, `size` is the resulting logical file size and is used for `maxFileBytes` and partition-count checks. `inputBytes` is
the number of bytes supplied by the current write and is used for facade stream-buffer admission. For replace, omitted
`inputBytes` falls back to `size` because those values are normally equal. Append/update callers should provide both when known.

```ts
const plan = fileSystem.plan({
  operation: "write",
  source: "stream",
  mode: "replace",
  size: 200 * 1024 * 1024,
  inputBytes: 200 * 1024 * 1024,
});

if (!plan.supported) throw new Error(plan.reasons.join(" "));
```

An unknown limit remains unknown. The planner does not invent provider guarantees. For an unknown-size emulated stream, it warns
that `maxBufferedWriteBytes` remains the runtime admission limit.

### `getMetrics()`

Returns a detached `MetricsType`. `basic` tracks counts, failures, bytes, native/emulated/partitioned route counts, current
facade-owned buffered bytes, and peak buffered bytes. `timing` additionally records total and maximum durations. `none` keeps the
hot-path collector inactive.

Optimization controls can force a fallback for differential tests or application policy. A disabled optimization is never
relabelled native. If the fallback cannot satisfy the request within `maxBufferedWriteBytes`, runtime execution and `plan()` both
fail with the same `too-large`/unsupported condition when size is known.

Path API
--------

### `getDirectoryHandle(path, options?)`

Returns a package `DirectoryHandleType` for one directory.

Options:

- `create`: create exactly that directory when absent.
- `recursive`: create missing ancestors as well.
- `signal`: abort before commit.

The virtual root `/` always exists.

### `getFileHandle(path, options?)`

Returns a package `FileHandleType`.

Options:

- `create`: create the file when absent.
- `parents`: create missing parent directories.
- `signal`: abort before commit.

A read-only lookup never creates a file or directory.

### `getFile(path, options?)`

Returns a `File` snapshot. Changes written later are not reflected in the already-returned File object.

### `stat(path, options?)`

Returns:

```ts
type StatType = FileStatType | DirectoryStatType;
```

File stat includes canonical path, name, size, last-modified milliseconds, and media type. Directory stat includes canonical path, name, and last-modified when the adapter provides it.

### `exists(path, options?)`

Returns an advisory boolean. `kind` can restrict the answer to `file` or `directory`.

Do not use `exists()` as a substitute for operation error handling. Another context can mutate the backend after the check.

### `mkdir(path, options?)`

Creates one directory. `recursive: true` creates missing ancestors.

### `ensureDir(path, options?)`

Ensures a directory and its parents exist. A file at the same path produces `type-mismatch`.

### `ensureFile(path, options?)`

Ensures an empty file exists and creates its parent directories.

Read APIs
---------

### `readFile(path, options?)`

Returns `Uint8Array`.

Options:

- `at`: zero-based byte offset.
- `length`: maximum bytes after `at`.
- `signal`: cancellation.

### `readText(path, options?)`

Reads bytes and decodes them. `encoding` defaults to UTF-8.

### `openReadStream(path, options?)`

Returns `ReadableStream<Uint8Array>`.

If the adapter provides native stream reads, the facade forwards them. Otherwise it creates a stream from the adapter's materialized read result. Cancellation remains connected after the stream opens.

Write API
---------

### `writeFile(path, data, options?)`

Accepted `WriteDataType` values:

```text
string
Blob
ArrayBuffer
ArrayBufferView
ReadableStream<Uint8Array>
AsyncIterable<Uint8Array>
```

Options:

- `mode`: `replace` (default), `append`, or `update`.
- `at`: starting byte offset for update mode.
- `truncate`: truncate at the final cursor.
- `parents`: create missing parents.
- `mediaType`: metadata for record/native adapters that can preserve it.
- `signal`: cancellation.

The mode is runtime-validated by `WriteModeSchema`.

A non-streaming adapter buffers stream input up to `maxBufferedWriteBytes`. Crossing the limit cancels the producer and throws `too-large`.

Long-lived positional output
----------------------------

### `openWritableFile(path, options?)`

Returns `WritableFileType` only when `adapter.capabilities.positionalWrite` is true. The facade does not emulate this operation with repeated `writeFile(..., { mode: "update" })` calls because a record-backed adapter can otherwise rematerialize the complete file for every chunk.

Options:

- `create`: create an empty file when it is absent.
- `parents`: create missing parent directories when `create` is true.
- `signal`: cancel ordinary work before commit. Cleanup through `close()` or `abort()` still releases the owned resource after cancellation.

The returned resource owns the file mutation lock for its complete lifetime. The create/check/open sequence occurs under that same lock, so another mutation cannot enter between file creation and adapter open.

```ts
const file = await fileSystem.openWritableFile("/media/output.mp4", {
  create: true,
  parents: true,
});

try {
  await file.write(header, { at: 0 });
  await file.write(chunk, { at: chunkOffset });
  await file.flush();
  await file.close();
} catch (error) {
  await file.abort(error);
  throw error;
}
```

`write()` is positional, `truncate()` changes byte length, and `flush()` requests backend durability without closing. `close()` and `abort()` are idempotent terminal operations. A browser OPFS writable can discard its staged image on abort. Host filesystems generally cannot roll back bytes already written, so an application that needs publish-on-success semantics should write a staging path and move it after close.

Record/database adapters report `positionalWrite: false`. They remain valid for ordinary materialized writes and bounded stream buffering, but they are not presented as a large-file positional output path.

Directory iteration
-------------------

### `readDir(path, options?)`

Lazy direct-child iterator.

```ts
for await (const entry of fileSystem.readDir("/projects")) {
  console.log(entry.kind, entry.name, entry.path);
}
```

### `walk(path, options?)`

Lazy recursive iterator.

Options:

- `maxDepth`: maximum depth below the requested path.
- `includeRoot`: include the requested path itself before descendants.
- `includeFiles`: yield files. Defaults to true.
- `includeDirectories`: yield directories. Defaults to true.
- `signal`: cancel traversal between yielded entries.

The iterator does not eagerly collect the entire tree.

Structural operations
---------------------

### `copy(source, destination, options?)`

Copies one file or tree. Directory file bodies use bounded `concurrency`, default 4.

`overwrite: true` replaces the destination tree instead of merging stale entries into it.

Source and destination cannot be the same path or ancestors of each other.

### `move(source, destination, options?)`

Uses adapter-native move when `nativeMove` is true. Otherwise calls copy then remove. The fallback is not atomic.

### `remove(path, options?)`

Removes one file or empty directory. `recursive: true` removes descendants first.

The virtual root cannot be removed.

### `emptyDir(path?, options?)`

Removes children while retaining the directory. `path` defaults to `/`. Child removals use bounded concurrency.

Synchronous file API
--------------------

### `openSyncFile(path, options?)`

Returns `SyncFileType` only when `adapter.capabilities.syncAccess` is true.

Options:

- `create`
- `parents`
- `signal`

The resource owns its native file and the facade path lock for the complete lifetime.

```ts
const file = await fileSystem.openSyncFile("/db.sqlite", {
  create: true,
  parents: true,
});

try {
  file.writeAll(bytes, { at: 0 });
  file.flush();
} finally {
  file.close();
}
```

`SyncFileType` operations:

```text
read
write
writeAll
getSize
truncate
flush
close
```

`writeAll()` loops over partial native writes.

OPFS-shaped handle API
----------------------

Every `FileSystemType` has `root: DirectoryHandleType`.

### Directory handle

```text
kind
name
path
getDirectoryHandle()
getFileHandle()
removeEntry()
resolve()
entries()
keys()
values()
isSameEntry()
[Symbol.asyncIterator]()
```

### File handle

```text
kind
name
path
getFile()
createWritable()
createSyncAccessHandle()
isSameEntry()
```

These are package facades, not native browser handle instances. Their `path` property is package-specific.

### `createWritable()`

Returns `WritableFileStreamType`. The staged image commits on close and discards on abort.

Supported write commands:

```ts
await writable.write(data);
await writable.write({ type: "write", position: 10, data });
await writable.write({ type: "seek", position: 20 });
await writable.write({ type: "truncate", size: 100 });
```

Blob also has a `type` property, so the implementation identifies a command only when `type` is exactly `write`, `seek`, or `truncate`.

Adapter and storage API
-----------------------

`@okikio/opfs/adapter` exports the backend contract consumed by `createFileSystem()`. The required primitive set stays small:

```text
stat
readFile
writeFile
readDir
createDir
remove
```

Optional methods expose stronger native paths:

```text
openReadStream  -> capabilities.streamRead
writeStream     -> mode is present in capabilities.streamWriteModes
copy            -> capabilities.nativeCopy
move            -> capabilities.nativeMove
openWritableFile -> capabilities.positionalWrite
openSyncFile    -> capabilities.syncAccess
```

The exported contract includes `AdapterCopyOptionsType` as well as the signal, read, write, move, stat, directory-entry,
writable-file, sync-file, adapter, and filesystem option types. `defineAdapter()` validates the adapter name and capability
record. It does not add a global registry or change the adapter.

The capability record describes what the backend performs natively. For example, an object adapter can expose
`streamWriteModes: ["replace"]` because replacement can stream to multipart/block upload while append and update still need a
read-modify-write cycle. The facade can emulate operations, but it does not relabel an emulation as native support.

### Record storage

`@okikio/opfs/adapter/record` is the common translation point for backends that naturally store values, documents, or SQL rows.
It exports `RecordStoreType`, `RecordAdapterOptionsType`, and `createRecordAdapter()`.

A record store always supports the complete logical `get/set/delete/list` contract. Simple stores can stop there. More capable
value stores can additionally expose `stat`, direct range `readFile`, `openReadStream`, selected direct materialized write modes,
and selected `writeStream` modes through `RecordStoreCapabilitiesType`. `createRecordAdapter()` translates only the declared
lanes into native adapter capabilities.

The portable complete-record fallback uses the versioned `RecordType` union and base64 file bytes so JSON, Web Storage, RxDB,
unstorage, and SQL text columns share one representation. A specialized store such as Deno KV can keep large body parts as raw
binary values and use metadata-only/range/stream/direct-write lanes so the generic base64 representation is not on its
large-file hot path. Deno KV declares materialized replace/append/update as direct store modes; append/update rebuild the next
immutable generation part-by-part instead of reconstructing the previous complete logical file. Its stream lane remains
replace-only, so streamed append/update can still require facade input buffering.

### Object storage

`@okikio/opfs/adapter/object` exports the provider-neutral object-storage layer:

- `ObjectCapabilitiesSchema` / `ObjectCapabilitiesType`
- `ObjectStatType` and `ObjectEntryType`
- object GET, PUT, COPY, and LIST option types
- `ObjectStoreType`
- `ObjectAdapterOptionsType`
- `createObjectAdapter()`

`ObjectStoreType` preserves object concepts such as ETags, provider version IDs, user metadata, prefix listing, conditional
writes, and server-side copy. `createObjectAdapter()` then maps that model into files and directories. Empty directories use
trailing-slash marker objects, while ordinary prefix listing also recognizes directories created outside this library.

The direct S3 API lives at `@okikio/opfs/s3`:

```ts
import { createS3Client } from "@okikio/opfs/s3";
import { createS3Adapter } from "@okikio/opfs/adapter/s3";

const client = createS3Client({
  endpoint,
  bucket,
  region,
  credentials,
});
const adapter = createS3Adapter(client);
```

`S3ClientType` extends `ObjectStoreType` and also exposes signed `request()`, `createUpload()`, `uploadPart()`,
`completeUpload()`, and `abortUpload()`. The lower-level request method is the deliberate escape hatch for provider-specific
S3 features that do not belong in the filesystem API.

The Azure counterpart lives at `@okikio/opfs/azure` and `@okikio/opfs/adapter/azure`:

```ts
import { createAzureClient } from "@okikio/opfs/azure";
import { createAzureAdapter } from "@okikio/opfs/adapter/azure";

const client = createAzureClient({ endpoint, container, credential });
const adapter = createAzureAdapter(client);
```

`AzureClientType` retains the REST request escape hatch, provider request IDs, range access, block upload, and server-side copy.

The object-store interfaces are intentionally smaller than either provider protocol. See [S3 client protocol](./s3.md) and
[Azure Blob client protocol](./azure.md) for signing, version gates, multipart/block lifecycles, limits, provider failures, and
known unsupported operations.

### Reverse key-value APIs

`@okikio/opfs/driver/kv` exports `createKeyValueDriver()`. It maps colon-delimited keys onto private directories so both `foo`
and `foo:bar` can exist at the same time:

```text
foo      -> /key-foo/value
foo:bar  -> /key-foo/key-bar/value
```

The driver supports string/raw get and set, existence, metadata, hierarchical key enumeration, clear, and explicit filesystem
ownership transfer. It also exposes `inspect()`, `plan()`, and `getMetrics()`. Those methods delegate to the backing
`FileSystemType`, so a reverse ecosystem consumer sees the same effective routes, limits, partition policy, buffer ceiling, and
observed metrics instead of receiving a second approximation of storage capability.

`@okikio/opfs/driver/unstorage` is a thin translation over this generic driver. It supplies unstorage method names and
`maxDepth` behavior while reusing the same collision-safe filesystem mapping.

### Schemas

`@okikio/opfs/schema` exports the executable project data contracts:

- `PathSchema` / `PathType`
- `AdapterNameSchema` / `AdapterNameType`
- `EntryKindSchema` / `EntryKindType`
- `OpfsContextSchema` / `OpfsContextType`
- `CoordinationModeSchema` / `CoordinationModeType`
- `WriteModeSchema` / `WriteModeType`
- `AdapterCapabilitiesSchema` / `AdapterCapabilitiesType`
- `ErrorCodeSchema` / `ErrorCodeType`
- `RecordVersionSchema` / `RecordVersionType`
- `DirectoryRecordSchema` / `DirectoryRecordType`
- `FileRecordSchema` / `FileRecordType`
- `RecordSchema` / `RecordType`
- `Db0DialectSchema` / `Db0DialectType`
- `SqlIdentifierSchema` / `SqlIdentifierType`

The package exports Zod 4 schemas directly. Zod 4 implements Standard Schema, so a consumer that accepts that interface can use
the same schema value without a second OPFS-owned wrapper contract.

### Bridge descriptors

`@okikio/opfs/bridge` groups the adapter and reverse-driver directions for an ecosystem. It does not replace either primitive.

- `UnstorageBridge`: both directions.
- `RxDbBridge`: collection to OPFS only.
- `Db0Bridge`: database to OPFS only.
- `DrizzleBridge`: database/table to OPFS only.
- `KeyValueBridge`: OPFS to generic asynchronous key-value only.

`defineBridge()` validates that `directions.toOpfs/fromOpfs` agree with the constructors. Every unsupported direction must state a
reason. This is intentional for ecosystems where the reverse shape would require query, conflict, transaction, synchronous, or
other semantics a filesystem does not own.

Path utility API
----------------

`@okikio/opfs/path` exposes the canonical virtual-path model used by adapters:

- `ROOT_PATH`: the canonical `/` root.
- `normalizePath(path)`: resolves `.`, `..`, duplicate separators, and relative input while rejecting root escape, backslashes, and NUL.
- `splitPath(path)`: returns canonical path segments without `/`.
- `joinPath(...parts)`: joins inputs and returns a canonical `PathType`.
- `dirname(path)`: returns the canonical parent path.
- `basename(path)`: returns the final name. Root returns an empty string.
- `isAncestorPath(ancestor, path)`: tests strict ancestry after normalization.
- `validateName(name)`: validates one direct File System API child name.
- `PathType`: validated canonical virtual path type.

Use the high-level filesystem methods for normal application work. These helpers are primarily for adapters, drivers, and code that persists canonical paths.

Error API
---------

The root module exports `FileSystemError`, `getErrorName()`, `getErrorMessage()`, and `toFileSystemError()`.

`FileSystemError` carries:

```text
code       stable ErrorCodeType
operation  filesystem operation that failed
path       canonical path when one exists
cause      original runtime/provider failure when retained
```

`toFileSystemError()` maps known DOMException names and server error codes such as `ENOENT`, `EEXIST`, and quota/permission failures into the stable package categories. Unknown provider failures remain `unknown` and retain the original cause.

`getErrorName()` and `getErrorMessage()` are safe extraction helpers for diagnostics where the caught value is `unknown`.

Browser capability APIs
-----------------------

### `probeOpfs()`

Returns a non-throwing `OpfsCapabilitiesType` report with:

- execution context;
- root availability and normalized root error;
- embedded/same-origin-top facts when observable;
- Web Locks availability;
- sync access exposure;
- storage estimate when available;
- persistence status when available.

It does not report `isIncognito` or `isPrivate`.

### `getOpfsContext()`

Classifies the current browser execution context as window, dedicated worker, shared worker, service worker, generic worker, or unknown.

### iframe subpath

`@okikio/opfs/iframe` exports:

- `supportsUnpartitionedOpfsRequest()`
- `requestUnpartitionedFileSystem()`

The request is explicit because browser permission/user-activation requirements must remain under application control.

Lifecycle
---------

`FileSystemType` implements `AsyncDisposable`.

```ts
await fileSystem.close();
```

or with supported explicit resource management syntax:

```ts
await using fileSystem = createFileSystem(adapter, {
  disposeAdapter: true,
});
```

Closing is idempotent. The adapter is closed only when ownership was explicitly transferred.
