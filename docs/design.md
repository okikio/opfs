Architecture and invariants
===========================

The architecture starts from one rule:

> The filesystem facade owns filesystem semantics. An adapter owns the mechanics of one backend.

That rule matters because OPFS, Node files, Deno KV, SQLite, S3, and Azure Blob do not have the same native operations. A useful
portable library must make common application behavior consistent without hiding those differences from performance-sensitive
or correctness-sensitive code.

The complete data path is:

```text
                              application
                                  |
                  +---------------+---------------+
                  |                               |
                  v                               v
              path API                     OPFS-shaped handles
       readFile / writeFile / walk      DirectoryHandle / FileHandle
                  |                               |
                  +---------------+---------------+
                                  |
                                  v
                            FileSystemType
                                  |
          normalize paths / normalize failures / cancellation
          parent creation / recursive operations / staging
          file locks / tree locks / sync-file lock lifetime
          stream selection / bounded materialization / ownership
                                  |
                                  v
                             AdapterType
                 +----------------+----------------+
                 |                |                |
                 v                v                v
          native filesystem   record storage   object storage
           OPFS/Node/Deno     KV/doc/SQL       S3/Azure Blob
                 |                |                |
                 |         RecordStoreType    ObjectStoreType
                 |                |                |
                 v                v                v
            native bytes      versioned row      object key
```

The frontend therefore has one filesystem contract, but the adapter capability record still tells the truth about how that
backend gets the work done.

The adapter contract stays deliberately small
---------------------------------------------

Every adapter implements six primitives: `stat`, `readFile`, `writeFile`, `readDir`, `createDir`, and `remove`. Everything else
is an optional acceleration or stronger native lifecycle.

This avoids a common adapter failure mode where every backend reimplements recursive copy, walk, parent creation, handles,
locking, and error normalization separately. If those policies live in every adapter, semantics drift as soon as one backend gets
a bug fix that the others do not.

Optional operations exist only when the backend can perform them natively:

```text
streamRead      -> openReadStream
write mode      -> writeStream when mode is in streamWriteModes
nativeCopy      -> copy
nativeMove      -> move
positionalWrite -> openWritableFile
syncAccess      -> openSyncFile
```

`streamWriteModes` is intentionally a list. A local file can stream replace, append, and update. An object store can usually
stream a complete replacement but cannot append bytes to an existing object in place. One `streamWrite: true` flag would hide
that difference and make callers reason from a capability that was too broad.

The adapter can additionally publish hard `limits` and a durable `partition` description. Those are facts about the configured
backend, not policy guesses. `FileSystemType.inspect()` combines them with resolved optimization controls and effective facade
support. `plan()` uses the same information before I/O, so runtime execution and preflight selection share one route model.

Route-changing optimizations are facade policy:

```text
streamRead
streamWrite
rangeRead
nativeCopy
nativeMove
```

Each defaults to enabled and can be disabled independently. This is deliberately different from capability detection. The adapter
should expose the strongest implementation it has; the caller can force the safe fallback for differential tests, observability,
provider workarounds, or policy. A disabled route is never relabelled native.

`nativeCopy` is also separate. A provider-side S3 or Azure copy can move terabytes without transferring the source through this
process, even though the same provider has no filesystem rename. The facade checks native copy before opening a source stream.
That ordering is a performance invariant, not an implementation detail:

```text
correct selection
filesystem.copy()
      |
      +-- native copy available -> adapter.copy()
      |
      `-- no native copy -------> open source stream -> transfer

incorrect selection
open source stream -> discover native copy -> source GET was already wasted
```

Paths are virtual identities, not host paths
-------------------------------------------

Every adapter receives a canonical `PathType`:

```text
/
/a
/a/b.txt
```

The adapter seam rejects or never receives forms such as:

```text
a/b
/a/
/a//b
/a/./b
/a/../b
/a\b
```

Public methods accept more convenient input and call `normalizePath()` first. This lets callers write ordinary path-like input
without making every adapter repeat normalization rules.

The host filesystem adapters map this virtual namespace under one configured host root. A virtual path cannot escape that root
after host resolution. The virtual namespace does not expose symbolic-link identity, permission bits, or arbitrary host paths
as part of the portable contract.

Record stores and object stores need different translation layers
-----------------------------------------------------------------

A value store naturally answers "what value is stored at this key?" It does not naturally answer filesystem questions such as
"what are the direct children of this directory?" `RecordStoreType` supplies the reusable record translation for that family.

The complete persisted record has a canonical `path` plus a separate `parent`. Direct directory listing can therefore use an
index or prefix query over `parent` instead of scanning and parsing every path. File bytes are base64 so the fallback shape can
survive JSON, Web Storage, document databases, and SQL text. The extra storage and encoding work is accepted only for this
complete-record path. Native file and object adapters do not use that representation.

The record contract also has optional byte lanes. A store can provide metadata-only stat, direct ranges, streaming reads, direct
materialized writes for selected modes, or streaming writes for selected modes. The generic record adapter advertises only the
lanes the store declares. Deno KV uses these lanes so a partitioned file is not reconstructed into one base64 record for stat,
listing, range reads, streaming reads, materialized append/update, or streamed replacement. Its append/update lane constructs a
new immutable generation one part at a time. This still performs provider I/O for untouched bytes, but it keeps JavaScript memory
bounded by the configured part/concurrency policy. Simpler record stores keep the small complete-record contract.

An object store has a different strength: large objects, byte ranges, prefix listing, whole-object replacement, conditional
requests, and provider-side copy. `ObjectStoreType` preserves those concepts before `createObjectAdapter()` translates them into
filesystem operations.

Files map directly to object keys. Empty directories need a marker object because a pure prefix does not exist until at least one
child exists:

```text
/photos              -> photos/              marker
/photos/a.jpg        -> photos/a.jpg
/photos/2026/b.jpg   -> photos/2026/b.jpg
```

The adapter also accepts implicit directories inferred from foreign prefixes. This matters when the bucket/container is not
created exclusively by this library.

An object namespace can contain both `mixed` and `mixed/child`. A real filesystem cannot. The filesystem view resolves an exact
`mixed` object as the file, because exact `stat()` already does that. Reads and writes follow the same rule. This creates one
stable interpretation for a foreign namespace instead of making `stat()` and `writeFile()` disagree.

Streaming stays native only when the backend really streams
-----------------------------------------------------------

`writeFile()` accepts strings, Blob, ArrayBuffer, typed-array views, ReadableStream, and AsyncIterable input.

When the selected adapter supports native streaming for the requested write mode, the facade forwards a byte stream directly.
When it does not, the facade collects the stream below `maxBufferedWriteBytes` and then calls the materialized adapter write.
Crossing the limit cancels the producer and returns `too-large`.

```text
ReadableStream
      |
      +-- native mode supported ------> adapter.writeStream()
      |
      `-- no direct adapter stream lane
             |
             v
       bounded collector
        |           |
        |           +-- over limit -> cancel producer -> too-large
        v
    Uint8Array
        |
        v
 adapter.writeFile()
```

This makes memory behavior visible. A simple record-backed adapter can accept streamed input through the public API while still
reporting an emulated stream route because the complete record is materialized before storage. A specialized record store can
report a partitioned stream lane when its own physical layout preserves backpressure. Deno KV does exactly that for
replacement streams when partitioning is enabled.

Partitioning is not hidden as an optimization. It changes durable physical layout, so the adapter publishes `mode`, part size,
threshold, maximum parts, and layout identity. Deno KV exposes `never | auto | always`. Its parts are written under a new
generation and the manifest is committed last. A pre-manifest crash can leak unreachable parts but cannot publish a partial new
logical file.

Multipart and block-upload clients use `@std/async/pool` for bounded request admission. The surrounding client still owns the
provider lifecycle: S3 waits for already-started part requests before it sends AbortMultipartUpload, while Azure documents that
uncommitted blocks have no equivalent abort operation. The pool limits concurrent work; it does not become authority for remote
commit, cleanup, or the terminal provider failure.

HTTP retry policy is separate from body replayability. Direct clients rebuild authorization on every retry and use exponential
backoff with jitter, but a mechanically replayable request can still be semantically non-idempotent. S3 multipart initiation and
completion therefore disable automatic request retry. Uploaded parts use stable part numbers and can use the normal retry policy.
The low-level S3/Azure request APIs expose `retry: false` so a caller can make the same decision for provider-specific operations.
One-shot `ReadableStream` request bodies are never retried automatically.

Object append and update are optimistic read-modify-write
--------------------------------------------------------

Object stores do not expose a portable in-place byte update. Append and update therefore use the current object as the starting
image, modify that image, and replace the object.

Without a precondition, two writers can both read version A and then publish different replacements; the later one silently
loses the earlier write. When the object client advertises conditional writes, the adapter uses the current ETag as `If-Match`.
A concurrent change then fails the replacement instead of becoming silent data loss.

```text
writer A: HEAD ETag=A -> GET A ---------> PUT if-match A -> succeeds
writer B: HEAD ETag=A -> GET A -------------------------> PUT if-match A -> fails
```

If a provider claims conditional writes but does not return an ETag for an existing object, the adapter refuses append/update.
That is safer than publishing an unconditional write while the capability record says optimistic protection exists.

The provider client can disable `conditionalWrite` when a compatible protocol implementation does not support the required
precondition. The library does not choose provider behavior from a provider-name table.

Copy and move preserve their real commit behavior
-------------------------------------------------

Native host filesystems use their copy and rename operations when available. Object stores use provider-side copy when the
client can do it. The facade removes/rejects the destination according to its own overwrite contract before invoking native copy,
so the adapter does not have to invent another overwrite policy.

When no native copy exists, file bytes move through a stream when both ends support streaming or through bounded materialization
otherwise.

A native move can be atomic or near-atomic according to the host/provider operation. The portable fallback is explicitly:

```text
copy source -> destination
      |
      +-- copy failed -> source remains
      |
      `-- copy succeeded -> remove source
```

That fallback is not atomic. A failure after copy and before remove can leave both entries. The API documents this instead of
claiming POSIX rename semantics on every backend.

Before copy or move, source and destination are checked for overlap. The library never removes an overwrite destination that is
an ancestor or descendant of the source.

Coordination protects cooperating callers, not the whole storage system
------------------------------------------------------------------------

There are two classes of mutation.

A file mutation acquires a shared tree lock plus an exclusive lock for that canonical file path:

```text
shared tree lock
      |
exclusive /a/file lock
      |
write or sync-file lifetime
```

A structural mutation such as recursive copy, move, remove, or empty-directory work acquires the exclusive tree lock:

```text
exclusive tree lock
      |
structural mutation
```

Independent files can therefore make progress concurrently while a tree mutation cannot race an active library file mutation.
The in-realm lock implementation queues new readers behind an already-waiting writer so a busy read/write workload does not
starve structural work.

`coordination: "web-locks"` uses the browser Web Locks API. `auto` uses Web Locks when exposed and falls back to in-realm FIFO
coordination. `local` is one-realm coordination only. `none` preserves cancellation and adapter semantics but makes the caller
responsible for concurrency.

None of these modes becomes a distributed lock. Separate Node processes, browser profiles, hosts, or independent applications
need provider/database coordination when same-path atomicity matters across those processes.

Synchronous and asynchronous writable resources own locks for their complete lifetime
--------------------------------------------------------------------------------------

A synchronous file is not one short method call. It owns both the adapter file resource and the facade path lock until close:

```text
facade path lock <-------- same lifetime --------> adapter sync file
       |                                              |
       +------------------- close() ------------------+
```

This prevents an asynchronous write through the same facade from entering while synchronous random access is active.
`writeAll()` loops over partial native writes until the complete input is written or the backend reports no progress.

The OPFS-shaped `createWritable()` facade stages one file image and commits it on close. Abort discards the staged image. This is
useful for compatibility with File System API write commands, including seek and truncate. It is not the recommended path for
very large sequential files because the staged image is materialized. `FileSystemType.writeFile()` can use an adapter's native
streaming path instead.

Integration direction is explicit
---------------------------------

An adapter is `ecosystem -> OPFS`. A driver is `OPFS -> ecosystem`. A bridge is only a descriptor that groups those directions;
it does not add a third translation layer to each operation.

```text
ecosystem/client -> adapter -> FileSystemType -> driver -> ecosystem contract
```

Some ecosystems are genuinely bidirectional. unstorage has a storage contract that can be consumed as a record backend and a
driver contract that can be implemented over `FileSystemType`. RxDB, db0, and Drizzle are not symmetric: their reverse
contracts require query, conflict, dialect, schema, or change-stream semantics a filesystem does not own. `defineBridge()`
therefore requires an explicit reason for unsupported directions instead of encouraging a false adapter.

Cancellation and disposal are different operations
--------------------------------------------------

An `AbortSignal` asks active work to stop before a commit when possible. Closing a filesystem ends ownership of the facade.
Closing the facade does not dispose the adapter unless `disposeAdapter: true` transferred that ownership.

The same rule continues below the adapter:

```text
caller creates database/client/cache
      |
      +--> adapter borrows it
      |       |
      |       +--> filesystem closes
      |       `--> resource remains open
      |
      `--> caller still owns resource
```

An adapter option such as `disposeDatabase`, `disposeStore`, or another explicit ownership flag changes that lifecycle. The
option exists because connection pools, RxDB collections, unstorage instances, object clients, and caches are commonly shared by
more than one subsystem.

Errors normalize the portable category without erasing the provider cause
-------------------------------------------------------------------------

Browsers use DOMException names. Node/Deno/Bun expose host error codes. Databases and cloud providers have their own errors.
`toFileSystemError()` maps known failures to stable package categories while retaining the original `cause`.

S3 and Azure clients also retain provider request identities on their own errors. Those IDs matter when a service returns an
unexpected result and the provider support logs are the only authoritative trace.

Import safety follows the package graph
---------------------------------------

The root package exports the portable facade, native browser OPFS convenience path, schemas, errors, handles, and capability
probes. It does not export every adapter from the root.

```text
@okikio/opfs                    browser-safe core + native OPFS
@okikio/opfs/adapter/node       node:fs imports
@okikio/opfs/adapter/deno       Deno runtime APIs
@okikio/opfs/adapter/bun        Bun + Node-compatible APIs
@okikio/opfs/s3                 Web Fetch/Crypto S3 client
@okikio/opfs/azure              Web Fetch Azure Blob client
@okikio/opfs/adapter/drizzle    optional drizzle-orm peer
```

Importing a module does not read environment variables, configure logs, connect to providers, start workers, or mutate a global
adapter registry.

Schemas are executable contracts, not duplicated type declarations
-------------------------------------------------------------------

Project-owned structural values use Zod schemas and inferred TypeScript output types. Public schema constants end in `Schema`.
Serializable project-owned types normally end in `Type`.

Zod 4 implements Standard Schema. The exported Zod value is therefore also the Standard Schema value. Creating a second OPFS
schema wrapper would add maintenance without adding a stronger contract.
