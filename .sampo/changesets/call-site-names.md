---
npm/@okikio/opfs: minor
---

Rename three public functions so each reads clearly where it is called, and stop exporting five internal helpers that
were public by accident. Behavior does not change. This is a breaking change for code that imports the old names; the
package is still 0.x, so it ships as a minor release with no aliases.

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

These exports are removed because nothing outside the package needs them:

| Subpath                         | Removed                                                | Reason                                                                                         |
| ------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `@okikio/opfs/archive/tar`      | `tarPadding`                                           | Marked internal; only TAR reading and writing used it                                          |
| `@okikio/opfs/driver/indexeddb` | `result`, `committed`, `writeBytes`, `upgradeDatabase` | Request and transaction mechanics of the driver itself; `upgradeDatabase` had no caller at all |

Code that used them can compute TAR padding as `(512 - size % 512) % 512`, and wrap an `IDBRequest` in a promise with
its `success` and `error` events. A type checker reports every old import as a missing export.
