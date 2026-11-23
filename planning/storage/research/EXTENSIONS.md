# Let another package add a backend, bridge or format

This design is for an author who wants to use OPFS with a service, native client or archive engine that the first-party package does not provide. They should be able to publish an ordinary ESM package, depend only on public contracts, run conformance tests, and give callers a useful filesystem or narrower byte interface without changing OPFS or registering a global plugin.

Current source already exports driver definitions, three operational driver families, adapter definitions, reusable adapters and integration metadata. The work is to make those seams complete, teachable and independently tested. Proposed format/source/testing subpaths below do not exist yet. The examples using current constructors are source-reviewed; this planning task has not compiled or executed a new external package.

## Choose the contract that matches the resource

| What the author owns | Use or implement | What must stay visible |
| --- | --- | --- |
| Real files/directories | `FileBackendType` → `defineFileDriver()` → `createFileAdapter()` | File kinds, writable modes, native rename/copy, sync support, path trust, publication and descriptor ownership. |
| Key/value or database records | `RecordBackendType` → `defineRecordDriver()` → `createRecordAdapter()` | Stored record schema/layout, paging, transaction boundaries, value ceilings, chunk publication and cleanup. |
| Objects with keys/metadata | `ObjectBackendType` → `defineObjectDriver()` → `createObjectAdapter()` | Conditional revisions, object receipts, range reads, paging, multipart/session behavior and copy conditions. |
| A backend that genuinely cannot fit those families | `defineDriver()` plus `defineAdapter()` for a real filesystem projection, or a narrower native API | Required operations must be real. `defineDriver()` describes facts; it does not supply missing persistence methods. |
| A consumer of an existing `FileSystemType` | A reverse bridge returning the consumer's exact contract | Key/path conversion, transactions/watch/sync guarantees, failure timing, metadata and disposal requirements. |
| An archive/codec/envelope implementation | Proposed archive/source/codec/envelope contracts | Format/profile version, supported operations, byte access, authentication scope and resource budgets. No storage driver is required merely to decompress bytes. |
| A single remote object or upload-only endpoint | Proposed byte-source/upload-session seam | Do not invent directories, writes or download endpoints to fit a bigger interface. |

The writable adapter family currently requires mutation methods. Read-only third-party implementations must wait for the planned read-only admission contract or expose the narrower source/view API. Do not hide throw-only methods behind a cast and claim a writable adapter.

## One current composition example

An independent object-service package can accept a caller-owned backend and reuse OPFS's translation. The application creates/authenticates the native client separately. The backend author implements the object protocol; this function does not import that SDK or discover credentials.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createObjectAdapter } from "@okikio/opfs/adapter/object";
import {
  defineObjectDriver,
  type ObjectBackendType,
} from "@okikio/opfs/driver/object";

export function createServiceFileSystem(backend: ObjectBackendType) {
  const driver = defineObjectDriver(backend, {
    name: backend.name,
    ownership: "borrowed",
  });
  return createFileSystem(createObjectAdapter(driver));
}
```

This example is a composition seam, not a complete service implementation. `ObjectBackendType` requires head/get/put/delete/list and declared capabilities. Responses must be validated, streamed bytes and cancellation must follow the contract, and declared conditional writes must actually protect the adapter's replacement admission. A separately configured provider SDK can remain application-owned. Passing a client into a function does not make that client's code trusted or dependency-free.

The extension must publish actual limit provenance, requirements, ownership and native/emulated/unsupported behavior. Do not advertise streaming because `get()` returns a stream after first buffering an entire object. Do not set capabilities from method names alone. Keep native operations independently useful below the filesystem projection.

## A bridge is a separately verified direction

Start with an already configured `FileSystemType` and implement the consumer's actual public interface. The existing `bridge/kv` and `bridge/unstorage` show concrete naming/metadata/lifetime translation. `defineIntegration()` can associate executable constructors with `toOpfs`/`fromOpfs` metadata, but that metadata does not implement the target interface.

Before writing a bridge, inventory the consumer's required asynchronous/synchronous calls, return values, ordering, missing-value rules, watches, transactional semantics, cancellation and disposal. A synchronous consumer cannot be satisfied by returning Promises under casts. A filesystem cannot claim SQL/RxStorage transactions merely by renaming file calls. Mark an impossible direction unsupported with a concrete reason; keep a useful one-way integration.

External SDK types may appear in that extension package when they are intentionally the consumer contract. They must not leak into OPFS core or force every OPFS consumer to install the SDK. SDK instances are borrowed by default; `dispose` closes them only after an explicit ownership transfer.

## Public extension contract to finish before broad expansion

Freeze versioned contracts for byte sources, read-only views, transfer sessions, archive definitions, codecs and encrypted envelopes using at least two independent implementations. One should be a tiny third-party fixture outside OPFS's source import graph. Use the public facade for normal work and the narrow lower-level capability for advanced work; avoid one enormous plugin context.

A format definition should contain immutable identity/profile metadata and explicit operations. It can expose bounded detection, open/list/read/verify/write as supported. A codec takes a byte source/sink and resolved options. An envelope owns key/recipient admission and authentication units. A view projects an opened domain object into paths. Keep them separate so a third-party ZIP parser can use first-party storage and a third-party codec without adopting a package-owned registry or engine.

Detection is an explicit caller-selected list of definitions. Give probes maximum bytes, requests and time, stable tie-breaking, and a structured ambiguous/unsupported result. A filename extension is a hint. No import-time registration, package scanning, dynamic URL import from an archive, arbitrary module names from manifests, or automatic downloads of codecs/WASM. Explicit package imports retain the application's dependency choice.

Publish a small conformance surface on optional testing subpaths, proposed `/testing/driver`, `/testing/adapter`, `/testing/bridge` and `/testing/archive`. Keep runner integration and fixtures away from root imports; do not ship secrets, service credentials or huge corpora. Each suite accepts a resource factory, declared capability/profile set and cleanup owner, runs only relevant cases, and reports exact exclusions. Claims and exclusions must fail when they contradict method behavior. Avoid declaring a full provider certified from a generic in-memory suite.

The external-author fixtures must prove: a custom object backend with no private imports; a record/file implementation where needed; a read-only archive view after the new contract; a real reverse bridge; and a substituted codec/envelope. Include success, unsupported operations before source effects, false capability declarations, partial acquisition, cleanup, shared-client borrowing, range/revision conflicts and unknown publication.

## Author documentation and compatibility

Ship a task-oriented extension guide with a complete backend example, a complete bridge example and a format example. Each includes package manifests, public imports, configuration, an application call, disposal, errors, test invocation and resulting inspection/plan output. Documentation examples must run as clean artifact consumers. Do not leave `backend` or `driver` undefined in the complete tutorial; small reference snippets may use explicitly supplied capabilities as above.

Document durable layout/version migration separately from TypeScript API compatibility. Publish the supported OPFS version range and exact external protocol/SDK profile. Use Deno exports and npm export/dependency metadata for their own consumers; do not rely on private monorepo paths or unresolved workspace aliases. Test duplicate package instances/realms where error identity or branding matters, and prefer stable machine codes over undocumented `instanceof` assumptions.

A third-party release checklist must include the dependency graph and licenses, import safety, native/mounted/injected distinction, conditional consistency, byte limits, relevant runtimes, cancellation/disposal, protocol/format fixtures, exact installed consumers and upgrade ownership. No code signing or conformance report can guarantee arbitrary extension code is safe. The application still chooses what it installs and which capabilities it gives it.

Acceptance: an engineer outside the project can implement the examples using only public exports, run the suites against an exact packed version, substitute their implementation without changing core, and recognize unsupported or unverified operations from inspection and errors. The plan does not require everyone to use a first-party protocol implementation.
