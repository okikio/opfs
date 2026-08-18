# Ecosystem integrations

## Purpose

Storage ecosystems can connect to `@okikio/opfs` in two different directions. The package names those directions
explicitly and does not force symmetry where the upstream contract cannot be implemented correctly.

```text
ecosystem/native resource                  FileSystemType
          |                                     |
        driver                                  bridge
          |                                     |
        adapter                                 v
          |                                ecosystem API
          v
    FileSystemType
```

`integration` definitions describe the two directions. They are metadata, not bridges.

## Direction inventory

| Integration | ecosystem -> OPFS | OPFS -> ecosystem | Reverse status                                                             |
| ----------- | ----------------- | ----------------- | -------------------------------------------------------------------------- |
| unstorage   | yes               | yes               | `bridge/unstorage` implements a real Driver-shaped contract                |
| RxDB        | yes               | no                | a complete reverse path must implement `RxStorage`                         |
| db0         | yes               | no                | a filesystem is not a SQL database/query engine                            |
| Drizzle     | yes               | no                | a filesystem is not a Drizzle dialect/schema/query engine                  |
| generic KV  | n/a               | yes               | `bridge/kv` exposes the small contract the filesystem can actually satisfy |

`defineIntegration()` validates that declared support and constructors agree. An unsupported direction must have a
reason.

## unstorage

### unstorage as the backend

The forward direction accepts unstorage's high-level `Storage` object:

```text
unstorage Storage
      |
createUnstorageDriver
      |
createRecordAdapter
      |
FileSystemType
```

This means the package does not reimplement unstorage's provider catalogue. Memory, filesystem, Redis, S3, Azure,
Cloudflare, Deno KV, IndexedDB, db0, or another upstream driver remains unstorage's responsibility.

The OPFS record driver uses a private prefix and reversible key encoding. Read-only storage can be declared read-only at
the adapter layer.

### FileSystemType as an unstorage Driver

The reverse direction is a real bridge:

```text
unstorage
    |
createUnstorageBridge(fileSystem)
    |
FileSystemType
```

The bridge supports values, raw bytes, metadata, keys, clear, and disposal behavior used by the stable unstorage Driver
surface implemented here.

A private directory+leaf layout is necessary because unstorage can contain both:

```text
foo
foo:bar
```

A normal filesystem cannot make `/foo` both a file and a directory, so the bridge stores each exact value in a private
`value` leaf below its encoded hierarchy directory.

Literal percent/tilde and separator-like characters are encoded reversibly so logical keys cannot collide.

## RxDB

The forward driver targets an injected `RxCollection`:

```text
chosen RxStorage
      |
   RxCollection
      |
 createRxDbDriver
      |
 record adapter
      |
 FileSystemType
```

RxDB remains responsible for the selected `RxStorage`, document revision/conflict behavior, wrappers, replication,
multi-instance coordination, and licensing.

`RxDbRecordJsonSchema` defines the collection shape expected by this integration:

```text
path        primary key
parent      indexed direct-parent path
name
kind
data
size
lastModified
mediaType
```

The path fields have an explicit length ceiling because RxDB indexed string fields need a declared maximum length in the
supported schema shape. The driver rejects an oversized path before it asks the collection to query or write it.

### Why there is no reverse RxDB bridge yet

RxDB's storage-engine contract is `RxStorage`, not a key/value object. A real implementation must own semantics such as:

- bulk writes with per-document conflict results;
- prepared Mango queries and counts;
- attachments;
- changed-document checkpoints;
- change streams;
- cleanup of deleted documents;
- multi-instance behavior where applicable;
- close and remove lifecycle.

`FileSystemType` does not provide those semantics automatically. A future `bridge/rxdb` should therefore be a
substantial RxStorage implementation with its own tests and performance model, not a wrapper that renames filesystem
methods.

## db0

The db0 direction begins with an already connected `Database`:

```text
db0 connector
     |
  Database + dialect
     |
createDb0Driver
     |
record adapter
     |
FileSystemType
```

The current dialect branches are:

```text
sqlite
libsql
postgresql
mysql
```

The driver generates the table/CRUD SQL required for the selected dialect. It targets db0's portable database/statement
contract rather than connector names.

The path primary key uses a SHA-256 identity while the original path is retained separately. That avoids assuming
arbitrary long text is a portable primary-key type across the supported SQL families.

The table is initialized only when requested. The injected database remains caller-owned unless `disposeDatabase` is
true.

There is no reverse db0 bridge because a filesystem cannot implement arbitrary SQL parsing, query planning,
transactions, dialects, schema metadata, or connector behavior.

## Drizzle

Drizzle is also a forward record driver, but the schema stays caller-owned:

```text
Drizzle database + table
          |
 createDrizzleDriver
          |
    record adapter
          |
    FileSystemType
```

The caller provides columns for:

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

`path` must be unique or a primary key. `size` and `lastModified` must round-trip JavaScript safe integers.

The generic driver uses Drizzle's common CRUD surface. Replacement is delete then insert, so the driver reports
best-effort replacement. This route is serialized inside one cooperating `FileSystemType`, but it is not an atomic
cross-process database replacement.

A database-specific Drizzle driver can expose stronger upsert, transaction, binary, and partition behavior without
changing the portable generic integration.

### Drizzle-backed filesystem versus Drizzle over OPFS-backed SQLite

These architectures are opposite directions.

**A. Database-backed filesystem** is implemented now:

```text
Drizzle
   |
database rows
   |
record driver
   |
FileSystemType
```

**B. Drizzle over an OPFS-backed SQLite database** requires SQLite below Drizzle:

```text
application
   |
Drizzle ORM
   |
SQLite engine
   |
SQLite VFS
   |
FileSystemType / native OPFS
```

The current `driver/sqlite` does not implement a VFS. It stores OPFS logical records inside SQLite rows.

A future SQLite VFS should be designed against the SQLite engine's actual VFS/file contract. It can then use
`FileSystemType` where that contract can be mapped correctly, including sync-access and locking requirements. Drizzle
can sit above the SQLite engine normally.

## SQLite

The current SQLite driver is intentionally direct and small. It consumes an injected connected SQLite database that can
prepare and run statements.

Use it when the application already has a SQLite database and wants to store a virtual filesystem in rows.

Do not use it as evidence that arbitrary SQLite WASM engines can already store their database file on this package. That
second capability is future VFS work.

## Generic key/value bridge

`createKeyValueBridge(fileSystem)` is a reverse bridge with a deliberately small contract:

```text
has
get / set
getRaw / setRaw
remove
meta
keys
clear
inspect
plan
getMetrics
dispose
```

It is useful for ecosystem adapters that need hierarchical string/raw values but do not need SQL, document queries, or
conflict semantics.

It exposes the backing filesystem's inspection and plan results rather than inventing a separate capability system.

## Direction metadata

`integration/definition` exists so applications and third-party packages can reason about asymmetry without executing
storage constructors.

```ts
import { defineIntegration } from "@okikio/opfs/integration/definition";

const integration = defineIntegration({
  name: "example",
  directions: {
    toOpfs: { supported: true },
    fromOpfs: {
      supported: false,
      reason: "The upstream reverse contract requires query semantics.",
    },
  },
  toOpfs(source) {
    return createExampleAdapter(source);
  },
});
```

There is no global registration. Applications import the integration definitions they want to use.

## Choosing an integration

Start from the resource the application already owns.

| Existing resource                             | Preferred path                            |
| --------------------------------------------- | ----------------------------------------- |
| unstorage `Storage`                           | `driver/unstorage` -> `adapter/unstorage` |
| RxDB `RxCollection`                           | `driver/rxdb` -> `adapter/rxdb`           |
| db0 `Database`                                | `driver/db0` -> `adapter/db0`             |
| Drizzle database + table                      | `driver/drizzle` -> `adapter/drizzle`     |
| connected SQLite database                     | `driver/sqlite` -> `adapter/sqlite`       |
| custom value/document storage                 | `driver/record` -> `adapter/record`       |
| existing `FileSystemType` needed as KV        | `bridge/kv`                               |
| existing `FileSystemType` needed by unstorage | `bridge/unstorage`                        |

Do not wrap a resource through an unrelated ecosystem only to reach OPFS. Every additional abstraction adds semantics,
requirements, failure behavior, and measurable overhead.
