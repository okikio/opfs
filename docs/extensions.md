# Publish an independent extension

An extension can supply storage, a byte source, or an ecosystem bridge without joining a global registry or importing
private OPFS files. Choose the narrow contract that matches its real behavior. A download-only service is not a writable
filesystem, and a codec is not a storage driver.

Keep portable decisions separate from host acquisition. Accept Fetch, cryptography, clocks and storage capabilities as
explicit inputs; a named native factory can acquire them when called. The existing Node driver resolves built-ins inside
construction through [`process.getBuiltinModule()`](https://nodejs.org/api/process.html#processgetbuiltinmoduleid),
which avoids a static Node-only import in a portable entrypoint. That function still needs a Node capability; it does
not make host access pure. Access Deno through an explicit native boundary when needed, and keep either runtime outside
a portable root's import graph. The new archive, source and transfer cores need no Node or Deno runtime imports.

This complete source implementation works on caller-provided bytes. It shows the public contract without a provider SDK
or ambient runtime. Its identity is a caller assertion: use a stable digest or immutable application version when
resuming across processes.

```ts
import { type ByteSourceType, sourceRange } from "@okikio/opfs/source";

export function createBufferSource(input: Uint8Array, identity: string): ByteSourceType {
  const snapshot = new Uint8Array(input);
  return {
    size: snapshot.length,
    identity,
    stability: "immutable",
    async read(offset, length, { signal } = {}) {
      signal?.throwIfAborted();
      sourceRange(snapshot.length, offset, length);
      return snapshot.slice(offset, offset + length);
    },
  };
}
```

Publish this function from the extension package's explicit ESM entrypoint. Declare the OPFS version range you test;
keep Deno source exports and npm JavaScript/declaration exports correct for their respective artifacts. Do not publish
unresolved workspace aliases or reach through an installed package into `src/`.

A runner can use the optional public suite with an independently specified oracle:

```ts
import { testByteSource } from "@okikio/opfs/testing/source";
import { createBufferSource } from "./source.ts";

await testByteSource(() => ({
  source: createBufferSource(new Uint8Array([2, 3, 5, 7]), "primes-v1"),
  expected: new Uint8Array([2, 3, 5, 7]),
  close() {},
}));
```

The suite checks exact bytes, short/edge extents, invalid offsets and pre-abort authority, then awaits fixture cleanup.
It imports no test runner and discovers no services. A passing small source suite is not certification of a provider,
credential flow, concurrent replacement, cancellation during active network I/O or supported runtime. Add those tests in
the extension, using isolated resources and exact released-package consumers.

## Storage and filesystem projection

For file, record or object storage, implement the matching backend from `driver/file`, `driver/record` or
`driver/object`, then attach metadata with its `define*Driver()` function. Reuse `createFileAdapter()`,
`createRecordAdapter()` or `createObjectAdapter()` instead of copying filesystem translation. The application can use
the native driver without creating a filesystem. See [adapters](adapters.md) for those required operations and
[GCS](gcs.md) for a native protocol implementation followed by its driver and adapter.

Object metadata can carry a discriminated `revision`. An ETag and a GCS generation are different preconditions. If your
backend accepts a revision option, it must enforce that exact kind or refuse it before I/O; ignoring it can corrupt a
multi-range preview. Preserve object key identity, opaque pagination, metadata and provider receipt attribution. Publish
actual native/emulated/unsupported capabilities and limit provenance. Returning a stream after buffering a complete
object is not native streaming.

For an already opened archive or other read-only namespace, use `defineReadAdapter()` from `adapter/read`. Authors
supply `name`, a configured driver, `stat`, `readFile`, `readDir`, and `capabilities: { streamRead, rangeRead }`. A
declared native stream also requires `openReadStream`. There are no author-supplied mutation stubs. The constructor
forces writable capabilities off; the facade refuses writes, directory creation, copy, move and removal before source or
metadata acquisition. A handle's `createWritable({ keepExistingData: true })` also refuses before reading existing
bytes.

The [ZIP view](archive.md) is a working example: it validates a namespace projection, creates synthetic parents and
rejects duplicate/path-kind/link conflicts. It borrows its archive. The archive in turn borrows its byte source. Opening
or closing the view cannot silently dispose a provider supplied by the application.

## Bridges and optional format components

A reverse bridge starts with `FileSystemType` and implements the actual external interface. The existing `bridge/kv` and
`bridge/unstorage` are executable examples with separate layout and disposal contracts. `defineIntegration()` can
describe available directions, but metadata cannot implement a bridge. A synchronous external interface cannot be
satisfied with Promises under a cast, and file methods do not create database transactions or query semantics.

ZIP accepts an explicit raw-DEFLATE transform factory. Each invocation must return a separately owned transform,
propagate cancellation and bound its own internal memory. No import triggers a codec download or creates a shared WASM
instance. The factory's dependency graph, runtime prerequisites, provenance and limits belong in its package docs. Other
archive/envelope definitions do not yet share a frozen universal plugin API; compose through the public byte source and
view seams until independent implementations justify that contract. Recognition of a format never implies its payload is
supported.

Keep pure detection/parsing/planning separate from effectful Fetch, keys, host files, codecs and staging. Pass a narrow
capability explicitly. Runtime globals belong in an explicit host factory; spelling an ambient lookup `globalThis.Deno`
does not make it pure. Do not register plugins at import, scan installed packages, accept executable module names from
untrusted archives or automatically import URLs.

Each release must name a maintenance owner, exact protocol/profile versions, tested OPFS range, fixtures, excluded
capabilities, dependency/licenses, cancellation and cleanup behavior, and durable-layout migrations where relevant.
Expose missing or unverified operations rather than optimistic flags. The application chooses which extension code to
install and what capabilities to give it; conformance tests and capability injection do not sandbox arbitrary code.
