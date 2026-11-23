---
npm/@okikio/opfs: patch
---

Fix wrong bytes in OPFS files on WebKit when the data is a view into part of a larger buffer. WebKit 27.2 (the build in
Playwright 1.65.1) writes such a view from the start of its buffer instead of from the view's own offset. Before this
release, an OPFS write of `subarray()` output, or of any view with a nonzero `byteOffset`, could store the wrong bytes
in Safari without an error.

```ts
import { createOpfsDriver } from "@okikio/opfs/driver/opfs";

const driver = createOpfsDriver(await navigator.storage.getDirectory());
const packet = Uint8Array.of(99, 4, 5, 99);
await driver.writeFile("/payload.bin", packet.subarray(1, 3), { mode: "replace" });
console.log(await driver.readFile("/payload.bin"));
// Before, on WebKit: Uint8Array [99, 4]
// Now, everywhere:   Uint8Array [4, 5]
```

The OPFS driver now copies a view that does not cover its whole buffer before it reaches the native writable stream.
This applies to `writeFile`, `writeStream` and positional writes through `openWritableFile`. The copy costs one pass
over the written bytes, and only for partial views; a `Uint8Array` that owns its whole buffer is still passed without a
copy, on every engine.

`openSyncFile` returns the browser's own `FileSystemSyncAccessHandle`, and the library does not mediate its writes. This
release does not change that handle and has not measured its behavior on WebKit.
