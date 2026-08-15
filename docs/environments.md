Execution environments
======================

`@okikio/opfs` keeps the filesystem frontend separate from backend availability. The same core source can compile for Window,
workers, Deno, Bun, and Node while runtime-specific adapters remain on explicit subpaths.

The package does not maintain a browser-brand or runtime-brand behavior table. It asks the current realm or adapter what it can
actually do and preserves the resulting capability/failure information.

Browser OPFS follows the storage key of the current realm
---------------------------------------------------------

Native browser OPFS requires `navigator.storage.getDirectory()`.

In Window, use the asynchronous facade:

```ts
const fileSystem = await openFileSystem();
await fileSystem.writeFile("/state.json", "{}", { parents: true });
```

Do not assume synchronous access from Window. `openSyncFile()` succeeds only when the actual native file handle exposes the sync
handle API and the adapter reports that capability.

DedicatedWorker is the important worker case because browsers commonly expose synchronous OPFS access there. The library still
probes the handle instead of saying "DedicatedWorker means sync":

```ts
const capabilities = await probeOpfs();
if (capabilities.syncAccessHandleExposed) {
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

SharedWorker and ServiceWorker use the same asynchronous filesystem APIs when storage is exposed. A ServiceWorker must keep the
browser event alive itself. The filesystem cannot call `event.waitUntil()` on behalf of the application.

```ts
self.addEventListener("message", (event) => {
  event.waitUntil(saveMessage(event.data));
});
```

Iframes need policy-aware tests, not a blanket promise
-----------------------------------------------------

A same-origin iframe normally observes storage under the same applicable storage key as its embedding context.

A third-party iframe can be partitioned by browser privacy/storage policy. The package does not try to escape that policy
implicitly. The optional iframe API is separate because requesting unpartitioned storage, where the browser supports it, belongs
inside an explicit user-activation and permission flow.

An opaque sandbox can reject storage because it has no usable origin. `probeOpfs()` returns the actual root result and normalized
failure instead of inferring the outcome from the sandbox flag alone.

```text
iframe starts
    |
    v
probe actual storage API
    |
    +-- root opens ------> use selected strategy
    |
    `-- root rejected ---> preserve normalized reason -> application fallback
```

Private browsing, packaged `file:` pages, enterprise browser policy, quota, and persistence can also change availability or
lifetime. The package deliberately does not fingerprint private mode or promise OPFS on `file:` URLs. Probe the realm you are
actually running in.

Playwright tests the browser contexts directly
----------------------------------------------

The canonical browser suite uses Playwright Test projects for Chromium, Firefox, and WebKit. The test matrix exercises:

| Context or behavior | Chromium | Firefox | WebKit |
| --- | ---: | ---: | ---: |
| Window async OPFS | probe + execute | probe + execute | probe + execute |
| DedicatedWorker async | probe + execute | probe + execute | probe + execute |
| DedicatedWorker sync handle | probe + open | probe + open | probe + open |
| SharedWorker | probe + execute | probe + execute | probe + execute |
| ServiceWorker | black-box + instrumentation | black-box | black-box |
| same-origin iframe | probe + execute | probe + execute | probe + execute |
| cross-origin iframe | observe policy result | observe policy result | observe policy result |
| opaque sandbox | observe policy result | observe policy result | observe policy result |
| fresh context isolation | execute | execute | execute |
| persistent profile reopen | execute | execute | execute |
| abort before commit | execute | execute | execute |
| localStorage / IndexedDB / Cache adapters | execute | execute | execute |

Playwright's deeper ServiceWorker inspection is Chromium-specific, so only that instrumentation is browser-specific. The actual
ServiceWorker OPFS behavior stays a black-box page-to-worker message test in every browser that exposes the API.

Deno keeps the same library contracts with runtime-specific capabilities
------------------------------------------------------------------------

Use `@okikio/opfs/adapter/deno` for a host directory. The runtime needs the filesystem permissions required by the configured
root. The adapter does not request permissions or inspect environment variables itself.

Deno KV is a separate adapter because it is a record store, not a host filesystem:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createDenoKvAdapter } from "@okikio/opfs/adapter/deno-kv";

const kv = await Deno.openKv("./data.kv");
const fileSystem = createFileSystem(createDenoKvAdapter(kv));
```

Current Deno documentation still marks KV as unstable. Real Deno KV tests therefore use `--unstable-kv`. The production adapter
accepts a structural KV contract, so simply importing the module does not require a global `Deno` object.

Deno KV also has a much smaller physical value limit than an ordinary filesystem file. The adapter exposes that limit and a
partition policy through `inspect()`. With the default `partition: "auto"`, small materialized files stay inline while large
files and unknown-size replacement streams use a manifest plus raw byte parts. Callers that need a one-record layout can set
`partition: "never"`; the adapter then stops advertising its partitioned replacement-stream lane and large values fail
explicitly instead of changing layout.

Node and Bun use explicit host adapters
---------------------------------------

The Node adapter uses `node:fs` and `node:fs/promises`. It supports native streaming reads and writes, ranges, copy, rename,
synchronous random access, and flush. The configured host root is the only host directory intentionally exposed through the
virtual path namespace.

The Bun adapter uses Bun file APIs for the direct byte path and Bun's Node-compatible filesystem APIs for directory, update,
copy/move, and synchronous host-file behavior. The same public tests import `node:test`; Bun currently supports the in-process
`node:test` API when those files are run with `bun test`.

The Bun benchmark keeps two raw file-copy baselines: Node-compatible `copyFile()` and `Bun.write(destination, Bun.file(source))`.
The second path lets Bun select its file-backed Blob fast path. A Bun-only provider benchmark also compares Bun's native
`S3Client` with the AWS SDK baseline, this package's direct SigV4 client, the object adapter, and the filesystem facade. These
measurements are evidence for route selection; they do not make runtime brand part of the portable API contract.

Electron can use the Node adapter in a trusted main-process layer. The OPFS-shaped API is not a reason to expose an arbitrary host
root directly to untrusted renderer content. Use an application-specific IPC/service contract or browser OPFS where that matches
the trust model.

Object clients are runtime-neutral Web clients, but deployment policy still matters
-----------------------------------------------------------------------------------

The S3 and Azure clients use Web Fetch, Web Crypto where signing is required, Web Streams, AbortSignal, and focused `@std/*`
packages for concurrency, byte assembly, stream limits, path mapping, and XML. They are
therefore usable across Deno, Bun, Node, browsers, and workers that expose those Web APIs.

That does not make every deployment equally appropriate.

A browser calling S3 directly needs CORS rules that permit the required methods and headers. More importantly, long-lived cloud
storage secrets should not be shipped to untrusted browser code. Use short-lived scoped credentials or a trusted server design.

The same applies to Azure. SAS tokens and bearer tokens should be scoped to the actual client threat model. The library accepts a
refresh function so a long-lived process does not have to freeze one credential at client creation.

Provider endpoints can also have runtime-specific network rules. A Cloudflare Worker, browser extension, serverless host, or
corporate browser policy can allow or reject different origins. Those network policies are outside the filesystem abstraction.

Coordination scope is part of the execution environment
-------------------------------------------------------

`web-locks` can coordinate cooperating browser realms that share the relevant Web Locks namespace. `local` only coordinates one
JavaScript realm. Separate OS processes and hosts need backend-level coordination where same-path atomicity matters.

Database/object adapters can use provider transactions, ETags, versions, advisory locks, or leases where the provider exposes
them. The facade does not pretend an in-memory lock became distributed merely because the persisted bytes live on a remote
service.


Provider protocol details are kept in [S3 client protocol](./s3.md), [Azure Blob client protocol](./azure.md), and the
[provider integration test guide](./providers.md). Shared Key is intended for trusted server/Azurite contexts because it exposes
the Azure storage account key to the runtime.
