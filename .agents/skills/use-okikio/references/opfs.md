# OPFS and Storage Architecture

Use this reference for `@okikio/opfs`, browser OPFS behavior, storage-provider integrations, reverse ecosystem projections, and the recurring storage architecture developed around the OPFS work.

## Verify the implementation generation first

The OPFS design evolved through several incompatible vocabularies. Before recommending a type or file path, inspect the current source and exports. In particular, do not assume an old document's `driver` terminology still matches the current repository.

Classify each statement as implemented, tested, target design, or historical.

## Current conceptual stack

Where the repository uses the newer model, keep these concepts distinct:

```text
protocol / native API
        |
        v
      client
 protocol-specific operations
        |
        v
      driver
 backend-native storage behavior
 capabilities / limits / metrics
        |
        v
      adapter
 driver -> filesystem primitives
        |
        v
   FileSystemType
 canonical filesystem behavior
        |
        v
      bridge
 filesystem -> ecosystem contract
```

A client understands a protocol. A driver is independently useful backend storage behavior. An adapter projects a driver into the filesystem primitive set. `FileSystemType` owns portable filesystem semantics. A bridge lets another ecosystem consume the filesystem.

Do not create empty wrapper classes merely to satisfy the vocabulary. A driver must own backend-native behavior that makes sense without the filesystem facade.

## Filesystem semantics versus provider mechanics

Portable behavior belongs above adapters:

- canonical virtual paths;
- recursive copy/remove/walk;
- OPFS-shaped handles;
- facade coordination;
- stable package errors;
- stream fallback and bounded buffering;
- ownership of sync-file facade locks.

Provider mechanics remain below:

- S3 multipart upload and conditional operations;
- Azure block/blob semantics;
- Deno KV partition layouts and transactions;
- SQL/document-store transactions;
- host filesystem rename and sync access;
- provider continuation tokens, versions, quotas, and native range behavior.

Do not erase stronger provider semantics merely because every adapter cannot expose them.

## Capability model

Inspection and planning should distinguish:

```text
native
emulated
partitioned
unsupported
```

Also distinguish limit sources:

- provider hard limits;
- transaction/request limits;
- implementation safety policies;
- configured user limits;
- derived logical limits;
- dynamic quota/availability conditions.

A flat `limits` object that makes all of those look equivalent is misleading.

For an operation planner, include enough concrete input to evaluate the real limit: path/key, logical byte size, range, write mode, metadata, concurrency, conditional semantics, and source form when relevant.

## Partitioning belongs with the driver

Partitioning changes durable layout and provider behavior. Deno KV parts, S3 multipart upload, Azure blocks, and SQL chunk tables are not one generic algorithm.

A partition strategy should state:

- durable layout;
- publication/visibility point;
- atomicity or lack of it;
- part-size/count limits;
- read compatibility;
- cleanup/collection behavior;
- memory and concurrency requirements;
- whether the caller can disable it.

Behavior-changing optimizations must be independently disableable when the repository follows the current optimization policy.

## Ownership and lifecycle

Injected databases, collections, storage clients, and filesystems are borrowed by default. Transfer ownership only through an explicit option.

Cancellation asks active work to stop. Disposal releases resources. They are not synonyms.

Construction that acquires multiple resources must unwind already-acquired resources if a later acquisition fails. If cleanup also fails, preserve the primary failure and report cleanup failure without replacing it.

## Browser OPFS

Probe actual capabilities instead of guessing from browser names. Relevant execution contexts include Window, DedicatedWorker, SharedWorker, ServiceWorker, and iframe variants.

Synchronous access is capability-gated. Do not infer it merely from “worker”.

Private/incognito storage behavior, `file:` documents, iframe partitioning, and permission/user-activation paths are interoperability-sensitive. Preserve native failures and normalize them without browser fingerprinting.

## Streaming and memory

Large file size must not imply equally large JavaScript heap use. Native adapters should use native stream/range behavior when available. Record-backed adapters that must materialize input need an explicit byte limit and must cancel the producer when the limit is exceeded.

Do not label bounded buffering as native streaming.

## Ecosystem integrations

Integrate at the highest stable abstraction the application already owns:

```text
unstorage Storage
RxDB collection
DB0 Database
Drizzle database + table
custom record store
native filesystem / object client
```

Do not wrap an existing DB0 database in unstorage only to reach the filesystem layer. Each extra abstraction changes semantics and cost.

Reverse integrations are bridges. A bridge must implement the actual consuming ecosystem contract rather than expose a vaguely similar method set.

## Verification

For storage work, verify more than type compatibility:

- path normalization and root-escape rejection;
- read/write/update/append/range semantics;
- streaming and buffer limits;
- cancellation after stream open;
- close/abort exclusivity;
- copy/move overlap and overwrite behavior;
- partial acquisition cleanup;
- same-path and structural coordination;
- native provider behavior in each claimed runtime;
- package/import safety;
- capabilities, limits, metrics, and optimization toggles;
- direct driver baseline versus adapter/filesystem layer cost when performance matters.

For delivered ZIPs or packages, extract the exact artifact and rerun the available consumer/runtime checks.
