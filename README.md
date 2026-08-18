# @okikio/opfs

`@okikio/opfs` is an OPFS-shaped storage programming model for browser OPFS, host filesystems, object stores, key-value
stores, browser storage, document databases, and SQL databases.

The package does not pretend those systems are identical. It separates protocol behavior, backend storage mechanics,
OPFS translation, portable filesystem semantics, and reverse ecosystem projections so applications can inspect the real
route and its limits before work starts.

```text
ecosystem / native API
        |
        v
      client                 protocol client when a wire protocol exists
        |
        v
      driver                 backend-native storage contract
        |                    requirements / limits / optimizations / physical metrics
        v
      adapter                driver -> canonical OPFS primitives
        |
        v
   FileSystemType            paths / handles / locks / fallbacks / logical metrics
        |
        v
      bridge                 FileSystemType -> real ecosystem contract
```

A client is optional. Node, Deno, Bun, browser OPFS, IndexedDB, and SQLite can start at the driver layer. S3 and Azure
Blob have explicit protocol clients because their wire contracts are independently useful.

The filesystem facade owns the behavior application code should not rebuild for every backend: canonical virtual paths,
OPFS-shaped handles, recursive work, cancellation, staged writable files, bounded stream fallbacks, coordination,
normalized failures, resource ownership, and deterministic preflight planning.

## Start with the storage you own

Browser OPFS has a root convenience function:

```ts
import { openFileSystem } from "@okikio/opfs";

await using fileSystem = await openFileSystem();
await fileSystem.writeFile("/state/app.json", "{}", { parents: true });
```

Server code can compose each layer explicitly:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

await using fileSystem = createFileSystem(
  createNodeAdapter({ root: "./data" }),
  { coordination: "local" },
);
```

`createNodeAdapter()` is a convenience composition. The explicit form is useful when an application wants to inspect or
use the backend driver before it creates a filesystem:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createFileAdapter } from "@okikio/opfs/adapter/file";
import { createNodeDriver } from "@okikio/opfs/driver/node";

const driver = createNodeDriver({ root: "./data" });
console.log(driver.inspect());
console.log(driver.plan({ operation: "write", path: "/large.bin", size: 1_000_000 }));

const adapter = createFileAdapter(driver);
await using fileSystem = createFileSystem(adapter);
```

The root entrypoint remains import-safe in Window, Worker, Deno, Bun, and Node contexts. Runtime-specific code stays on
explicit subpaths. Importing the root package does not connect to a provider, read credentials, start workers, or
configure application logging.

For host filesystem drivers, `root` is a lexical virtual-path mapping rather than a security sandbox. Node, Deno, and Bun
native file operations can follow symbolic links already present below that directory. Use a trusted host root when an
independent process or untrusted user can mutate the host filesystem.

## Layer inventory

The first-party integration set is broad, but each layer has one job.

| Family          | Client                | Driver                | Adapter                | Reverse bridge                          |
| --------------- | --------------------- | --------------------- | ---------------------- | --------------------------------------- |
| browser OPFS    | n/a                   | `driver/opfs`         | `adapter/opfs`         | filesystem itself                       |
| Node filesystem | n/a                   | `driver/node`         | `adapter/node`         | ecosystem-specific                      |
| Deno filesystem | n/a                   | `driver/deno`         | `adapter/deno`         | ecosystem-specific                      |
| Bun filesystem  | n/a                   | `driver/bun`          | `adapter/bun`          | ecosystem-specific                      |
| memory          | n/a                   | `driver/memory`       | `adapter/memory`       | generic KV bridge possible              |
| Deno KV         | n/a                   | `driver/deno-kv`      | `adapter/deno-kv`      | generic KV bridge possible              |
| localStorage    | n/a                   | `driver/localstorage` | `adapter/localstorage` | generic KV bridge possible              |
| IndexedDB       | n/a                   | `driver/indexeddb`    | `adapter/indexeddb`    | generic KV bridge possible              |
| Cache Storage   | n/a                   | `driver/cache`        | `adapter/cache`        | cache-specific bridge not yet provided  |
| SQLite rows     | engine-owned          | `driver/sqlite`       | `adapter/sqlite`       | see database direction below            |
| db0             | connector-owned       | `driver/db0`          | `adapter/db0`          | no fake SQL projection                  |
| Drizzle         | dialect/driver-owned  | `driver/drizzle`      | `adapter/drizzle`      | no fake SQL projection                  |
| RxDB            | RxStorage-owned       | `driver/rxdb`         | `adapter/rxdb`         | full RxStorage bridge not yet provided  |
| unstorage       | upstream driver-owned | `driver/unstorage`    | `adapter/unstorage`    | `bridge/unstorage`                      |
| S3              | `s3`                  | `driver/s3`           | `adapter/s3`           | object-specific bridge not yet provided |
| Azure Blob      | `azure`               | `driver/azure`        | `adapter/azure`        | object-specific bridge not yet provided |

`adapter/file`, `adapter/record`, and `adapter/object` are reusable translators for third-party drivers. `driver/file`,
`driver/record`, and `driver/object` are the corresponding backend-native contracts.

## Drivers are independently useful

A driver is not an adapter with a new name. It owns backend mechanics that remain meaningful without `FileSystemType`.

A configured driver reports:

```text
name and storage family
stable backend operations/capabilities it provides
backend resource ownership: none / borrowed / owned
requirements and current availability
provider hard limits
implementation safety limits
user-selected policy limits
dynamic limits that still require probing
behavior-changing and transparent optimizations
structured preflight problems and actions
physical metrics when available
owned-resource disposal when applicable
```

Limits always include provenance. For example, Deno KV can report its serialized provider ceiling separately from the
smaller raw payload budget this library chooses to leave room for serialization overhead. A caller can therefore
distinguish a provider rule from an implementation safety choice and from its own `maxParts` policy.

`plan()` is deterministic and performs no provider I/O:

```ts
const plan = driver.plan({
  operation: "write",
  path: "/archive/data.bin",
  size: 80 * 1024,
  source: "bytes",
  mode: "replace",
});

for (const problem of plan.problems) console.log(problem.code, problem.limit);
for (const action of plan.actions) console.log(action.kind);
```

Dynamic facts such as available quota remain unknown until a separate explicit probe supplies them. The planner never
invents a quota or silently performs network/storage I/O.

## Capabilities are layered instead of flattened

`driver.inspect()` describes the backend. `FileSystemType.inspect()` adds the adapter translation and effective facade
routes:

```ts
const inspection = fileSystem.inspect();

inspection.driver; // provides, ownership, requirements, limits, optimizations
inspection.adapter; // native OPFS translation capabilities
inspection.support; // effective native/emulated/partitioned/unsupported routes
inspection.optimizations; // facade route switches
inspection.metrics; // logical filesystem counters
inspection.driverMetrics; // physical backend counters when available
```

`FileSystemType.plan()` combines the driver preflight with adapter and facade policy. Problems remain structured and
retain the layer that identified them. Human-readable messages are presentation data, not the machine contract.

```ts
const plan = fileSystem.plan({
  operation: "write",
  path: "/video.bin",
  source: "stream",
  size: 512 * 1024 * 1024,
});

if (!plan.supported) {
  // Example actions: partition, change-policy, reduce-input, select-driver.
  console.log(plan.problems, plan.actions);
}
```

Every optimization that can change request count, failure timing, storage layout, consistency, atomicity, or another
observable property is independently disableable and visible through inspection.

## Object storage keeps object semantics

S3 and Azure Blob do not become fake POSIX disks. Their clients keep protocol-specific operations while object drivers
expose portable object mechanics to the adapter.

```text
S3 REST / Azure Blob REST
          |
          v
       client
          |
          v
    object driver
          |
          v
    object adapter
          |
          v
    FileSystemType
```

A complete replacement can stream through multipart/block upload. Append and update normally require read-modify-write.
For generic record drivers, backend transaction availability does not make the adapter's separate read and replace steps
atomic across independent owners. Stronger append/update semantics require a native driver mode, provider condition, or
external serialization. Server-side copy remains a separate capability because routing bytes through JavaScript is not
equivalent to a provider control plane copy.

The S3 client exposes two optimization switches that are useful to inspect and benchmark:

- `delayedMultipart`: buffers the first bounded part so a small unknown-length stream can use `PutObject`. Disable it
  when the multipart request lifecycle itself is required.
- `signingKeyCache`: reuses the derived SigV4 signing key for unchanged credentials/date/region/service. It does not
  change the signed request semantics.

Azure exposes `blockUpload` and `serverCopy` independently. Disabling block upload removes native streamed-write support
rather than pretending a stream can still be sent without staging. Disabling server copy makes the object adapter/facade
choose an honest fallback when one can preserve the requested semantics.

See [docs/s3.md](./docs/s3.md) and [docs/azure.md](./docs/azure.md) for the protocol contracts.

## Deno KV is the reference partitioned record driver

Deno KV demonstrates why one flat `maxFileBytes` number is insufficient. The driver separates:

```text
provider:        serialized key/value and atomic-operation ceilings
implementation: conservative inline/part payload budgets
user policy:     partition mode, part size, max parts, I/O concurrency
derived:         logical file capacity for the selected layout
```

Large files use immutable physical generations, a manifest-last visibility point, and explicit age-gated reclamation:

```text
old manifest -> old parts

write new part 0..N
        |
        v
atomic check old version
        |
        v
commit retirement marker + new manifest
                  visibility point
        |
        v
old readers keep using immutable old parts
        |
        v
collect after retirement grace
```

The metadata visibility commit uses Deno KV optimistic version checks, so an independent stale writer cannot publish over a
newer logical entry. A failed write does not publish a partial logical file. A reader that already resolved the previous manifest can finish against its immutable generation after an overwrite commits
while that generation remains inside the configured retirement grace. `collect()` measures a published generation's grace
period
from retirement, not from its potentially much older creation time. Unpublished crash leftovers have no retirement marker,
so collection uses their generation creation time. Unknown-length streamed replacement uses the partitioned lane when
partitioning is enabled. `partition: "never"` disables that behavior and makes oversized/streaming requests fail or use a
bounded facade fallback instead of changing durable layout silently.

The preflight planner also evaluates the concrete virtual path. Deno KV limits serialized keys, so file size alone is
not enough to decide whether an operation is admissible.

## Database direction matters

There are two different database architectures and the package documents them separately.

### Database-backed filesystem

The existing SQLite/db0/Drizzle/RxDB drivers store logical filesystem records in an existing database abstraction:

```text
Database / collection
       |
       v
record driver
       |
       v
record adapter
       |
       v
FileSystemType
```

For Drizzle, the caller supplies a connected database and a table. The generic driver intentionally reports replacement
as best-effort because its portable CRUD route is delete then insert. A dialect-specific driver can expose stronger
binary, transaction, upsert, or partition behavior without weakening the generic contract.

### Database file stored on OPFS

Using OPFS as storage for a SQLite database is the opposite direction:

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

`adapter/sqlite` does **not** implement this topology. It stores virtual filesystem records inside an already connected
SQLite database. A future SQLite VFS integration must implement the database engine's real VFS contract. It must not be
represented as an SQL bridge that only renames filesystem methods.

See [docs/ecosystems.md](./docs/ecosystems.md) for concrete Drizzle/db0/RxDB behavior.

## Bridges are real reverse contracts

A bridge starts from `FileSystemType` and implements an ecosystem contract. Direction metadata lives under
`integration/` and is not itself a bridge.

The package currently provides:

- `bridge/kv`: a small hierarchical key-value contract over any `FileSystemType`.
- `bridge/unstorage`: an unstorage Driver-shaped implementation over any `FileSystemType`.

The unstorage layout keeps `foo` and `foo:bar` distinct even though a normal filesystem path cannot be both a file and a
directory.

```text
unstorage
    |
bridge/unstorage
    |
FileSystemType
    |
any configured adapter/driver stack
```

`integration` definitions state which directions are real. RxDB, db0, and Drizzle currently remain honest one-way
integrations because a filesystem alone is not an RxStorage query/conflict/change-stream engine or a SQL engine.
Third-party packages can use `defineIntegration()` and the driver/adapter primitives without registering global state.

## Testing and benchmarks follow the layers

Deno is the primary runtime and release authority. Portable behavior uses `node:test` with `@std/expect` because Deno
can run those contracts directly. Node and Bun run the same portable tests as compatibility lanes, plus their
runtime-specific filesystem tests. Their ambient type extensions must not redefine the Deno-checked public core.
Playwright Test owns actual Window, Worker, iframe, ServiceWorker, persistence, and browser-storage coverage.
Testcontainers owns disposable SeaweedFS and Azurite provider fixtures.

Provider benchmarks compare:

```text
official/native baseline
        |
project protocol client
        |
project driver
        |
project adapter
        |
facade metrics:none
        |
facade metrics:basic
```

`bench/filesystem-provider.bench.ts` adds the same staircase above already-mounted AWS Mountpoint and Azure BlobFuse
filesystems. Set `OPFS_MOUNTPOINT_S3_ROOT` and/or `OPFS_BLOBFUSE_ROOT` before `mise run bench-filesystem-clients`. The
benchmark uses only file operations that can be compared through the mounted filesystem contract. It does not count an
unsupported filesystem operation as a performance failure.

Mise is the repository command authority:

```sh
mise install
mise run check
mise run test
mise run test-browser
mise run test-providers
mise run bench
mise run bench-providers
mise run bench-browser
mise run bench-filesystem-clients   # requires external mounts
```

GitHub Actions owns triggers, permissions, matrices, outputs, and secrets. It then invokes the same mise tasks. Release
and publish commands also live under `.mise/tasks/` rather than becoming a second command layer in workflow YAML.

## Read next

- [Public API](./docs/api.md) explains filesystem, inspection, planning, driver, adapter, and bridge entrypoints.
- [Architecture](./docs/design.md) explains layer ownership, invariants, partitioning, metrics, and lifecycle.
- [Adapters and drivers](./docs/adapters.md) explains the first-party translation/backend matrix and extension
  contracts.
- [Ecosystems](./docs/ecosystems.md) explains unstorage, RxDB, db0, Drizzle, SQLite direction, and reverse bridge
  constraints.
- [Environments](./docs/environments.md) explains browser realms, Deno, Bun, Node, and server coordination.
- [Providers](./docs/providers.md) explains Testcontainers and provider/filesystem baseline benchmarks.
- [Validation](./docs/validation.md) defines the release gates and this repository's test matrix.
- [Sources](./docs/sources.md) records the standards and upstream contracts used by the implementation.
- [Releasing](./docs/releasing.md) explains mise-owned release and registry publication.
