---
"@okikio/opfs": minor
---

Read selected age payload chunks with an explicitly unlocked file key.

```ts
import { createDecipheriv } from "node:crypto";
import { openAge } from "@okikio/opfs/crypto/age";
import { createNodeAgeAead } from "@okikio/opfs/crypto/age-node";
import type { ByteSourceType } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(
  ciphertext: ByteSourceType,
  fileKey: Uint8Array,
  subtle: SubtleCrypto,
  memberName: string,
): Promise<Uint8Array> {
  const age = await openAge(ciphertext, {
    profile: "age-v1-file-key",
    fileKey,
    subtle,
    aead: createNodeAgeAead({ createDecipheriv }),
  });
  try {
    const zip = await openZip(age.source);
    const member = zip.entries.find((entry) => entry.name === memberName);
    if (member === undefined) throw new Error("Archive member does not exist");
    return (await zip.read(member.id)).bytes;
  } finally {
    await age.dispose();
  }
}
```

The binary age v1 profile authenticates the original header and final chunk before exposing its plaintext size. Selected
reads authenticate complete covering 64 KiB chunks; skipped middle chunks remain unchecked until explicit verification.
Recipient unlocking, armor, encryption and credential discovery remain outside this profile. The ciphertext and crypto
capabilities stay caller-owned; disposing the reader clears its owned scratch best-effort and joins borrowed work. The
input file key and returned plaintext remain caller-owned; disposal does not erase them. A failed authentication barrier
uses an explicit sanitized `AgeError("authentication", message)`. Other provider and setup faults keep their original
reasons, so missing crypto support is not reported as a bad tag. Native ChaCha20-Poly1305 availability remains a caller
capability, including when using the optional injected Node factory.

See the [guide](../docs/age.md) for supported profiles, costs, ownership and verification limits.
