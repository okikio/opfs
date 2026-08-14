@okikio/opfs
============

`@okikio/opfs` gives application code one filesystem programming model across browser OPFS, Deno, Bun, Node, key-value stores, document databases, and SQL databases.

The frontend can use either path-based filesystem methods or OPFS-shaped file and directory handles. The backend is selected with an adapter.

```text
application code
      |
      |  path API                           handle API
      |  readFile('/a.txt')                 root.getFileHandle('a.txt')
      |  writeFile('/a.txt', bytes)         file.createWritable()
      +-------------------+-------------------------+
                          |
                          v
                  FileSystemType
                          |
                          v
                     AdapterType
                          |
       +------------------+-------------------+
       |                  |                   |
       v                  v                   v
 native filesystem     RecordStoreType     custom adapter
       |                  |
       |        +---------+---------+---------+
       |        |         |         |         |
       v        v         v         v         v
 OPFS/Deno/  unstorage   RxDB      db0     Drizzle
 Bun/Node
```

This means OPFS-style application code does not have to know whether the bytes are in the browser's Origin Private File System, a server directory, an unstorage mount, an RxDB collection, a db0 database, or a Drizzle table.

The reverse direction is also supported. `@okikio/opfs/driver/unstorage` exposes any `FileSystemType` as an unstorage driver. An application can therefore mount an OPFS, Deno, Bun, Node, RxDB, db0, or Drizzle-backed filesystem inside unstorage.

Why the adapter is the important abstraction
--------------------------------------------

The browser File System API is a useful frontend contract, but OPFS is only one persistence system. A library that hard-codes `navigator.storage.getDirectory()` cannot reuse that filesystem code on a server or over a database.

This package separates the two responsibilities:

- `FileSystemType` owns virtual paths, OPFS-shaped handles, recursive operations, cancellation, coordination, errors, and resource lifecycle.
- `AdapterType` owns the smallest backend primitive set needed to persist files and directories.
- `RecordStoreType` maps the filesystem primitives onto value, document, or SQL records when a backend is not naturally file-based.

The separation is deliberate. It keeps backend-specific behavior out of application code without pretending that every backend has the same performance or durability characteristics.

Pre-release use
---------------

This source tree is being prepared for JSR and npm publication. Until the package is published, consume it through the workspace or another explicit local source reference instead of assuming the registry entry exists. After release, the intended imports are:

```ts
import { createFileSystem, openFileSystem } from "jsr:@okikio/opfs";
```

and the intended npm-compatible install is `npm install @okikio/opfs`. Release validation must prove both registry artifacts before these forms are treated as available.

Drizzle integration also needs the optional peer dependency:

```sh
npm install drizzle-orm
```

The root module is browser-safe and does not import Node, Bun, Deno, RxDB, unstorage, db0, or Drizzle at import time. Runtime-specific integrations live on explicit subpaths.

Use native browser OPFS
-----------------------

`openFileSystem()` is the shortest path when the browser's OPFS is the intended backend.

```ts
import { openFileSystem } from "@okikio/opfs";

const fileSystem = await openFileSystem();

await fileSystem.writeFile(
  "/projects/kaiju/settings.json",
  JSON.stringify({ capture: true }),
  { parents: true },
);

const settings = JSON.parse(
  await fileSystem.readText("/projects/kaiju/settings.json"),
);
```

`openFileSystem()` is equivalent to opening the native OPFS root, creating the OPFS adapter, and passing it to `createFileSystem()`.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createOpfsAdapter } from "@okikio/opfs/adapter/opfs";

const root = await navigator.storage.getDirectory();
const fileSystem = createFileSystem(createOpfsAdapter(root));
```

Use one long-lived positional file
-----------------------------------

Media muxers and database engines can rewrite earlier byte ranges while output is still open. Use `openWritableFile()` for that access pattern instead of issuing one `writeFile(update)` operation per chunk.

```ts
const file = await fileSystem.openWritableFile("/output.mp4", {
  create: true,
  parents: true,
});

try {
  await file.write(header, { at: 0 });
  await file.write(mediaChunk, { at: offset });
  await file.flush();
  await file.close();
} catch (error) {
  await file.abort(error);
  throw error;
}
```

The OPFS, Node, Deno, and Bun adapters advertise this capability. Record-backed adapters such as memory, unstorage, RxDB, db0, and Drizzle do not. They remain appropriate for small records and ordinary bounded writes, but the facade will not disguise repeated record replacement as a native positional-file resource.

Use OPFS-shaped handles over Node
---------------------------------

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const fileSystem = createFileSystem(
  createNodeAdapter({ root: "./data" }),
  { coordination: "local" },
);

const projects = await fileSystem.root.getDirectoryHandle("projects", {
  create: true,
});
const file = await projects.getFileHandle("state.json", { create: true });
const writable = await file.createWritable();

await writable.write(JSON.stringify({ ready: true }));
await writable.close();
```

The application uses a File System API-shaped frontend. The bytes are written with Node filesystem APIs below `./data`.

Deno and Bun use the same frontend:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createDenoAdapter } from "@okikio/opfs/adapter/deno";
// or: import { createBunAdapter } from "@okikio/opfs/adapter/bun";

const fileSystem = createFileSystem(
  createDenoAdapter({ root: "./data" }),
  { coordination: "local" },
);
```

Use unstorage as the backend
----------------------------

The adapter receives an already-created high-level unstorage `Storage` object. It therefore works above the individual unstorage driver choice.

```ts
import { createStorage } from "unstorage";
import memoryDriver from "unstorage/drivers/memory";
import { createFileSystem } from "@okikio/opfs";
import { createUnstorageAdapter } from "@okikio/opfs/adapter/unstorage";

const storage = createStorage({ driver: memoryDriver() });
const fileSystem = createFileSystem(createUnstorageAdapter(storage));

await fileSystem.writeFile("/cache/report.json", "{}", { parents: true });
```

The same bridge can sit above compatible unstorage fs, Redis, S3, MongoDB, IndexedDB, Cloudflare, Vercel, db0, Deno KV, and other current unstorage drivers. Some upstream drivers are read-only. Use `{ readOnly: true }` when mutations cannot be supported.

Use RxDB as the backend
-----------------------

The RxDB integration targets an `RxCollection`, not one particular `RxStorage`. Create one collection from the exported schema and then use whichever RxStorage configuration is appropriate for that database.

```ts
import { createFileSystem } from "@okikio/opfs";
import {
  createRxDbAdapter,
  RxDbRecordJsonSchema,
} from "@okikio/opfs/adapter/rxdb";

const database = await createRxDatabase({
  name: "app",
  storage: selectedRxStorage,
});

await database.addCollections({
  files: { schema: RxDbRecordJsonSchema },
});

const fileSystem = createFileSystem(
  createRxDbAdapter(database.files),
  { coordination: "local" },
);
```

This design preserves RxDB's own storage-engine abstraction. It does not clone each RxStorage implementation into this package.

Use db0 as the backend
----------------------

`createDb0Adapter()` targets db0's high-level `Database` contract. It selects portable SQL for the database's reported `sqlite`, `libsql`, `postgresql`, or `mysql` dialect.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createDb0Adapter } from "@okikio/opfs/adapter/db0";

const adapter = await createDb0Adapter(database, {
  table: "opfs_entries",
  initialize: true,
});

const fileSystem = createFileSystem(adapter, {
  coordination: "local",
});
```

The table uses a SHA-256 path identifier as its primary key and stores the canonical path separately. This avoids requiring an arbitrary-length text primary key on MySQL while preserving the original virtual path.

Use Drizzle as the backend
--------------------------

Drizzle deliberately keeps database dialects and schemas explicit. The package therefore does not invent one universal Drizzle table definition. The caller supplies a connected database and a dialect-correct table with the required columns.

```ts
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { createFileSystem } from "@okikio/opfs";
import { createDrizzleAdapter } from "@okikio/opfs/adapter/drizzle";

const files = sqliteTable("opfs_entries", {
  path: text("path").primaryKey(),
  parent: text("parent").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  data: text("data"),
  size: integer("size").notNull(),
  lastModified: integer("lastModified").notNull(),
  mediaType: text("mediaType"),
});

const fileSystem = createFileSystem(
  createDrizzleAdapter({ database, table: files }),
  { coordination: "local" },
);
```

`path` must be unique. The current bridge replaces a record with delete-then-insert so it can stay on Drizzle's common CRUD surface. That replacement is serialized by this library inside one JavaScript realm. If multiple server processes can write the same path, the application must add database-level serialization or a transaction appropriate for its dialect.

Expose a filesystem as an unstorage driver
------------------------------------------

This is the reverse adapter direction.

```ts
import { createStorage } from "unstorage";
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";
import { createUnstorageDriver } from "@okikio/opfs/driver/unstorage";

const fileSystem = createFileSystem(
  createNodeAdapter({ root: "./data" }),
);

const storage = createStorage({
  driver: createUnstorageDriver(fileSystem),
});

await storage.setItem("cache:result", { ready: true });
```

The driver reversibly maps unstorage's `:` key hierarchy to private virtual directories. Each logical key owns a dedicated `value` file inside its encoded key directory. This lets `foo` and `foo:bar` coexist even though a normal filesystem cannot make one path both a file and a directory. Characters such as `%`, `~`, `/`, spaces, and `?` are encoded so distinct keys do not collapse onto one filesystem entry.

Streaming and record-backed adapters
------------------------------------

Native filesystem adapters can stream without materializing the complete file:

| Adapter | stream read | stream write | range read | native move | sync random access |
| --- | --- | --- | --- | --- | --- |
| OPFS | yes | yes | yes | no portable native rename | DedicatedWorker when exposed |
| Deno | yes | yes | yes | yes | yes |
| Bun | yes | yes | yes | yes | yes |
| Node | yes | yes | yes | yes | yes |
| memory / record store | facade fallback | buffered | yes | no | no |
| unstorage | facade fallback | buffered | yes | no | no |
| RxDB | facade fallback | buffered | yes | no | no |
| db0 | facade fallback | buffered | yes | no | no |
| Drizzle | facade fallback | buffered | yes | no | no |

Record-backed adapters use one validated record per file or directory. File data is base64 text. This is intentionally portable across JSON/document/SQL stores, but it increases byte storage by roughly one third before provider overhead.

A streamed write to a non-streaming adapter is buffered by the facade. The default limit is 64 MiB:

```ts
const fileSystem = createFileSystem(adapter, {
  maxBufferedWriteBytes: 16 * 1024 * 1024,
});
```

If the stream crosses that limit, the producer is cancelled and the write fails with `FileSystemError` code `too-large`. The package does not silently consume unbounded memory.

Paths and filesystem behavior
-----------------------------

All backends receive the same canonical virtual paths:

```text
input:   projects/./kaiju/../state.json
result:  /projects/state.json
```

The virtual root is `/`. Paths cannot escape above it. Backslashes and NUL characters are rejected so host-specific path rules do not leak into adapter behavior.

`readDir()` and `walk()` are lazy async iterators. Recursive copy and directory clearing use bounded concurrency. Copy and move reject overlapping source and destination trees before an overwrite can destroy source data.

When an adapter advertises `nativeMove`, the facade uses it. Otherwise `move()` is copy-then-remove and is explicitly non-atomic.

Coordination and ownership
--------------------------

The default coordination mode is `auto`:

```text
file mutation
    |
    +-- shared tree lock
    +-- exclusive path lock

structural mutation
    |
    +-- exclusive tree lock
```

`auto` uses Web Locks when available and otherwise falls back to one-realm FIFO locks. `web-locks` requires Web Locks. `local` forces the one-realm implementation. `none` means another subsystem owns coordination.

Synchronous file resources keep the facade path lock for the full native file lifetime. Closing the sync file releases both the native resource and the facade lock.

Injected adapters, databases, collections, and storage objects are borrowed by default. Ownership changes only when an option explicitly says so, such as `disposeAdapter`, `disposeStorage`, `disposeDatabase`, or `disposeFileSystem`.

Errors
------

Public operations use `FileSystemError` with a stable `code`, `operation`, optional `path`, and original `cause`.

```text
unavailable
not-found
already-exists
type-mismatch
invalid-path
invalid-operation
not-supported
locked
quota-exceeded
permission-denied
aborted
too-large
unknown
```

The error mapper understands browser exception names and Node-style error codes such as `ENOENT` and `EEXIST`.

Browser execution contexts
--------------------------

Native OPFS support is capability-based, not browser-name-based. `probeOpfs()` reports what the current context can actually do. It does not attempt to classify private/incognito mode.

The async OPFS adapter is usable where the browser exposes `navigator.storage.getDirectory()`. Synchronous OPFS access is only used when the current file handle exposes `createSyncAccessHandle()`.

Third-party iframe storage is opened normally through the iframe's current storage key. A separate `@okikio/opfs/iframe` entrypoint exposes the explicit Storage Access API request for browsers that support unpartitioned OPFS access. The package never requests that permission automatically.

Service-worker code must still attach filesystem work to `event.waitUntil()` because storage I/O does not extend the service-worker event lifetime by itself.

Public entrypoints
------------------

```text
@okikio/opfs
@okikio/opfs/adapter
@okikio/opfs/adapter/opfs
@okikio/opfs/adapter/memory
@okikio/opfs/adapter/deno
@okikio/opfs/adapter/node
@okikio/opfs/adapter/bun
@okikio/opfs/adapter/record
@okikio/opfs/adapter/unstorage
@okikio/opfs/adapter/rxdb
@okikio/opfs/adapter/db0
@okikio/opfs/adapter/drizzle
@okikio/opfs/driver/unstorage
@okikio/opfs/iframe
@okikio/opfs/path
@okikio/opfs/schema
```

Read next
---------

- [`docs/api.md`](docs/api.md) explains every public API family and resource contract.
- [`docs/design.md`](docs/design.md) explains the adapter architecture, invariants, record model, coordination, and failure semantics.
- [`docs/adapters.md`](docs/adapters.md) is the implementation guide for native, record, and custom adapters.
- [`docs/ecosystems.md`](docs/ecosystems.md) explains RxDB, unstorage, db0, Drizzle, and their upstream integration points.
- [`docs/environments.md`](docs/environments.md) covers browser contexts plus Deno, Bun, and Node.
- [`docs/validation.md`](docs/validation.md) records what is tested, how it is tested, and what this host cannot verify.
- [`docs/sources.md`](docs/sources.md) records the standards, upstream source, Kaiju, Mediad, and research inputs used for this design.
