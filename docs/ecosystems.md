Ecosystem integrations
======================

The package integrates at the highest stable storage abstraction each ecosystem already provides. This is intentional. Reimplementing every upstream driver inside `@okikio/opfs` would duplicate provider code and create a second compatibility matrix that would immediately drift.

```text
unstorage:  Storage      -> RecordStoreType -> AdapterType
RxDB:       RxCollection -> RecordStoreType -> AdapterType
db0:        Database     -> RecordStoreType -> AdapterType
Drizzle:    Database+Table -> RecordStoreType -> AdapterType
```

The filesystem semantics above those bridges are identical.

unstorage
---------

`createUnstorageAdapter(storage)` accepts the high-level unstorage `Storage` contract. It uses:

```text
getItem
setItem
removeItem
getKeys
optional dispose
```

This means the bridge is independent of the mounted driver.

unstorage's generated built-in driver catalog includes these families:

- Azure App Configuration, Cosmos, Key Vault, Storage Blob, and Storage Table
- Capacitor Preferences
- Cloudflare Cache, KV binding/HTTP, and R2
- db0
- Deno KV and Deno KV Node
- fs and fs-lite
- GitHub
- HTTP
- IndexedDB
- localStorage and sessionStorage
- LRU cache and memory
- MongoDB
- Netlify Blobs
- null and overlay
- PlanetScale
- Redis
- S3
- UploadThing
- Upstash
- Vercel Blob and Vercel Runtime Cache

The list is upstream inventory, not a claim that every provider has filesystem-quality write semantics. A driver can be read-only, eventually consistent, size-limited, or expensive to enumerate. Configure `{ readOnly: true }` when the selected Storage cannot safely mutate.

The adapter stores records below a reserved key prefix, `opfs` by default. Virtual path segments are encoded reversibly before they become unstorage key segments.

```ts
const adapter = createUnstorageAdapter(storage, {
  prefix: "my-app-fs",
  readOnly: false,
  disposeStorage: false,
});
```

### Reverse unstorage direction

`createUnstorageDriver(fileSystem)` lets unstorage consume any `FileSystemType`.

```text
unstorage Storage
       |
       v
@okikio/opfs unstorage Driver
       |
       v
FileSystemType
       |
       +--- OPFS
       +--- Node/Deno/Bun
       +--- RxDB
       +--- db0
       +--- Drizzle
       +--- custom adapter
```

The driver maps `:` hierarchy segments to private filesystem directories with reversible percent-based encoding. Each key stores its payload in a dedicated `value` leaf file. This indirection is required because unstorage can hold both `foo` and `foo:bar`, while a normal filesystem cannot make `/foo` both a file and a directory. Literal `%` and literal `~` remain distinct.

`disposeFileSystem` defaults to false because the injected filesystem is borrowed.

RxDB
----

RxDB explicitly defines `RxStorage` as the storage-engine abstraction. The upstream storage interface creates `RxStorageInstance` objects that own bulk writes, queries, attachment access, change streams, cleanup, close, and remove semantics.

`@okikio/opfs` does not implement `RxStorage`. Instead it uses a normal RxDB collection whose underlying storage can be any RxStorage chosen by the application.

The package exports `RxDbRecordJsonSchema`:

```ts
await database.addCollections({
  files: { schema: RxDbRecordJsonSchema },
});

const fileSystem = createFileSystem(
  createRxDbAdapter(database.files),
);
```

The bridge uses collection operations that preserve RxDB's document concurrency semantics:

```text
findOne(path).exec()
find({ selector: { parent } }).exec()
incrementalUpsert(record)
incrementalRemove()
```

The `path` field is the primary key. `parent` is indexed for direct directory listing. The exported schema sets `maxLength: 4096` on both indexed path fields because RxDB requires a maximum length for indexed strings; the adapter rejects longer paths before querying or writing the collection.

### RxStorage coverage

As reviewed from RxDB's current storage guide on 2026-08-12, upstream documents these storage implementations and wrappers:

Native/storage implementations:

- Memory
- LocalStorage
- premium IndexedDB
- premium OPFS
- premium Filesystem Node

Storage wrappers/infrastructure:

- premium Worker
- premium SharedWorker
- Remote
- premium Sharding
- premium Memory Mapped
- premium Localstorage Meta Optimizer
- Electron IPC renderer/main integration

Third-party or premium-backed storage families documented by RxDB:

- premium Expo Filesystem
- premium SQLite
- Dexie.js
- MongoDB
- DenoKV
- FoundationDB

Because this package sits above the collection, the adapter does not need a separate implementation for each item in that list. The selected RxStorage still owns its own requirements, licensing, runtime constraints, multi-instance behavior, replication behavior, and performance characteristics.

db0
---

The db0 bridge targets the high-level `Database` interface:

```text
dialect
prepare(sql)
statement.get/all/run
optional dispose
```

The current db0 type contract reports four SQL dialects:

```text
sqlite
libsql
postgresql
mysql
```

`createDb0Adapter()` has explicit SQL generation for all four. The behavioral test suite exercises all four dialect branches.

As reviewed from db0's generated connector catalog on 2026-08-12, upstream connector names include:

- better-sqlite3
- bun-sqlite and bun alias
- Cloudflare D1
- Cloudflare Hyperdrive MySQL
- Cloudflare Hyperdrive PostgreSQL
- libSQL core, HTTP, Node, web, and alias
- mysql2
- node-sqlite and sqlite alias
- PGlite
- PlanetScale
- PostgreSQL
- sqlite3

The bridge depends on the `Database` contract and dialect, not the connector name. A connector therefore does not need bespoke OPFS code when it presents a compatible db0 Database.

Prepared statements use db0's portable `?` placeholders. PostgreSQL-family db0 connectors own translation to native `$1`, `$2`, and later parameters, so the filesystem bridge does not duplicate connector-specific parameter rewriting.

### db0 table

Default table: `opfs_entries`.

The adapter can initialize it:

```ts
const adapter = await createDb0Adapter(database, {
  initialize: true,
  table: "opfs_entries",
});
```

The path primary key is a SHA-256 hex digest. The original path is stored separately. This is important for MySQL because arbitrary `TEXT` is not a portable primary-key choice.

`parent_path` is used for directory listing. Large installations should add a provider-appropriate index through their normal migration system if directory listing becomes a hot query.

`disposeDatabase` defaults to false.

Drizzle
-------

Drizzle is not one SQL dialect. It exposes dialect-specific schema builders and many driver entrypoints. The adapter therefore does not create or migrate a universal table.

The caller provides:

1. a connected Drizzle database;
2. a table built for that database dialect;
3. the required logical columns.

Required table properties:

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

The bridge uses Drizzle's common CRUD shape:

```text
select().from(table).where(eq(...))
insert(table).values(...)
delete(table).where(eq(...))
```

That choice keeps the integration usable across Drizzle database objects that expose this common surface. It also means record replacement is delete-then-insert rather than dialect-specific upsert SQL.

### Concurrency consequence

Inside one `FileSystemType` with normal coordination, same-path mutations are serialized. Across multiple processes, hosts, or independently configured applications, delete-then-insert is not an atomic database transaction.

If cross-process atomic replacement is required, provide a database-level transaction/serialization strategy appropriate for the actual Drizzle dialect and driver. The package does not hide that requirement behind a false portability claim.

### Drizzle driver breadth

The current Drizzle source tree contains dedicated runtime/dialect integrations such as AWS Data API, better-sqlite3, Bun SQL, Bun SQLite, Cloudflare D1, Durable SQLite, Expo SQLite, and many additional PostgreSQL/MySQL/SQLite-family drivers. The package's compatibility condition is the database object's CRUD surface and the caller's correct table schema, not a hard-coded driver-name allowlist.

Choosing between the ecosystem bridges
--------------------------------------

Use the bridge for the abstraction your application already owns.

| Existing application resource | Use |
| --- | --- |
| unstorage `Storage` | `createUnstorageAdapter()` |
| RxDB collection | `createRxDbAdapter()` |
| db0 `Database` | `createDb0Adapter()` |
| Drizzle database + table | `createDrizzleAdapter()` |
| custom document/KV layer | `createRecordAdapter()` |
| host directory | Deno/Bun/Node adapter |

Do not wrap a db0 Database in unstorage merely to reach this package if the application already owns db0 directly. Each extra storage layer adds semantics and performance behavior that has to be understood.
