# Execution environments

## Purpose

`@okikio/opfs` keeps the portable filesystem frontend separate from the runtime/backend driver. The root module remains
safe to import in Window, workers, Deno, Bun, and Node. Runtime-specific code stays on explicit driver/adapter subpaths.

The package does not select behavior from a runtime-brand table. It probes actual browser capabilities and reads
configured driver capabilities/requirements.

## Browser OPFS

Native browser OPFS begins with `navigator.storage.getDirectory()`.

The root convenience path is:

```ts
import { openFileSystem } from "@okikio/opfs";

await using fileSystem = await openFileSystem();
```

The explicit layers are:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createFileAdapter } from "@okikio/opfs/adapter/file";
import { createOpfsDriver } from "@okikio/opfs/driver/opfs";

const root = await navigator.storage.getDirectory();
const driver = createOpfsDriver(root);
const fileSystem = createFileSystem(createFileAdapter(driver));
```

### Window

Use the asynchronous filesystem API. Do not assume sync access is available from Window.

### DedicatedWorker

Use asynchronous methods normally. `openSyncFile()` succeeds only when the actual OPFS file handle exposes synchronous
access in that realm. The library probes the method rather than inferring support from the worker type.

### SharedWorker

Use the same capability-driven approach. A SharedWorker does not automatically imply synchronous access.

### ServiceWorker

Use asynchronous methods and keep the event lifetime explicit:

```ts
self.addEventListener("message", (event) => {
  const work = (async () => {
    const fileSystem = await openFileSystem();
    await fileSystem.writeFile("/events/latest.json", "{}", { parents: true });
  })();

  event.waitUntil(work);
});
```

The filesystem cannot extend a ServiceWorker event lifetime by itself.

## Iframes and storage partitioning

A same-origin iframe opens storage for its current storage key normally.

A third-party iframe can receive partitioned storage according to browser policy. Normal `openFileSystem()` does not
attempt to escape that policy.

`@okikio/opfs/iframe` contains the explicit Storage Access API-related OPFS request helpers for browsers that expose
them:

```text
supportsUnpartitionedOpfsRequest
requestUnpartitionedFileSystem
```

The application owns user activation and permission presentation.

A sandboxed opaque-origin iframe can reject storage. Use `probeOpfs()` and the actual normalized error rather than
browser-name guessing.

## Private browsing and quota

Private/incognito modes can change availability, quota, persistence, and lifetime. The package does not fingerprint
private browsing.

```text
probe actual storage capability
        |
        +-- available -> use selected route
        `-- unavailable -> inspect problem/error and choose application fallback
```

Quota is a dynamic fact. A driver/facade should not advertise one fixed unlimited capacity when the browser/provider
does not guarantee it.

## Web Locks

`coordination: "auto"` uses Web Locks when available and otherwise falls back to one-realm local FIFO locks.

`web-locks` can coordinate cooperating same-storage-key browser realms using the same lock names. `local` cannot
coordinate a separate tab/worker process. `none` disables library coordination.

## Deno

Use the convenience adapter:

```ts
import { createDenoAdapter } from "@okikio/opfs/adapter/deno";
```

or the explicit driver:

```ts
import { createDenoDriver } from "@okikio/opfs/driver/deno";
```

The configured `root` becomes virtual `/`. The runtime needs the filesystem permissions selected by the host
application.

Deno KV is a separate record driver under `driver/deno-kv`. It is not the host-filesystem driver.

## Node

Use `driver/node` and `adapter/node`. The driver uses `node:fs`/`node:fs/promises`/`node:stream` through the explicit
runtime subpath and maps virtual paths below one configured host root.

Node supports native streaming, ranges, copy, rename/move, positional writes, and synchronous random access where
implemented by the driver.

The package engine range starts at Node 22.18. A validation host below that version can provide supplemental evidence
but cannot stand in for the declared runtime matrix.

## Bun

Use `driver/bun` and `adapter/bun`.

The driver resolves Bun lazily. It uses Bun's native file primitives for the paths where they provide a clear benefit
and the Node-compatible file driver for operations that require stronger host-filesystem behavior.

Bun runtime tests are required before claiming Bun behavior complete. Structural TypeScript compatibility alone is not
runtime evidence.

## Electron

A trusted Electron main process can use the Node file driver. Do not expose an arbitrary host root directly to untrusted
renderer content merely because the public API looks like OPFS. A renderer should use a controlled IPC service or
browser OPFS according to the application's security model.

## Record/database environments

localStorage, IndexedDB, Cache Storage, RxDB, unstorage, db0, Drizzle, and SQLite integrations work where their injected
upstream resource and the required Web primitives are available.

The driver describes backend requirements. The adapter/facade describes effective filesystem routes. Database-backed
record storage generally cannot claim native streaming unless the driver implements a dedicated byte lane.

## Server coordination

`coordination: "local"` is one JavaScript realm only. It does not serialize two Node/Deno/Bun processes or two machines.

When cross-process same-path atomicity is required, use the actual backend primitive:

```text
database transaction
advisory lock
lease
provider conditional write
provider-specific lock/serialization
```

A facade-local lock cannot upgrade a best-effort database replacement into a distributed transaction.

## Import safety

The root package and provider-neutral core do not import runtime-specific implementations automatically.

Use explicit subpaths for:

```text
driver/node
driver/deno
driver/bun
driver/deno-kv
driver/s3
driver/azure
adapter/*
```

No driver reads environment variables or configures global application logging at import time.
