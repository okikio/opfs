Execution environments
======================

`@okikio/opfs` separates the frontend filesystem model from backend availability. This lets the same core APIs compile in Window, WebWorker, Deno, Bun, and Node TypeScript targets while concrete adapters stay on explicit runtime subpaths.

Browser OPFS
------------

The native OPFS adapter requires `navigator.storage.getDirectory()`.

The package does not select behavior from a browser brand table. It probes the APIs the current realm exposes and preserves native failures when the browser denies storage.

### Window

Use the full async facade.

```ts
const fileSystem = await openFileSystem();
await fileSystem.writeFile("/state.json", "{}", { parents: true });
```

Do not assume `createSyncAccessHandle()` is available in Window. The sync API is capability-gated.

### DedicatedWorker

The async facade works when OPFS is exposed. A DedicatedWorker is also the intended browser context for synchronous access handles in the File System standard.

```ts
const capabilities = await probeOpfs();
if (capabilities.syncAccessExposed) {
  const file = await fileSystem.openSyncFile("/database.sqlite", {
    create: true,
    parents: true,
  });
  try {
    // synchronous random access
  } finally {
    file.close();
  }
}
```

### SharedWorker

Use the async facade. Do not infer synchronous access only from the fact that code is running in a worker. The package checks the actual handle method.

### ServiceWorker

Use async filesystem methods and keep event lifetime explicit.

```ts
self.addEventListener("message", (event) => {
  const operation = (async () => {
    const fileSystem = await openFileSystem();
    await fileSystem.writeFile("/events/latest.json", "{}", {
      parents: true,
    });
  })();

  event.waitUntil(operation);
});
```

The filesystem cannot extend a service-worker event lifetime on its own.

Iframes
-------

### Same-origin iframe

Normal `openFileSystem()` opens the storage associated with the iframe's current storage key.

### Third-party iframe

Browser storage partitioning can give a third-party iframe storage isolated by the embedding site. Normal `openFileSystem()` deliberately does not attempt to escape that policy.

For browsers that support the Storage Access API extension for OPFS, the separate iframe module can request unpartitioned access:

```ts
import {
  requestUnpartitionedFileSystem,
  supportsUnpartitionedOpfsRequest,
} from "@okikio/opfs/iframe";
```

The application must make the request from the appropriate user-activation/permission flow. The package never does it automatically.

### Opaque sandbox

A sandboxed iframe without a usable origin can reject storage access. Treat `probeOpfs().rootAvailable` and the returned root error as the source of truth for that context.

Private browsing
----------------

Private/incognito modes can change storage quota, persistence, availability, or lifetime. The package does not fingerprint the browsing mode.

The decision flow is:

```text
probe actual capability
        |
        +-- root available -> use selected OPFS strategy
        |
        +-- root unavailable -> inspect normalized error
                                choose application fallback
```

This is more reliable than inferring behavior from a browser/private-mode label.

`file:` documents
-----------------

Current browser behavior for OPFS in `file:` documents is not fully interoperable. The WHATWG File System issue tracker contains an active request to specify this case more clearly.

Do not promise OPFS availability for a packaged `file:` application. Probe the actual context.

Web Locks
---------

When `coordination: "auto"`, the facade uses Web Locks if `navigator.locks` is available. This can coordinate cooperating tabs and workers that share the same origin and lock names.

If Web Locks are unavailable, `auto` falls back to one-realm FIFO locks. That fallback cannot coordinate another tab, worker realm, or OS process.

Deno
----

Use `@okikio/opfs/adapter/deno`.

```ts
const fileSystem = createFileSystem(
  createDenoAdapter({ root: "./data" }),
  { coordination: "local" },
);
```

The runtime needs filesystem permissions appropriate for the configured root. The adapter does not request broader permissions or inspect environment variables itself.

Native move and sync random access are available through Deno filesystem APIs.

Bun
---

Use `@okikio/opfs/adapter/bun`.

The adapter uses Bun's file primitives where they provide a clear benefit and Bun's Node-compatible filesystem surface for directory/update/sync operations.

The root entrypoint never imports the Bun adapter, so browser code does not evaluate Bun-specific code accidentally.

Node
----

Use `@okikio/opfs/adapter/node`.

The adapter uses `node:fs` and `node:fs/promises`. It supports streaming, range reads, rename, synchronous random access, and flush.

The configured host root is the only directory intentionally exposed through the virtual namespace.

Electron
--------

The Node adapter is suitable for a trusted Electron main-process filesystem layer. Do not expose arbitrary host roots directly to untrusted renderer content merely because the frontend API resembles OPFS.

A renderer can instead communicate with a controlled main-process service or use browser OPFS where that matches the application model.

Record/database backends
------------------------

RxDB, unstorage, db0, and Drizzle integrations work in any runtime where the injected upstream resource works and where the package's core Web APIs (`ReadableStream`, `Blob`, `File`, `TextEncoder`, AbortSignal) are available.

Their filesystem file bodies are record-backed, so stream writes are bounded-buffer operations rather than native streaming.

Server coordination
-------------------

`coordination: "local"` coordinates only within one JavaScript realm. It does not serialize writes across separate Node/Deno/Bun processes or separate hosts.

Database-backed applications that need cross-process same-path atomicity must use backend-level transactions, leases, advisory locks, or another coordination mechanism suitable for that provider.
