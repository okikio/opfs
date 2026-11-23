---
npm/@okikio/opfs: minor
---

Read XZ files that use SHA-256 block checks (`xz --check=sha256`). Before this release `openXz` refused them with
`unsupported-profile`; now a verified read hashes each selected block's decoded bytes and compares the result with the
stored digest.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openXz } from "@okikio/opfs/archive/xz";

export async function head(compressed: Blob): Promise<Uint8Array> {
  const archive = await openXz(createBlobSource(compressed));
  console.log(archive.check); // "sha256"
  const result = await archive.read({ length: Math.min(1024, archive.size) });
  console.log(result.checks[0]?.integrity); // "sha256-verified"
  console.log(result.checks[0]?.sha256); // the stored digest, 64 lowercase hex digits
  return result.bytes;
}
```

| Read                        | `integrity`       | Failure on a changed check |
| --------------------------- | ----------------- | -------------------------- |
| complete block, `verify` on | `sha256-verified` | `checksum-mismatch`        |
| `verify: false` or a prefix | `pending`         | none                       |

`XzArchiveType.check` gains `"sha256"`, `XzCheckType.integrity` gains `"sha256-verified"`, and `XzCheckType` gains
`sha256`. Code that switches on these unions should add the new members. The hash runs over the decoder's chunks, so it
keeps no copy of the block; it costs one more pass over decoded bytes. The digest detects corruption only and does not
authenticate the producer. Reserved check IDs, Delta/BCJ filters and concatenated streams are still refused.

Evidence: the genuine XZ Utils SHA-256 fixture now decodes, its digest matches Web Crypto, and changing any of its 32
stored bytes fails verification on Deno, Node and Bun.
