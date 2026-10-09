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

An adapter can also declare `capabilities.validatesReplacement`. This promises that materialized replacement writes
validate the destination kind and namespace conflicts before publication. Object adapters provide that guarantee with
fresh provider metadata and ETag admission when the backend declares conditional writes. Nonconditional backends retain
their explicitly weaker exact-object concurrency contract. The facade validates the destination by default, and the
adapter validates it again before publication. Explicitly setting `optimizations.writeAdmission: true` delegates
destination admission for materialized binary replacements to a validating adapter. This opt-in route keeps adapter
validation and its fresh ETag precondition; it does not turn validation off. An undeclared capability retains facade
admission even when delegation is requested. Parent checks and coordination still belong to the facade. String encoding,
Blob materialization, stream acquisition, append, and update keep their existing validation path so an invalid
destination cannot cause new source work.

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

## Host deployment authority

Native runtime function availability does not prove that a particular mount supports those primitives. Host drivers
validate an immutable profile and derive publication/capability facts from it. The same hard admission owns native
entrypoints and facade preflight, before metadata, parents, stages, locks, or producer acquisition. Driver requests
retain overwrite/preserve/exclusive and logical publication intent across physical write fallbacks. Advisory custom
plans cannot override backend hard admission. See [host profiles](host.md); plans remain pure and declarations remain
separate from runtime observations.

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

The host-path mapper lives with drivers. It rejects lexical virtual-path escape from one configured host directory.
Native Node, Deno, and Bun filesystem calls can still follow symbolic links that already exist below that directory. The
host root is therefore a trusted namespace mapping, not a security isolation mechanism against another process that can
create or replace links.

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
or Deno KV driver preserve stronger behavior without pretending localStorage has it. Transaction availability describes
backend mechanics used by native driver operations. It does not make the generic adapter's separate `get()` then `set()`
append/update fallback atomic across independent owners.

The generic record format remains a portable fallback. It uses base64 file bodies because JSON/document/text-column
stores can all preserve that representation. A specialized driver is free to use native BLOB/byte storage internally and
expose the same logical record contract above it. IndexedDB is one such stronger execution path for write semantics: the
driver performs replace, append, and update inside one readwrite transaction instead of delegating those modes to the
generic split read/replace fallback.

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

The large-file layout uses an immutable generation, manifest-last publication, and a durable ownership state for the
generation that is about to lose visibility:

```text
old manifest -> old generation

write new part 0
write new part 1
...
write new part N
       |
       v
check old versionstamp
       |
       v
atomic generation publication + predecessor retirement
                 logical visibility point
       |
       v
pinned readers can finish within their supported lease
       |
       v
explicit claim after grace and pin release
```

V3 stores durable generation state and checks it on each immutable part/accounting transaction. Publication and
predecessor retirement share the logical-entry version check. Readers check and renew operation-owned pins; present pin
records, including expired records awaiting transactional pruning, exactly match the generation counter. No independent
KV TTL deletes accounting records. Lost acknowledgements reconcile the same attempt token; uncertain reader cleanup
remains owned by explicit maintenance.

A collector requires an eligible generation with zero pins, changes its version to `reclaiming`, and checks that claim
while deleting each part/accounting entry. Local expiry permits revocation; the version change fences a suspended
transaction. Prepared work can commit after expiry when no state change intervenes. Readers paused beyond their lease
fail and reopen; arbitrary suspension does not promise indefinite retention.

Per-pass scan, pin and deletion budgets return an opaque continuation. Optional aggregate retained-byte/generation
admission protects partition storage when maintenance stalls; unlimited policy requires application quota and
maintenance liveness. Reclaimed state retention protects recovery before its version-checked removal. New generation
identities are not reused by the internal operation protocol. Legacy layouts require a quiescent export/import to a
fresh prefix. See [storage ownership](storage.md) for concrete APIs, state transitions, failure outcomes and costs.

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
configured host root and reject lexical escape. That mapping does not resolve every symbolic-link component before each
I/O call, so callers must not use the root option as a sandbox for untrusted host filesystem contents.

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

The byte owner validates streamed and iterable chunks as genuine `Uint8Array` values even when no signal is supplied.
Materialized `ArrayBufferView` inputs still mean their raw byte range. The buffered collector checks its byte limit
before adding each chunk, then waits for producer cancellation and reader release after a limit or conversion failure.
The limit bounds accepted payload bytes, not total process memory: retained chunk views and the completed value can
coexist, and the producer owns its own buffering.

Signal abort, cancellation, and operation cleanup share one physical reader retirement. Native EOF or a native read
rejection is terminal proof, so cleanup releases the reader without cancelling an already errored stream again. An
abort-induced read failure is published after that retirement settles. Independent read, cancel, and release failures
remain observable even when their values are equal; the facade preserves the primary filesystem category and retains the
complete owned aggregate as its cause. A Web consumer's `cancel()` can close pending reads before physical cleanup, so
its returned promise is the cancellation boundary.

Internal consumers use `openBytes()` to record actual terminal rejection delivery from their acquired reader. `retire()`
joins the same owner without reporting a stored delivered failure as a second event. An unconsumed abort, or a fault
published after a pending reader was released, remains observable during operation cleanup. These internal capabilities
are not root package exports. They do not take a borrowed lock or infer ownership from matching error values. Byte
metrics observe the same owner rather than a detached transform pipe.

The acquired reader's native `closed` rejection observes stored source failure before read delivery reactions finish.
That event prevents error and abort in the same turn from recancelling the errored source. A release-induced `closed`
rejection has separate reader ownership and is not a new producer failure. Native `closed` fulfillment alone does not
prove that queued bytes have been drained; only actual read EOF provides that proof.

Async iterable conversion shares one `return()` operation and drains an admitted `next()` before completing retirement.
An arbitrary iterator must cooperate: a queued async-generator `return()` cannot interrupt an uncooperative pending
`next()`. No disposal timeout or interruption capability is invented for that producer. Release is independently
attempted and any actual release failure is retained; a failed native release cannot certify physical closure.

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
descendant that contains the source. On Node, Deno, and Bun, these checks coordinate package callers but cannot make a
separate host process participate. External filesystem mutation can still race the later native copy or rename call.

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

The S3 and Azure upload pools wait for admitted requests to settle before reporting a failed producer. They retain the
exact producer or cancellation reason. When admitted requests also fail independently, an `AggregateError` contains the
producer reason first and the provider failures afterward, with the producer reason as its cause. A failed request
without a producer failure keeps the pool's existing aggregate error contract. Checking only whether a signal is aborted
would hide unrelated provider failures, so the pool records the actual input failure instead.

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

## Publication and resource authority

[Storage ownership](storage.md) defines preserving file routes, explicit best-effort tree replacement, physical host
entry identity, positional admission/terminal order, and bridge namespace ownership. Host copy uses an owned exclusive
sibling before replacement; a direct native overwrite copy is not a preserving primitive. Resource queues order one
descriptor and keep application staging/publication queues separate. Provider receipts identify an acknowledged own
operation; current-state HEAD remains a separate observation. Pure plans use concrete adapter physical paths and
effective source routes, while live retention/quota/connectivity stay behind explicit probes.
