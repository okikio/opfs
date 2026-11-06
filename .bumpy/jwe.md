---
"@okikio/opfs": minor
---

Authenticate compact direct-AES-GCM messages before previewing an embedded archive.

```ts
import { openJwe } from "@okikio/opfs/crypto/jwe";
import { openZip } from "@okikio/opfs/archive/zip";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function previewZip(
  encrypted: ByteSourceType,
  key: CryptoKey,
  subtle: SubtleCrypto,
): Promise<Uint8Array> {
  const message = await openJwe(encrypted, {
    profile: "jwe-compact-dir-a256gcm",
    key,
    subtle,
    maxEnvelopeBytes: 12 * 1024 * 1024,
    maxPlaintextBytes: 8 * 1024 * 1024,
  });
  try {
    const zip = await openZip(message.source);
    const entry = zip.entries.find((item) => item.name === "preview.txt");
    if (!entry) throw new Error("The archive has no preview.txt entry.");
    return (await zip.read(entry.id, { offset: 0, length: Math.min(entry.size, 4096) })).bytes;
  } finally {
    message.dispose();
  }
}
```

The optional reader requires a caller-selected A128GCM or A256GCM profile, a high-entropy direct key and an explicit
`SubtleCrypto` capability. It authenticates the complete bounded message before returning an owned plaintext source.
Selected plaintext reads can feed ZIP and other archive readers without extracting files to disk, but they still pay for
whole-message authentication and buffering. Dispose the message after nested readers finish; earlier returned byte
copies remain caller-owned.

There is no key lookup, password derivation, encryption API, compressed JWE, JSON serialization or multi-recipient
support. Symmetric authentication does not identify a sender or establish freshness. Published RFC 7520 bytes and pinned
independent JOSE producer/consumer fixtures exercise the selected wire profiles; both implementations use native AES, so
this is not an independent cryptographic primitive audit. The [guide](../docs/jwe.md) explains authority, limits,
cancellation and disposal.
