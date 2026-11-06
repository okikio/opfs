---
"@okikio/opfs": minor
---

### Preview stored WARC blocks with explicit digest scope

The optional archive/warc subpath indexes physical uncompressed WARC 1.0/1.1 records and reads selected stored-block
ranges. Ordinal IDs retain duplicate record IDs without overwriting entries.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openWarc } from "@okikio/opfs/archive/warc";

export async function preview(warcBytes: ArrayBuffer): Promise<void> {
  const archive = await openWarc(createBlobSource(new Blob([warcBytes])));
  const record = archive.entries.find((entry) => entry.type === "response" && entry.readable);
  if (record) {
    const preview = await archive.read(record.id, { length: Math.min(record.size, 1024) });
    console.log(record.recordId, record.fields, preview.bytes, preview.integrity); // integrity: "none"
  }
}
```

A normal read has no integrity claim. Explicit whole-block SHA1/SHA256 verification uses injected WebCrypto, defaults to
a 1 MiB materialization ceiling and never verifies HTTP entity digests. ARC, gzip, revisit and segmentation
reconstruction remain unsupported. Independent warcio fixtures verify the recorded profile.

See [the complete profile and limits guide](docs/warc.md).
