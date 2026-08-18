# Architecture and invariants

## Purpose

`@okikio/opfs` is a storage programming model with an OPFS-shaped filesystem frontend. The package supports storage
systems that have very different native contracts. Browser OPFS exposes file and directory handles. Node, Deno, and Bun
expose host file APIs. Deno KV and IndexedDB expose values and transactions. S3 and Azure Blob expose object protocols.
Drizzle, db0, RxDB, and unstorage sit above their own storage engines.

The architecture keeps those differences visible while giving applications one portable filesystem API where that API
can be implemented correctly.

The defining path is:

```text
native API / ecosystem
        |
        v
      client            optional protocol client
        |
        v
      driver            backend-native persistence
        |
        v
      adapter           driver -> canonical filesystem primitives
        |
        v
   FileSystemType       portable OPFS-shaped behavior
        |
        v
      bridge            FileSystemType -> real ecosystem contract
```

`integration` definitions are separate metadata that describe which of the two directions exist. They are not executable
bridges.

## Layer ownership

### Client

A client owns a wire protocol when the protocol is useful independently of the filesystem abstraction.

Current examples:

```text
src/s3.ts       S3 REST + SigV4 + multipart + request policy
src/azure.ts    Azure Blob REST + authentication + block upload + request policy
```

A client can expose protocol operations that do not belong in a filesystem. For example, an S3 client can retain ETags,
conditional requests, upload IDs, provider request IDs, presigned requests, object metadata, and multipart controls.

Node, Deno, Bun, OPFS, IndexedDB, and localStorage do not need a package-owned protocol client. They begin at the driver
layer.

### Driver

A driver owns one configured backend's storage mechanics. It must remain useful without `FileSystemType`.

A driver owns:

- backend-native operations;
- required resources and current availability facts;
- provider hard limits;
- implementation safety limits;
- caller-selected policy limits;
- dynamic limits that still require a probe;
- driver-specific optimization switches;
- deterministic preflight planning;
- physical backend metrics when available;
- disposal of resources whose ownership was explicitly transferred.

A driver does not own recursive filesystem semantics merely because the adapter above it needs them.

The three reusable driver families are:

```text
FileDriverType
  OPFS / Node / Deno / Bun

RecordDriverType
  memory / Deno KV / localStorage / IndexedDB / Cache
  SQLite rows / db0 / Drizzle / RxDB / unstorage

ObjectDriverType
  S3 / Azure Blob / custom object storage
```

These families preserve stronger native concepts. They are not a forced lowest-common-denominator interface.

### Adapter

An adapter is deliberately smaller. It translates one driver into the filesystem primitive set consumed by
`FileSystemType`.

Required adapter primitives:

```text
stat
readFile
writeFile
readDir
createDir
remove
```

Optional direct routes:

```text
openReadStream
writeStream
copy
move
openWritableFile
openSyncFile
```

The adapter reports whether those direct routes are native. It does not say that a portable operation is unavailable
merely because the facade can emulate it.

This distinction is important:

```text
adapter.nativeMove = false
FileSystemType.move() can still exist as copy + remove
```

The first value describes the translation layer. The second describes the effective public route.

### FileSystemType

`FileSystemType` owns portable filesystem behavior:

- canonical virtual paths;
- parent creation;
- OPFS-shaped file and directory handles;
- recursive walk, copy, move, remove, and empty-directory operations;
- staged writable-file semantics;
- synchronization and lock lifetime;
- bounded stream materialization when a backend cannot stream;
- normalized filesystem failures;
- logical metrics;
- adapter/facade optimization switches;
- composition of driver preflight with adapter and facade policy.

The facade must not claim that an emulated route has the atomicity, consistency, or memory behavior of a native route.

### Bridge

A bridge starts from an existing `FileSystemType` and implements another ecosystem's real contract.

Current bridges are:

```text
bridge/kv           hierarchical asynchronous key/value view
bridge/unstorage    unstorage Driver-shaped view
```

A bridge is valid only when the filesystem can satisfy the ecosystem contract. A filesystem cannot become a SQL engine
by renaming methods. A real RxDB reverse bridge would need to implement the complete `RxStorage` semantics, including
conflict, query, checkpoint, change-stream, cleanup, and lifecycle behavior.

### Integration definition

`integration/definition` stores import-safe direction metadata:

```text
toOpfs     ecosystem/native resource -> driver/adapter -> FileSystemType
fromOpfs   FileSystemType -> ecosystem bridge
```

An unsupported direction must state why it is unsupported. A definition never substitutes for the missing executable
contract.

## Driver definitions and third-party extension

`defineDriver()` is the smallest third-party extension seam. It validates structured driver metadata without registering
global state.

```ts
import { defineDriver } from "@okikio/opfs/driver";

const driver = defineDriver({
  name: "example",
  kind: "record",
  provides: ["get", "set", "delete", "list"],
  ownership: "borrowed",
  requirements: [
    { code: "database", state: "available" },
  ],
  limits: [
    {
      code: "value-bytes",
      kind: "hard",
      source: "provider",
      unit: "bytes",
      value: 64 * 1024,
    },
  ],
  optimizations: [
    {
      code: "partition",
      enabled: true,
      changesBehavior: true,
      disableable: true,
    },
  ],
});
```

`provides` records stable backend capability names for inspection. It is an open vocabulary so a provider-specific
driver can report operations beyond the three core driver families. `ownership` reports the long-lived backend resource
relationship:

```text
none      no disposable external backend resource is owned by this driver
borrowed  the caller retains ownership of the injected backend resource
owned     the driver owns the backend resource and can release it
```

This report is separate from method presence. Typed file, record, and object driver contracts remain the operational
API.

A concrete storage implementation should normally use `defineFileDriver()`, `defineRecordDriver()`, or
`defineObjectDriver()` so its operational contract is type-checked as well as its metadata.

No process-global driver or adapter registry is required. A package can export a definition and normal constructors. The
application chooses and composes them explicitly.

## Requirements describe availability

A requirement is structured data with a stable `code` and one state:

```text
available
missing
unknown
```

A requirement can describe facts such as:

```text
Deno KV database supplied
IndexedDB exposed in the current realm
S3 credentials resolved
browser OPFS root acquired
transaction capability supplied by a database integration
```

A driver should not run hidden provider I/O from `inspect()` merely to turn every unknown into a known value. Dynamic
facts can remain unknown until the caller runs an explicit probe or performs the operation.

## Limits have provenance

A numeric limit is not meaningful unless the caller can tell where it came from.

`LimitType` records:

```text
code
kind      hard | policy | dynamic
source    provider | implementation | user | probe
unit      bytes | count | milliseconds | operations
value     optional for a dynamic unknown
```

Examples:

```text
Deno KV serialized value ceiling
  kind: hard
  source: provider

Deno KV conservative inline decoded-body budget
  kind: policy
  source: implementation/user

maxParts chosen by the application
  kind: policy
  source: user

available browser storage quota
  kind: dynamic
  source: probe
```

Missing limits mean unknown. They never mean unlimited.

## Optimizations are inspectable policy

Every optimization that can change observable behavior must be independently disableable.

Observable behavior includes more than returned bytes. It includes:

- request count;
- failure timing;
- storage layout;
- atomicity or visibility points;
- consistency/caching behavior;
- provider-side resource lifetime;
- retry/cancellation timing;
- memory use when the alternate route has different materialization behavior.

`DriverOptimizationSchema` enforces the critical invariant:

> `changesBehavior: true` requires `disableable: true`.

Current examples include:

```text
S3 delayed multipart promotion
S3 derived signing-key cache
Azure block upload
Azure server-side copy
Deno KV partition layout
```

The facade has its own route switches for streaming, ranges, native copy, and native move. Driver and facade switches
remain separate because they control different layers.

## Planning is deterministic

A driver planner accepts the concrete operation shape:

```text
operation
canonical path
canonical destination when relevant
logical size when known
input bytes when different from final size
bytes vs stream source
write mode
range flag
```

`plan()` performs no storage or network I/O. It returns:

```text
supported
support       native | partitioned | unsupported at the driver layer
partBytes
parts
problems[]
actions[]
```

Problems and actions are structured. Their human messages are not the identity used by application logic.

The facade planner then adds adapter and filesystem facts. One final plan can therefore explain all of these at once:

```text
driver: Deno KV key exceeds a provider serialized-key ceiling
adapter: no native range route
filesystem: requested stream would exceed maxBufferedWriteBytes
```

The caller can distinguish each cause and choose a concrete action.

## File drivers

A file driver is closest to native OPFS semantics. Node, Deno, Bun, and browser OPFS can expose direct ranges, streams,
native copy/move, asynchronous positional files, or synchronous random access when the runtime supports them.

The adapter above a file driver is intentionally close to delegation:

```text
Node file APIs
    |
Node file driver
    |
file adapter
    |
FileSystemType
```

The host-path mapper lives with drivers. It maps virtual `/` below one configured host directory and rejects escape from
that host root.

## Record drivers

Record storage naturally addresses complete values or documents instead of files. `RecordDriverType` therefore defines
logical record operations plus optional stronger byte lanes.

Portable record methods:

```text
get(path)
set(record)
delete(path)
list(parent)
```

Optional stronger methods:

```text
stat(path)                 metadata without body reconstruction
readFile(path, range)      direct byte/range access
openReadStream(path)       direct streaming
writeFile(path, bytes)     direct write modes
writeStream(path, stream)  direct streaming write modes
```

The driver declares replacement semantics, binary support, and transaction availability separately. This lets a SQLite
or Deno KV driver preserve stronger behavior without pretending localStorage has it.

The generic record format remains a portable fallback. It uses base64 file bodies because JSON/document/text-column
stores can all preserve that representation. A specialized driver is free to use native BLOB/byte storage internally and
expose the same logical record contract above it.

## Object drivers

Object storage preserves object semantics before the adapter translates them into files/directories.

An object driver can retain:

- ranged GET;
- conditional writes;
- validators/ETags;
- provider object versions;
- metadata;
- native/server-side copy;
- multipart/block upload;
- continuation tokens;
- provider request metrics.

The filesystem adapter does not remove these concepts from the driver. It uses the subset required to provide canonical
filesystem primitives.

## Partitioning belongs to drivers

Partitioning changes physical storage layout, so it belongs at the backend driver layer.

Examples:

```text
Deno KV     one logical file -> manifest + value parts
S3          one object upload -> multipart upload parts
Azure Blob  one blob upload -> blocks + committed block list
SQL         possible future file row -> part rows / BLOB segments
```

These systems have different visibility, cleanup, atomicity, and retry rules. A universal facade chunker would hide
those provider-specific guarantees.

A partitioning strategy should describe:

```text
whether it changes durable layout
its activation policy
part size
part count ceiling
visibility/commit point
cleanup behavior
streaming capability
memory behavior
whether callers can disable it
```

## Deno KV reference layout

Deno KV demonstrates the full model.

The provider documents serialized key/value limits. The driver also chooses smaller decoded-body budgets because a raw
byte count is not equal to serialized value size.

The large-file layout uses an immutable generation and manifest-last publication:

```text
old manifest -> old generation

write new part 0
write new part 1
...
write new part N
       |
       v
write new manifest       logical visibility point
       |
       v
remove old reachable generation
```

If part writing fails, the new manifest is not published. The previous generation remains visible. The driver
best-effort removes parts from the failed generation.

A process crash before publication can still leave unreachable physical parts. That is storage leakage, not a partially
visible logical file. `DenoKvDriverType.collect()` exposes explicit, age-gated reclamation. The default one-hour grace
period avoids ordinary collection racing a recent unpublished generation, and `maxDeletes` bounds one maintenance pass.
Background deletion is not hidden inside ordinary reads or writes.

The Deno KV planner also estimates physical tuple size from the concrete logical path. A file can be small enough to fit
by byte count while its physical key is too large. The planner reports that condition before provider I/O.

## Filesystem path invariant

Every adapter and driver path that participates in the filesystem seam is canonical:

```text
/
/a
/a/b.txt
```

The public facade can accept normalizable input, but `normalizePath()` runs before backend calls. Root escape,
backslashes, and NUL are rejected.

The virtual path namespace is not an operating-system path namespace. Host file drivers map the canonical path below one
configured host root.

## Streaming and memory invariant

Large file size must not automatically become JavaScript heap size.

A native streaming route is used only when the selected driver and adapter expose it and the corresponding optimization
is enabled. Otherwise the facade can materialize an input only up to `maxBufferedWriteBytes`.

```text
stream
  |
  +-- native driver route --------------------> bounded backend streaming
  |
  `-- facade fallback -> bounded collector
                         |
                         +-- under limit -> materialized adapter write
                         `-- over limit  -> cancel producer + too-large
```

The capability report distinguishes those routes. It does not label a buffered fallback as native streaming.

## Writable-file invariant

OPFS-shaped `createWritable()` stages a logical file image and commits on close. Abort discards the staged image.

This is useful compatibility behavior, not the preferred large sequential write path. A caller that can use
`writeFile()` gives the facade a chance to select a true streaming adapter route.

## Synchronous-file lifetime

A synchronous file has two coupled resources:

```text
facade path lock <------ same lifetime ------> driver sync file
       |                                         |
       +---------------- close() ----------------+
```

The path lock must remain held for the native file lifetime. `writeAll()` repeats partial writes until the complete
input is written or the backend reports no progress.

## Coordination invariant

The facade coordinates callers that use the same library lock namespace.

File mutation:

```text
shared tree lock
      |
exclusive file-path lock
      |
write / writable file / sync file lifetime
```

Structural mutation:

```text
exclusive tree lock
      |
copy / move / recursive remove / emptyDir
```

`local` coordination only spans one JavaScript realm. `web-locks` can coordinate cooperating browser realms that share
the lock namespace. `none` performs no library coordination.

Database or distributed applications that require cross-process serialization must use the database/provider's real
transaction, lease, advisory-lock, or equivalent primitive. A local facade lock cannot provide that guarantee.

## Copy and move invariant

Native copy and native move are separate capabilities.

A native copy can avoid routing bytes through JavaScript. Object stores commonly provide this even when they cannot
provide rename semantics.

When native move is absent:

```text
source -> copy -> destination
  |
  `---------- remove source after successful copy
```

This fallback is not atomic. A failure after copy can leave both paths. Inspection and planning identify the route as
emulated.

Source/destination overlap is checked before recursive structural work. An overwrite cannot delete an ancestor or
descendant that contains the source.

## Database topology invariant

Two database directions must remain distinct.

Database-backed filesystem:

```text
Drizzle/db0/RxDB/SQLite database
          |
      record driver
          |
      record adapter
          |
     FileSystemType
```

SQLite database stored on OPFS:

```text
application
    |
  Drizzle
    |
SQLite engine
    |
SQLite VFS
    |
FileSystemType / native OPFS
```

The current `driver/sqlite` and `adapter/sqlite` implement the first topology. They do not implement a SQLite VFS. A
future VFS must implement the SQLite engine's real file/VFS contract.

## Resource ownership

Injected resources are borrowed by default.

```text
caller creates database/client/filesystem
        |
        +--> driver/adapter/bridge borrows it
        |
        `--> caller remains owner
```

Ownership transfers only through an explicit option such as:

```text
disposeDatabase
disposeStorage
disposeDriver
disposeAdapter
disposeFileSystem
```

Disposal is idempotent at the owning layer where the public contract promises idempotency. A library must not close a
shared connection or filesystem merely because a facade closes. A driver only exposes backend disposal when its
construction options transferred ownership, so higher layers cannot accidentally dispose a borrowed database or storage
instance.

Read-only policy is also a driver property for record backends. A read-only driver reports `write: false`, omits
optional write primitives, and rejects direct mutations before backend I/O. Adapters preserve that state rather than
inventing a second write policy that can disagree with the driver.

## Cancellation invariant

Cancellation asks active work to stop. Disposal releases owned resources. They are different operations.

Long-running drivers check the signal before expensive work and between bounded chunks. When the facade aborts a stream
write, it cancels the producer when practical so upstream work does not continue after the file operation has become
terminal.

Provider cleanup can need a separate bounded signal. For example, canceling an S3 multipart write must not use the
already aborted caller signal for the `AbortMultipartUpload` cleanup request.

## Error invariant

Backends fail with different error types. The facade normalizes known filesystem conditions to `FileSystemError` codes
while retaining the original cause.

```text
DOMException / Node error code / provider error
                  |
                  v
          FileSystemError
             code
             operation
             path
             cause
```

Protocol clients keep their own rich errors where provider-specific data matters. Translation into a filesystem error
happens at the storage/filesystem layer, not by deleting provider information at the client.

## Metrics are layered

Logical and physical work are not the same metric.

`MetricsType` belongs to `FileSystemType` and records logical operations, logical bytes, route selection, facade
buffering, and optional facade timing.

`DriverMetricsType` belongs to a driver and can record physical work such as:

```text
provider requests
retries
responses/failures
logical payload bytes
physical bytes
parts/blocks/chunks
peak active provider work
backend duration
cleanup duration
```

The benchmark matrix should compare each layer independently rather than attributing every cost to the facade.

## Import-safety invariant

The root package is browser-safe. Runtime/provider code remains on explicit subpaths.

```text
@okikio/opfs
@okikio/opfs/driver/node
@okikio/opfs/driver/deno
@okikio/opfs/driver/bun
@okikio/opfs/driver/s3
@okikio/opfs/driver/azure
@okikio/opfs/adapter/*
@okikio/opfs/bridge/*
```

Importing a module does not connect to storage, read environment variables, start a worker, configure global logging, or
mutate a process registry.

## Review rules

A storage change is not complete until these questions have concrete answers:

1. Which layer owns the behavior?
2. Is the provider/native contract preserved below the adapter?
3. Are provider, implementation, user, and dynamic limits distinguishable?
4. Can an observable optimization be disabled?
5. Does planning use the actual path/size/source shape needed to detect known limits?
6. Is growing work bounded by bytes, parts, concurrency, retries, or time?
7. Who owns cancellation and who owns disposal?
8. Does an emulated route state its weaker atomicity, consistency, or memory behavior?
9. Does a reverse bridge implement the ecosystem's real contract?
10. Do tests and benchmarks exercise the layer being claimed rather than bypassing it?
