---
npm/@okikio/opfs: minor
---

### Read `.warc.gz`, write WARC files, and read, verify and write WACZ packages

`openWarc()` now reads `.warc.gz` files with one record per gzip member, the layout most crawlers write. Before, it
refused any gzip input. Every entry now has `offset` and `length`, the record's position in the file, which is what a
CDXJ index stores:

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openWarc } from "@okikio/opfs/archive/warc";

const archive = await openWarc(createBlobSource(file), { maxDecodedBytes: 512 * 1024 * 1024 });
console.log(archive.compression); // "gzip"
for (const entry of archive.entries) console.log(entry.type, entry.offset, entry.length);
```

Gzip does not record a member's length, so the reader finds each boundary with the host's `DecompressionStream`, which
rejects truncated members and trailing bytes. Opening a `.warc.gz` decodes every member once; reading a record decodes
only its member. Set `maxDecodedBytes` to at least the uncompressed size.

`archive/warc/write` adds `createWarcStream()`, which writes WARC 1.1 records, plain or one gzip member per record:

```ts
import { createWarcStream } from "@okikio/opfs/archive/warc/write";

const stream = createWarcStream([{
  type: "resource",
  targetUri: "https://example.com/notes.txt",
  contentType: "text/plain",
  block: new TextEncoder().encode("hello"),
}], { compression: "gzip", onRecord: (record) => console.log(record.offset, record.length) });
```

It fills in `WARC-Record-ID`, `WARC-Date`, `Content-Length` and a `sha256:` `WARC-Block-Digest`, and refuses values with
CR or LF so a URL cannot add header lines.

New `archive/wacz` and `archive/wacz/write` entry points read and write WACZ 1.1.1 files:

```ts
import { openWacz } from "@okikio/opfs/archive/wacz";

const wacz = await openWacz(source);
const hit = (await wacz.readIndex()).find((record) => record.url === "https://example.com/")!;
const warc = await wacz.openWarc(hit.filename); // reads only this WARC's range of the ZIP
const report = await wacz.verify(); // { valid, errors, missing, checked }
```

`createWaczStream({ warcs, index, pages })` writes the ZIP with STORED WARC files and a `datapackage.json` that lists
every file's size and SHA-256, computed while streaming. `createCdxj()`, `parseCdxj()` and `getSurt()` format and read
CDXJ index lines.

Breaking: the "gzip is unsupported" error is gone. A truncated or corrupt gzip input now fails with `invalid-archive`,
and one gzip member that holds several records fails with `unsupported-profile`. WACZ signing and signature checks are
not included.
