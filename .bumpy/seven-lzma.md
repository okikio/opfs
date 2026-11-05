---
"@okikio/opfs": minor
---

Preview single-member LZMA1/LZMA2 7z payloads and bounded encoded directory headers.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openSeven } from "@okikio/opfs/archive/seven";

async function preview(file: Blob): Promise<Uint8Array | undefined> {
  const archive = await openSeven(createBlobSource(file));
  const entry = archive.entries.find((entry) => entry.kind === "file" && entry.readable);
  if (!entry) return undefined;
  const result = await archive.read(entry.id, { length: Math.min(entry.size, 4096) });
  console.log(archive.headers, result.checks, result.decoding);
  return result.bytes;
}
```

Encoded metadata requires a complete decoded CRC before names are exposed. Packed-byte and decoded-member CRCs retain
separate scopes. Default compressed previews decode the complete selected member; explicit unverified prefixes report
pending termination and checksum evidence. Opening limits and signals remain active across later reads. Solid, encrypted
and multi-coder/filter payloads remain unsupported. See the [7z guide](../docs/seven.md) for finite codec policy,
lifetime budgets and independent 7-Zip/libarchive fixtures.
