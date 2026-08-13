Architecture and invariants
===========================

This document explains why `@okikio/opfs` has two frontend styles, one adapter contract, and a second record-store contract.

The core rule is simple:

> Filesystem semantics belong to the filesystem facade. Persistence mechanics belong to the adapter.

That rule keeps OPFS-style application code reusable without flattening meaningful differences between a browser filesystem, a host filesystem, a key-value store, a document collection, and a SQL database.

The complete data path
----------------------

```text
                           application
                               |
                  +------------+------------+
                  |                         |
                  v                         v
             path methods              OPFS-shaped handles
           readFile/writeFile         FileHandle/DirectoryHandle
                  |                         |
                  +------------+------------+
                               |
                               v
                         FileSystemType
                               |
        path normalization / errors / cancellation
        recursive copy / move / walk / remove
        lock ownership / sync-file lifetime
        stream fallback / buffer limit
                               |
                               v
                           AdapterType
                               |
               +---------------+---------------+
               |                               |
               v                               v
         native adapters                 RecordStoreType
       OPFS/Deno/Bun/Node                      |
                                               |
                            +------------------+------------------+
                            |                  |                  |
                            v                  v                  v
                       unstorage             RxDB             SQL rows
                                                               |
                                                        +------+------+
                                                        |             |
                                                        v             v
                                                       db0         Drizzle
```

Why `AdapterType` is small
--------------------------

The required primitive set is deliberately smaller than the public filesystem API:

```text
stat
readFile
writeFile
readDir
createDir
remove
```

Optional native capabilities add faster or stronger paths:

```text
openReadStream
writeStream
move
openSyncFile
```

The facade builds higher-level behavior from these primitives. A custom backend therefore does not need to implement recursive copy, recursive remove, parent creation, OPFS-shaped handles, or lock orchestration independently.

This avoids a common adapter anti-pattern where every backend reimplements the full public API and gradually develops different semantics.

Capability flags describe native behavior
-----------------------------------------

`AdapterCapabilitiesSchema` contains:

```text
read
write
streamRead
streamWrite
rangeRead
nativeMove
syncAccess
```

These values describe what the adapter itself can do. They do not describe everything the facade can emulate.

For example, a record-store adapter reports `streamWrite: false`. The facade can still accept a `ReadableStream<Uint8Array>`, but it must buffer the stream before storing the record. The capability remains false because pretending that buffering is native streaming would hide an important memory and latency difference.

The record-store layer
----------------------

Value stores, document stores, and SQL databases do not naturally expose files and directories. `RecordStoreType` is the reusable translation point for those systems.

```ts
interface RecordStoreType {
  get(path): Promise<RecordType | null>;
  set(record): Promise<void>;
  delete(path): Promise<void>;
  list(parent): AsyncIterableIterator<RecordType>;
  dispose?(): void | Promise<void>;
}
```

The shared record is versioned and validated by Zod.

Directory:

```json
{
  "version": 1,
  "path": "/projects",
  "parent": "/",
  "name": "projects",
  "kind": "directory",
  "lastModified": 1786550000000
}
```

File:

```json
{
  "version": 1,
  "path": "/projects/state.bin",
  "parent": "/projects",
  "name": "state.bin",
  "kind": "file",
  "data": "AAECAwQ=",
  "size": 5,
  "lastModified": 1786550000000,
  "mediaType": "application/octet-stream"
}
```

`path` is the durable logical identity. `parent` is stored independently because directory listing should not require parsing every stored path. Backends are free to index `parent` in the way that best fits the provider.

File bytes are base64. The choice is not an assertion that base64 is the most storage-efficient format. It is the common representation that survives JSON, RxDB documents, unstorage values, and SQL text columns without backend-specific binary contracts. Native filesystem adapters do not pay this cost.

Streaming policy
----------------

Native adapters stream when the backend gives a real streaming primitive.

Record-backed adapters materialize one file record. A streamed input therefore passes through this sequence:

```text
ReadableStream / AsyncIterable
              |
              v
      bounded byte collector
              |
      +-------+-------+
      |               |
 under limit       over limit
      |               |
      v               v
 RecordStore.set   cancel source
                  throw too-large
```

`maxBufferedWriteBytes` defaults to 64 MiB. The limit is part of `FileSystemOptionsType`, not a hidden constant inside each database adapter, so the application can choose a memory policy once.

Path invariant
--------------

Every adapter receives canonical virtual paths.

Valid:

```text
/
/a
/a/b.txt
```

Rejected at the canonical adapter seam:

```text
a/b
/a/
/a//b
/a/./b
/a/../b
/a\b
```

Public path APIs may accept relative or non-canonical input. `normalizePath()` resolves it before the adapter sees it.

The virtual path namespace is not a host path namespace. `createLocalPath()` maps virtual paths below one configured host root and verifies that the result does not escape that root.

Handle invariant
----------------

`FileHandle` and `DirectoryHandle` are facades. They are not native `FileSystemHandle` objects and they do not claim to be.

The facades preserve the useful OPFS programming shape:

```text
root.getFileHandle()
root.getDirectoryHandle()
file.getFile()
file.createWritable()
file.createSyncAccessHandle()
directory.removeEntry()
directory.resolve()
entries()/keys()/values()
```

They also expose a package-specific canonical `path` property because the adapter architecture needs a stable logical address.

`createWritable()` stages an in-memory file image and commits only on close. Abort discards the staged image. This mirrors the commit-on-close behavior an application expects from the File System API, but it is intentionally not the recommended large-file path. Large sequential writes should use `FileSystemType.writeFile()` so a streaming-capable adapter can bypass the staged image.

Coordination invariant
----------------------

There are two classes of mutation.

File mutation:

```text
shared tree lock
      |
exclusive /path/to/file lock
      |
write or sync file lifetime
```

Structural mutation:

```text
exclusive tree lock
      |
copy / move / recursive remove / emptyDir
```

This lets independent files make progress at the same time while ensuring that a recursive tree mutation cannot race an active library file mutation.

`local` coordination shares lock state by lock name inside one JavaScript realm. New readers queue behind an already-waiting exclusive request so writers do not starve.

`web-locks` uses the browser Web Locks API. `auto` selects Web Locks when present and local FIFO locks otherwise. `none` retains cancellation checks but does not coordinate mutations.

The adapter still owns any stronger backend-level locking. Library locks are application-level coordination for callers that use this library.

Synchronous file lifecycle
--------------------------

A synchronous file has two resources with one lifetime:

```text
facade path lock <------ same lifetime ------> adapter sync file
       |                                         |
       +---------------- close() ----------------+
```

`ManagedSyncFile` keeps the path lock until the native resource closes. This prevents an async write through the same facade from entering while synchronous random access is active.

`writeAll()` must handle partial writes. It repeats the write until the complete input is committed or the backend reports no progress.

Move semantics
--------------

Adapters with a native rename/move set `nativeMove: true` and provide `move()`.

```text
Deno/Bun/Node
source -------- native rename --------> destination
```

Adapters without that primitive use:

```text
source ---- copy ----> destination
   |
   +---- remove source after successful copy
```

The second sequence is not atomic. A failure between copy and remove can leave both entries. The API and documentation state this rather than presenting every backend as a POSIX filesystem.

Before either form, source and destination are checked for ancestor overlap. An overwrite never removes an ancestor or descendant containing the source.

Resource ownership
------------------

Injected resources are borrowed by default.

```text
caller creates resource
       |
       +----> adapter borrows resource
       |           |
       |           +---- filesystem closes
       |           +---- resource stays open
       |
       +---- caller still owns resource
```

Ownership changes only through an explicit option:

```text
disposeAdapter
disposeStorage
disposeDatabase
disposeFileSystem
```

This rule matters for connection pools, shared RxDB collections, process-wide unstorage instances, and server databases. A library adapter must not quietly dispose infrastructure that another subsystem still owns.

Error invariant
---------------

Backends fail differently. Browsers use DOMException names. Node commonly reports `error.code`. Database bridges can throw provider errors.

`toFileSystemError()` normalizes known failures to stable categories while retaining the original `cause`. The package does not erase unexpected backend failures into one generic string.

Adapter import invariant
------------------------

The root package is import-safe for browsers. Runtime-specific code remains behind explicit subpaths.

```text
@okikio/opfs                browser-safe core + native OPFS
@okikio/opfs/adapter/node   node:fs imports
@okikio/opfs/adapter/deno   Deno globals
@okikio/opfs/adapter/bun    Bun globals + Node compatibility APIs
@okikio/opfs/adapter/drizzle optional drizzle-orm peer
```

No adapter configures logging, reads environment variables, connects to a database, or mutates global application state merely because the module was imported.
