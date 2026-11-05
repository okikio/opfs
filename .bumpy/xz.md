---
"@okikio/opfs": minor
---

Read indexed XZ ranges with explicit selected-block verification and finite LZMA2 work.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openXz } from "@okikio/opfs/archive/xz";

export async function preview(compressed: Blob): Promise<Uint8Array> {
  const archive = await openXz(createBlobSource(compressed));
  const result = await archive.read({ length: Math.min(4096, archive.size) });
  console.log(archive.metadata, result.checks, result.work);
  return result.bytes;
}
```

The single-stream LZMA2 profile supports CRC32, CRC64 and no payload check. Indexed metadata remains separate from
payload evidence. Default reads drain and verify only selected blocks; explicit unchecked prefixes can cancel early with
pending checks. CRC64 uses a private 2 KiB table and exact hexadecimal evidence, without a global cache or complete
plaintext buffer. The [XZ guide](../docs/xz.md) explains declared sizes, cumulative budgets, cancellation and the
unsupported SHA-256/filter-chain/concatenated-stream profiles. Native XZ, Python liblzma and 7-Zip verify complete
fixture bytes independently; checksum corruption controls exercise rejection. Checksums do not establish authenticity.
