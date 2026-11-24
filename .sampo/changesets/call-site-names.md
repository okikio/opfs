---
npm/@okikio/opfs: minor
---

Rename three public functions so each reads clearly where it is called, and move five lower-level helpers from their
main entry points to new advanced entry points. Behavior does not change. This is a breaking change for code that
imports the old names or paths; the package is still 0.x, so it ships as a minor release with no aliases.

| Subpath                        | Before             | After            | How it is called                                           |
| ------------------------------ | ------------------ | ---------------- | ---------------------------------------------------------- |
| `@okikio/opfs/source`          | `sourceRange`      | `assertExtent`   | First statement of a `read(offset, length)` implementation |
| `@okikio/opfs/content/arweave` | `arweaveId`        | `parseArweaveId` | On any ID that will become part of a gateway URL           |
| `@okikio/opfs/content/lfs`     | `lfsPointerObject` | `toLfsObject`    | Between `decodeLfsPointer()` and the `LfsClient` request   |

`assertExtent` uses the source module's own word for a byte span. The old name collided with the HTTP `Range` helpers
that provider clients use next to it. `parseArweaveId` validates external input and returns it, and `toLfsObject`
returns an `LfsObjectType`; both keep their domain word because consumers import them directly.

```ts
// Before
import { type ByteSourceType, sourceRange } from "@okikio/opfs/source";
// After
import { assertExtent, type ByteSourceType } from "@okikio/opfs/source";

export function createBufferSource(input: Uint8Array, identity: string): ByteSourceType {
  const snapshot = new Uint8Array(input);
  return {
    size: snapshot.length,
    identity,
    stability: "immutable",
    async read(offset, length, { signal } = {}) {
      signal?.throwIfAborted();
      assertExtent(snapshot.length, offset, length); // was sourceRange(...)
      return snapshot.slice(offset, offset + length);
    },
  };
}
```

```ts
// Before
import { decodeLfsPointer, lfsPointerObject } from "@okikio/opfs/content/lfs";
const request = lfsPointerObject(decodeLfsPointer(bytes));

// After
import { decodeLfsPointer, toLfsObject } from "@okikio/opfs/content/lfs";
const request = toLfsObject(decodeLfsPointer(bytes));
```

These helpers moved off their main entry points. Each is still public, at an advanced entry point under the same owner;
the `_` marks a mechanism most consumers never need. `docs/design.md` describes the convention.

| Before                                                 | After                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `tarPadding` from `@okikio/opfs/archive/tar`           | `padding` from `@okikio/opfs/archive/tar/_block`                   |
| `writeBytes` from `@okikio/opfs/driver/indexeddb`      | `applyWrite` from `@okikio/opfs/driver/_image`                     |
| `upgradeDatabase` from `@okikio/opfs/driver/indexeddb` | `upgradeDatabase` from `@okikio/opfs/driver/indexeddb/_store`      |
| `result` from `@okikio/opfs/driver/indexeddb`          | `waitForRequest` from `@okikio/opfs/driver/indexeddb/_transaction` |
| `committed` from `@okikio/opfs/driver/indexeddb`       | `committed` from `@okikio/opfs/driver/indexeddb/_transaction`      |

`applyWrite` replaces three identical copies of the same whole-file write rule (in the object adapter, the record
adapter and the IndexedDB driver), so custom drivers that store a file as one value can apply exactly the same
`replace`, `append` and `update` semantics. `_transaction` also publishes the `Transaction` owner the IndexedDB driver
uses for every read and write.

```ts
// Before
import { committed, result } from "@okikio/opfs/driver/indexeddb";
// After
import { committed, waitForRequest } from "@okikio/opfs/driver/indexeddb/_transaction";

const value = await waitForRequest(store.get(path));
await committed(transaction);
```

A type checker reports every old import as a missing export.
