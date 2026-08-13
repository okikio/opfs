Adapter guide
=============

An adapter translates canonical virtual filesystem operations into one backend. This document describes the included adapters and the contract for new ones.

Use `createFileSystem()` for every adapter:

```ts
import { createFileSystem } from "@okikio/opfs";

const fileSystem = createFileSystem(adapter, {
  coordination: "auto",
  maxBufferedWriteBytes: 64 * 1024 * 1024,
});
```

Included adapters
-----------------

| Public subpath | Backend | Main use |
| --- | --- | --- |
| `adapter/opfs` | browser OPFS root | native browser persistence |
| `adapter/deno` | `Deno.*` file APIs | Deno services and CLIs |
| `adapter/bun` | Bun + Bun's Node-compatible fs APIs | Bun services and CLIs |
| `adapter/node` | `node:fs` | Node services, Electron main process |
| `adapter/memory` | in-memory record map | tests, examples, temporary state |
| `adapter/record` | generic `RecordStoreType` | build a new value/document/SQL adapter |
| `adapter/unstorage` | unstorage `Storage` | use any compatible unstorage mount as filesystem persistence |
| `adapter/rxdb` | RxDB `RxCollection` | use RxDB and its selected RxStorage |
| `adapter/db0` | db0 `Database` | use db0 connector/dialect infrastructure |
| `adapter/drizzle` | Drizzle database + table | use an existing Drizzle schema/driver |

### OPFS

```ts
import { openFileSystem } from "@okikio/opfs";
```

or explicitly:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createOpfsAdapter } from "@okikio/opfs/adapter/opfs";

const root = await navigator.storage.getDirectory();
const fileSystem = createFileSystem(createOpfsAdapter(root));
```

The explicit adapter retains `nativeRoot` for advanced browser interop. Synchronous access is exposed only when the current native file handle actually provides `createSyncAccessHandle()`.

The adapter does not attempt browser or incognito detection.

### Deno

```ts
import { createFileSystem } from "@okikio/opfs";
import { createDenoAdapter } from "@okikio/opfs/adapter/deno";

const fileSystem = createFileSystem(
  createDenoAdapter({ root: "./data" }),
  { coordination: "local" },
);
```

`root` is the host directory represented by virtual `/`. `createRoot` defaults to true.

The adapter uses Deno filesystem APIs for data operations, rename, sync access, and flush. It uses Node's path compatibility module only to normalize the configured host root and to verify that a virtual path stays below it.

### Bun

```ts
import { createBunAdapter } from "@okikio/opfs/adapter/bun";

const adapter = createBunAdapter({ root: "./data" });
```

The replace/read fast path uses Bun file APIs. Directory operations, update-mode writes, native rename, and synchronous random access use Bun's Node-compatible filesystem APIs.

The module resolves `Bun` lazily during adapter creation. Importing the module does not require the Bun global to exist.

### Node

```ts
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const adapter = createNodeAdapter({ root: "./data" });
```

Node supports native streaming reads/writes, byte ranges, rename, and synchronous random access.

The host root is created by default. The virtual path mapper rejects any resolved host path that would leave that root.

### Memory

```ts
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";
```

The memory adapter uses the same record-store layer as database adapters. It is intentionally deterministic and dependency-free. It is suitable for tests and temporary state, not durable storage.

The companion `createMemoryRecordStore()` is useful when testing another record-store wrapper directly.

RecordStoreType
---------------

Use `RecordStoreType` when the backend is fundamentally value-based instead of filesystem-based.

```ts
import {
  createRecordAdapter,
  type RecordStoreType,
} from "@okikio/opfs/adapter/record";

const store: RecordStoreType = {
  async get(path) { /* ... */ },
  async set(record) { /* ... */ },
  async delete(path) { /* ... */ },
  async *list(parent) { /* direct children only */ },
};

const adapter = createRecordAdapter(store, {
  name: "my-store",
});
```

Important contract rules:

- `get()` returns one validated logical path.
- `set()` replaces one logical record as atomically as the provider permits.
- `delete()` removes one record only. Recursive behavior belongs to the filesystem facade.
- `list(parent)` yields direct children only.
- The store receives canonical paths.
- The store can expose `dispose()` for resources it explicitly owns.
- Use `readOnly: true` when the storage can read but cannot mutate.

Record adapters do not claim native streaming. Their stream inputs are materialized under `maxBufferedWriteBytes`.

Custom AdapterType
------------------

Use `AdapterType` directly when the backend can expose real file-like primitives.

```ts
import {
  defineAdapter,
  type AdapterType,
} from "@okikio/opfs/adapter";

export const adapter = defineAdapter({
  name: "provider",
  capabilities: {
    read: true,
    write: true,
    streamRead: false,
    streamWrite: false,
    rangeRead: true,
    nativeMove: false,
    syncAccess: false,
  },

  async stat(path, options) { /* ... */ },
  async readFile(path, options) { /* ... */ },
  async writeFile(path, bytes, options) { /* ... */ },
  async *readDir(path, options) { /* direct children */ },
  async createDir(path, options) { /* parent already exists */ },
  async remove(path, options) { /* file or empty directory */ },
});
```

`defineAdapter()` validates the adapter name and capability object at runtime. It does not register the adapter globally.

Required adapter semantics
--------------------------

`stat`
: Return `null` only for not-found. A file stat includes size, last-modified milliseconds, and a media type string.

`readFile`
: Respect optional byte offset and maximum length. Return the bytes actually read.

`writeFile`
: Preserve `replace`, `append`, and `update` semantics. Respect `truncate` at the final write cursor.

`readDir`
: Yield direct child names and kinds lazily. Do not recursively traverse here.

`createDir`
: Create exactly one directory. The parent already exists when the facade calls this primitive.

`remove`
: Remove one file or one empty directory. Recursive behavior belongs to the facade.

Optional native operations
--------------------------

Only advertise a capability when the adapter implements the corresponding native method.

```text
streamRead  -> openReadStream
streamWrite -> writeStream
nativeMove  -> move
syncAccess  -> openSyncFile
```

`rangeRead` describes whether the adapter can avoid materializing the complete file for a range. The facade still exposes ranged `readFile()` to all adapters.

Cancellation
------------

Every async operation that accepts an `AbortSignal` should check it before expensive work and between long-running chunks. When a stream write fails or aborts, cancel the source producer when possible so upstream work does not continue after the file operation is terminal.

Errors
------

Adapters can throw native errors. The facade maps known browser and server error shapes through `toFileSystemError()`.

If an adapter itself must create a package error, use `FileSystemError` with a precise operation and canonical path. Do not return a boolean for exceptional filesystem states.

Ownership
---------

Adapters borrow injected resources unless their options explicitly transfer ownership.

Good:

```ts
createUnstorageAdapter(storage, { disposeStorage: true });
createDb0Adapter(database, { disposeDatabase: true });
createFileSystem(adapter, { disposeAdapter: true });
```

Avoid an adapter that always disposes a resource supplied by the caller.

Import safety
-------------

A concrete adapter subpath can depend on its runtime, but importing unrelated entrypoints must not pull that runtime into the graph.

Do not export server adapters from the root module. Do not probe environment variables, configure logs, connect to providers, or start workers at module evaluation time.
