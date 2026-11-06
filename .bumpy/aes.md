---
"@okikio/opfs": minor
---

Preview WinZip AES STORED members through explicitly supplied native cryptography. Full ciphertext authentication
precedes plaintext, while headers and filenames remain unauthenticated.

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

See the [aes guide](../docs/aes.md) for ownership, finite limits, unsupported profiles and recovery.
