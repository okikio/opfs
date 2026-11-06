---
"@okikio/opfs": minor
---

Preview selected Cryptomator content without decrypting unrelated file chunks.

```ts
import { openCryptomator } from "@okikio/opfs/crypto/cryptomator";
import type { CryptomatorSourceType } from "@okikio/opfs/crypto/cryptomator";
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(
  configuration: Uint8Array,
  masterKey: Uint8Array,
  encryptedArchive: Blob,
  subtle: SubtleCrypto,
) {
  const vault = await openCryptomator(configuration, masterKey, { subtle });
  let plaintext: CryptomatorSourceType | undefined;
  try {
    plaintext = await vault.open(createBlobSource(encryptedArchive));
    const archive = await openZip(plaintext);
    const member = archive.entries.find((entry) => entry.name === "selected.txt");
    if (!member) throw new Error("The selected archive member is absent.");
    return await archive.read(member.id, { length: Math.min(1024, member.size), verify: false });
  } finally {
    try {
      await plaintext?.[Symbol.asyncDispose]();
    } finally {
      await vault[Symbol.asyncDispose]();
    }
  }
}
```

The selected format-8 SIV_GCM profile requires application-unlocked keys. It authenticates the configuration, ordinary
names with their parent directory ID, and complete content chunks covering each returned range. A small preview can
still require a complete 32 KiB plaintext chunk. ZIP checksum scope remains separate from chunk authentication.

Original EOF, freshness, directory completeness and the mapping from names to content objects are not authenticated.
Removing complete trailing chunks can produce a valid shorter object. Password unlocking, long-name lookup, traversal
and writes remain separate work. Native cryptography is injected; no SDK enters production. The
[guide](../docs/cryptomator.md) explains cumulative budgets, disposal, cancellation and reciprocal independent fixtures.
