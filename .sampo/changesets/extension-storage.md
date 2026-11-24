---
npm/@okikio/opfs: minor
---

### Store files in WebExtensions storage in Chrome, Firefox and Safari

New `driver/extension` and `adapter/extension` entry points put an OPFS-shaped filesystem on top of a WebExtensions
`StorageArea`. One driver covers `storage.local`, `storage.session`, `storage.sync` and the read-only `storage.managed`,
because Chrome, Firefox and Safari expose the same area API.

```ts
import { createExtensionAdapter, getStorageArea, watchStorageArea } from "@okikio/opfs/adapter/extension";
import { createFileSystem } from "@okikio/opfs";

const area = getStorageArea("local")!; // browser.storage.local or chrome.storage.local
const fs = createFileSystem(createExtensionAdapter(area, { area: "local" }));

await fs.mkdir("/notes");
await fs.writeFile("/notes/today.md", "# Today");
console.log(await fs.readText("/notes/today.md")); // "# Today"
console.log(await fs.backend.getBytesInUse?.(null)); // the area itself, typed

// See writes from the service worker, popups and content scripts.
using subscription = watchStorageArea(area).subscribe((event) => {
  console.log(event); // { path: "/notes/today.md", change: "write", kind: "file" }
});
```

Importing the module reads no browser global. `getStorageArea(name)` looks in `browser.storage` and then
`chrome.storage` only when you call it, and returns `undefined` where the area is missing.

| Area      | Chrome | Firefox | Safari             | Behavior                                        |
| --------- | ------ | ------- | ------------------ | ----------------------------------------------- |
| `local`   | yes    | yes     | 14+                | `unlimitedStorage: true` removes the byte limit |
| `session` | 102+   | 115+    | 16.4+              | memory only                                     |
| `sync`    | yes    | yes     | stored, not synced | about 6 KB per file, 120 writes a minute        |
| `managed` | yes    | yes     | no                 | always read only                                |

Limits come from the area's own constants, so `inspect()` shows each browser's real numbers: `quota-bytes`,
`item-bytes`, `item-count`, `writes-per-minute`, `writes-per-hour`, and a derived `file-bytes`. Each file is one item
with base64 data. The driver checks the item size before calling the browser, so an oversized `sync` write fails with
`quota-exceeded` and does not use one of the rate-limited writes. A browser quota rejection also maps to
`quota-exceeded`. Files are not split across items in this release.

`watchStorageArea()` returns an `@okikio/observables` Observable built on `area.onChanged`. The listener is added when
you subscribe and removed when you unsubscribe. `@okikio/observables` is a new runtime dependency.
