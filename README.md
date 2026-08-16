@okikio/opfs
============

`@okikio/opfs` is an OPFS-shaped filesystem programming model that can sit on top of browser OPFS, host filesystems,
object stores, key-value stores, browser storage, document databases, and SQL databases.

The public filesystem owns the semantics that application code should not have to rebuild: canonical virtual paths,
OPFS-shaped handles, recursive copy and move, cancellation, staged writable files, bounded stream fallbacks, coordination,
normalized failures, and resource ownership. An adapter translates those operations into one concrete backend.

```text
application
    |
    +-- path API -------------------+
    |   readFile / writeFile        |
    |   copy / move / walk          |
    |                               v
    +-- OPFS-shaped handles --> FileSystemType
                                    |
                          canonical adapter operations
                                    |
              +---------------------+---------------------+
              |                     |                     |
              v                     v                     v
         native files          record stores         object stores
      OPFS / Node / Deno       KV / DB rows         S3 / Azure Blob
            / Bun                  |
                                   +-- localStorage
                                   +-- IndexedDB
                                   +-- Cache Storage
                                   +-- Deno KV
                                   +-- unstorage
                                   +-- RxDB
                                   +-- db0 / SQLite
                                   `-- Drizzle
```

The reverse direction is useful too. `@okikio/opfs/driver/kv` exposes any `FileSystemType` as a small hierarchical key-value
store, and `@okikio/opfs/driver/unstorage` adapts that view to unstorage. This means an application can give unstorage an OPFS,
Node, Deno, Bun, S3, Azure Blob, IndexedDB, Deno KV, SQLite, or another custom OPFS backend without a second provider matrix.

Install and start with the backend you actually own
----------------------------------------------------

Deno and JSR can import the package directly:

```ts
import { openFileSystem } from "jsr:@okikio/opfs";

const fileSystem = await openFileSystem();
try {
  await fileSystem.writeFile("/state/app.json", "{}", { parents: true });
} finally {
  await fileSystem.close();
}
```

npm-compatible runtimes use the same TypeScript API:

```sh
npm install @okikio/opfs
```

Server code selects a concrete adapter instead of importing a different filesystem API:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const fileSystem = createFileSystem(
  createNodeAdapter({ root: "./data" }),
  { coordination: "local" },
);
```

The root entrypoint is intentionally import-safe in browsers, workers, Deno, Bun, and Node. Runtime-specific dependencies stay
on explicit subpaths. Importing `@okikio/opfs` does not import `node:fs`, inspect environment variables, connect to databases,
or configure application logging.

The first-party backend set is deliberately broad, but the layers stay small:

| Subpath | Backend or role | Important behavior |
| --- | --- | --- |
| `adapter/opfs` | native browser OPFS | native handles, streams, sync access when exposed |
| `adapter/node` | `node:fs` | streams, ranges, copy/rename, sync random access |
| `adapter/deno` | Deno filesystem | streams, ranges, copy/rename, sync random access |
| `adapter/bun` | Bun + Node-compatible fs | Bun read/write fast paths plus host filesystem operations |
| `adapter/memory` | in-memory records | deterministic tests and temporary state |
| `adapter/record` | `RecordStoreType` | common translation for value/document/SQL stores |
| `adapter/object` | `ObjectStoreType` | common translation for object stores without hiding object semantics |
| `adapter/s3` | `S3ClientType` | direct S3/S3-compatible storage, no AWS SDK |
| `adapter/azure` | `AzureClientType` | direct Azure Blob REST storage, no Azure SDK |
| `adapter/localstorage` | Web Storage | synchronous string store translated through records |
| `adapter/indexeddb` | IndexedDB | indexed record persistence with caller-controlled database ownership |
| `adapter/cache` | Cache Storage | record persistence in an injected Cache |
| `adapter/deno-kv` | Deno KV | record persistence over a caller-owned KV database |
| `adapter/sqlite` | connected SQLite | focused SQLite view over the same SQL record contract as db0 |
| `adapter/unstorage` | unstorage `Storage` | forward bridge above the selected unstorage driver |
| `adapter/rxdb` | RxDB collection | forward bridge above the selected RxStorage |
| `adapter/db0` | db0 `Database` | SQL bridge across db0 dialects/connectors |
| `adapter/drizzle` | Drizzle database + table | caller-owned schema and common CRUD bridge |
| `driver/kv` | reverse key-value view | collision-safe key hierarchy over any filesystem |
| `driver/unstorage` | reverse unstorage driver | lets unstorage consume any `FileSystemType` |

Drizzle is an optional peer dependency because the integration is only loaded through its explicit subpath.

Object storage is not flattened into a fake local disk
-------------------------------------------------------

S3 and Azure Blob can both back the filesystem facade, but they remain object stores underneath. That distinction affects
performance and correctness.

A complete replacement can stream to multipart/block upload. Append and update cannot normally mutate object bytes in place,
so the object adapter performs a read-modify-write operation. When the provider exposes conditional writes, the previous ETag
is used as an optimistic precondition so a concurrent writer fails rather than being silently overwritten.

Native copy is also a separate capability. The filesystem asks the adapter to copy before it opens a source stream, so
provider-side copy stays inside S3/Azure instead of becoming an accidental download and re-upload.

```text
filesystem.copy()
      |
      +-- nativeCopy ----> provider/server-side copy
      |
      `-- fallback ------> source stream -> bounded transfer -> destination
```

The direct S3 client implements Signature Version 4, range reads, ListObjectsV2, multipart upload, conditional completion,
CopyObject, and multipart UploadPartCopy for objects above CopyObject's 5 GB source limit. It also checks S3's unusual
success-with-error-body responses for copy and multipart completion.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createS3Adapter } from "@okikio/opfs/adapter/s3";
import { createS3Client } from "@okikio/opfs/s3";

const client = createS3Client({
  endpoint: "https://s3.us-east-1.amazonaws.com",
  bucket: "my-bucket",
  region: "us-east-1",
  credentials: { accessKeyId, secretAccessKey },
});

const fileSystem = createFileSystem(createS3Adapter(client));
```

S3 compatibility is a protocol family, not one identical product. The client therefore accepts endpoint, region, addressing,
headers, and capability overrides. For example, an S3-compatible service that does not support multipart preconditions should
set `conditionalWrite: false` instead of pretending the safety property exists. `client.request()` remains available for S3
features that do not belong in the portable filesystem contract.

Azure uses its own REST model instead of being forced through an S3 abstraction. It supports SAS, Microsoft Entra bearer
tokens, Shared Key, and caller-defined authorization headers. Large server-side copies use Put Block From URL after Azure's
smaller synchronous Copy Blob From URL path is no longer sufficient.

The protocol clients are documented separately because their wire contracts are larger than the filesystem adapter surface:

- [S3 client protocol](./docs/s3.md) covers SigV4, request canonicalization, multipart upload/copy, conditions, limits, errors,
  compatibility controls, and known non-goals.
- [Azure Blob client protocol](./docs/azure.md) covers REST versions, SAS/bearer/Shared Key authorization, block upload/copy,
  conditions, limits, errors, and Azurite behavior.
- [Provider integration tests](./docs/providers.md) explains the Testcontainers-backed SeaweedFS and Azurite matrix and what those
  local providers can and cannot prove.

The facade makes capability, limits, routing, and cost inspectable
----------------------------------------------------------------

`AdapterCapabilitiesType` describes immediate adapter behavior. `FileSystemType.inspect()` describes the configured stack after
facade fallbacks and optimization policy are applied. This distinction lets callers ask whether a route is `native`, `emulated`,
`partitioned`, or `unsupported` without guessing from the adapter name.

```ts
const fileSystem = createFileSystem(adapter, {
  maxBufferedWriteBytes: 32 * 1024 * 1024,
  metrics: "basic",
  optimizations: {
    nativeCopy: false,
  },
});

console.log(fileSystem.inspect());
console.log(fileSystem.plan({
  operation: "write",
  source: "stream",
  mode: "replace",
  size: 512 * 1024 * 1024,
}));
```

`inspect()` includes native capabilities, effective support, hard limits known by the adapter, partition layout, resolved
optimization controls, the facade buffer ceiling, and a detached metrics snapshot. `plan()` is deterministic and does no I/O.
When size is known it can reject a request before work begins, show expected facade materialization, or explain the physical
part count selected by a partitioned adapter. Unknown provider limits remain unknown rather than being invented.

Write planning separates the resulting logical file from the bytes supplied by the current call. `size` checks logical
file/partition limits. `inputBytes` checks whether a non-native input stream fits under `maxBufferedWriteBytes`. Replace usually
needs only `size`; append/update should provide both values when they are known.

Optimizations that select a materially different route are independently disableable: native stream read/write, direct range
read, native/server-side copy, and native move. The fallback is used only when it can preserve the portable filesystem contract.
For example, disabling provider-side copy can force bytes through this process and cannot reproduce provider-private control-plane
metadata such as every ACL, tag, lock policy, or checksum policy. Portable file bytes and `mediaType` are preserved.

`metrics: "none"` removes facade counter updates for baseline benchmarks. `basic` counts operations, bytes, failures, route
selection, and peak facade materialization. `timing` adds monotonic durations. The direct S3 and Azure clients expose separate HTTP
request/retry metrics so protocol overhead and facade overhead can be measured independently.

Large values are a backend capability, not a promise that every value store is unlimited. `adapter/deno-kv` is the first record
backend with a physical partition layout. Small files stay inline; large files use raw binary parts and a manifest-last commit.
Metadata lookup, directory listing, byte ranges, and stream reads do not reconstruct the complete logical file. The partition
policy is `never | auto | always`, so applications that do not want a changed durable layout can disable it explicitly.
Materialized append/update writes also build a new generation part-by-part, so the existing logical file is not joined into one
large base64 record before a small patch can be applied.

`streamWriteModes` remains mode-specific. A simple record adapter can have no native stream lane, while Deno KV can advertise a
partitioned replacement stream and an object store can advertise native replacement streaming. Append and update can still be
emulated or unsupported independently. Deno KV's materialized append/update lane is direct, but streamed append/update remains
emulated because the incoming stream must first fit under the facade buffer ceiling.

Bridges make both integration directions explicit
-------------------------------------------------

Adapters remain `ecosystem -> OPFS`. Drivers remain `OPFS -> ecosystem`. A bridge groups both directions and records an explicit
reason when one direction cannot honestly exist.

```ts
import { UnstorageBridge, RxDbBridge } from "@okikio/opfs/bridge";

console.log(UnstorageBridge.directions);
// { toOpfs: { supported: true }, fromOpfs: { supported: true } }

console.log(RxDbBridge.directions.fromOpfs);
// unsupported: a filesystem is not an RxStorage query/conflict/change-stream engine
```

The included bridge descriptors cover unstorage, RxDB, db0, Drizzle, and the generic reverse key-value view. Reverse KV and
unstorage drivers also expose the backing filesystem's `inspect()`, `plan()`, and `getMetrics()` methods so capability, size,
partition, optimization, and instrumentation decisions remain visible after the direction changes. Third parties can
use `defineBridge()` without a global registry. An unsupported direction must include a reason, which prevents a bridge from
silently pretending that asynchronous filesystem behavior can provide an unrelated synchronous or query-oriented contract.

Use schemas directly
--------------------

Project-owned structural data is defined by Zod schemas and inferred TypeScript types. Schema constants end in `Schema`, and
project-owned serializable types normally end in `Type`.

```ts
import { PathSchema, type PathType } from "@okikio/opfs/schema";

const path: PathType = PathSchema.parse("/cache/result.bin");
```

Zod 4 schemas implement Standard Schema, so consumers that accept Standard Schema can use these exported schemas directly. The
package does not maintain a parallel wrapper layer that could drift from the executable Zod contract.

Test the semantics where they actually run
------------------------------------------

Portable filesystem contracts use `node:test` and `@std/expect`. Deno runs the same portable test source, Node runs the same
source, and Bun runs the same `node:test` API through its compatibility layer. Runtime-specific suites then prove the real host
filesystem adapters.

Playwright Test owns the browser matrix. The same tests run in Chromium, Firefox, and WebKit and exercise Window OPFS,
DedicatedWorker, SharedWorker, ServiceWorker, same-origin and cross-origin iframes, opaque sandbox behavior, fresh-context
isolation, persistent-profile reopen, cancellation, and browser storage adapters. Tests probe capabilities instead of selecting
behavior from browser names.

Mitata benchmarks compare three layers where possible:

```text
raw backend API
      |
      v
adapter primitive
      |
      v
FileSystemType facade
      |
      +-- coordination: none
      `-- coordination: local
```

Browser benchmarks compare raw native APIs, direct adapters, and the facade for OPFS, localStorage, IndexedDB, and Cache
Storage in Chromium, Firefox, and WebKit. Node, Deno, and Bun benchmarks compare their raw filesystem APIs with direct adapters and the facade. Bun additionally compares
Node-compatible `copyFile` with `Bun.write(destination, Bun.file(source))` rather than assuming one host copy path is faster.
Deno KV and SQLite have the same raw-to-adapter-to-facade measurements.

Provider benchmarks use the same local provider fixture but keep each layer separate: official AWS/Azure SDK baseline, direct
protocol client, direct object adapter, facade with metrics disabled, and facade with basic metrics. A Bun-native S3 run compares
Bun's Rust-backed `S3Client` against the same project layers. Multipart/block cases are separate from single-request writes so a
different request plan is never presented as abstraction overhead.

With the pinned mise toolchain:

```sh
mise install
mise run check
mise run test
mise run bench
mise run test-browser
mise run bench-browser
mise run bench-providers
```

GitHub Actions uses the same tool declarations and mise tasks. The workflow installs mise once per job, asks mise to install
only the runtimes that job needs, and then calls `mise run ...`. Runtime matrix jobs override one configured version with
`MISE_<TOOL>_VERSION`; the Node matrix uses this to test Node 22, 24, and 26 without introducing a second tool-version
source. Third-party actions are pinned to immutable commit SHAs, and the mise binary version is pinned separately.

The focused Deno tasks are documented in [docs/validation.md](./docs/validation.md).

Read the rest by the question you have
--------------------------------------

- [Public API](./docs/api.md) explains the developer-facing filesystem and handle contracts.
- [Adapters](./docs/adapters.md) explains every first-party backend and the contracts for custom storage.
- [Architecture](./docs/design.md) explains invariants, streaming, copy/move, locks, ownership, and failure behavior.
- [Ecosystems](./docs/ecosystems.md) explains unstorage, RxDB, db0, Drizzle, S3-compatible services, and reverse drivers.
- [Environments](./docs/environments.md) explains Window, workers, iframes, Deno, Bun, Node, and provider clients.
- [Validation](./docs/validation.md) defines the canonical test and benchmark matrix.
- [Sources](./docs/sources.md) records the standards and upstream contracts that the implementation follows.
- [Releasing](./docs/releasing.md) explains JSR/npm packaging and release checks.
