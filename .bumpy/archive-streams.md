---
"@okikio/opfs": minor
---

### Scan one-shot TAR streams and create bounded TAR/PAX or STORED ZIP32 archives

TAR inspection now understands bounded PAX metadata and GNU long names/links. The new `archive/stream` subpath scans
one-shot streams with single-use entry bodies and writes deterministic ustar/PAX output. The `archive/write` subpath
writes STORED ZIP32 streams, including entries with unknown sizes through data descriptors:

```ts
import { createTarStream, readTarStream } from "@okikio/opfs/archive/stream";
import { createZipStream } from "@okikio/opfs/archive/write";

const tar = createTarStream([{ name: "hello.txt", size: 5, body: new Blob(["hello"]).stream() }]);
await readTarStream(tar, async (entry, body) => {
  if (entry.kind === "file") {
    for await (const bytes of body) console.log(new TextDecoder().decode(bytes));
  }
});
const zip = createZipStream([{ name: "hello.txt", source: new TextEncoder().encode("hello") }]);
console.log((await new Response(zip).arrayBuffer()).byteLength);
```

Unconsumed TAR bodies drain under the same budget before the next entry; returning `false` stops and cancels the source.
Writers acquire sources lazily and retire active readers and iterators on cancellation. The TAR guide explains metadata
precedence and link handling; ZIP creation enforces a portable relative-name policy. Neither writer extracts host files.
Independent Python archive consumers check payloads, and the system TAR consumer checks PAX output.

These are explicit profiles: no sparse TAR, encrypted ZIP output, ZIP64 output or DEFLATE writing. Reader support does
not imply equivalent writer support. TAR header checksums do not authenticate payloads; ZIP CRC detects corruption
without authenticating the sender. See the archive guides for finite metadata, source, decoded and output budgets.
