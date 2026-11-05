---
"@okikio/opfs": minor
---

Preview WinZip AES DEFLATE members after complete ciphertext authentication and bounded compressed-byte decryption.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(
  archiveBytes: ArrayBuffer,
  password: Uint8Array,
  subtle: SubtleCrypto,
): Promise<Uint8Array | undefined> {
  const archive = await openZip(createBlobSource(new Blob([archiveBytes])));
  const entry = archive.entries.find((entry) => entry.kind === "file" && entry.encryption === "winzip-aes");
  if (!entry) return undefined;
  const options = {
    password,
    aes: { subtle, maxCiphertextBytes: 8 * 1024 * 1024, maxBlocks: 8192 },
    offset: 0,
    length: Math.min(entry.size, 4096),
    verify: false,
    maxSourceBytes: 9 * 1024 * 1024,
    maxDecodedBytes: 17 * 1024 * 1024,
    maxOutputBytes: 4096,
    maxRequests: 16,
  };
  const plan = archive.plan(entry.id, options);
  if (!plan.supported) throw new Error(`Preview exceeds policy: ${plan.reason}`);
  const result = await archive.read(entry.id, options);
  console.log(result.encryption, result.integrity, result.work);
  return result.bytes;
}
```

A prefix still authenticates and decrypts the whole compressed member. Full AE-2 DEFLATE reads report
`full-member-decode` without claiming a plaintext CRC; AE-1 full reads also check CRC. See the
[AES guide](../docs/aes.md) for native codec trust, finite limits and cancellation ownership.
