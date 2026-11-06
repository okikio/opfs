---
"@okikio/opfs": minor
---

Preview legacy ZipCrypto members with explicit password bytes

Traditional ZipCrypto reads now support bounded STORED and DEFLATE previews with explicit password bytes. This obsolete
cipher provides no authentication; short unverified prefixes can be wrong even when the weak password-header check
passes.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(archiveBytes: ArrayBuffer, password: Uint8Array): Promise<Uint8Array | undefined> {
  const archive = await openZip(createBlobSource(new Blob([archiveBytes])));
  const entry = archive.entries.find((entry) => entry.kind === "file" && entry.encryption === "zipcrypto");
  if (!entry) return undefined;
  const result = await archive.read(entry.id, {
    password,
    maxPasswordBytes: 1024,
    offset: 0,
    length: Math.min(entry.size, 4096),
    verify: true,
    maxSourceBytes: 32 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 4096,
    maxRequests: 1024,
  });
  console.log(result.integrity, result.encryption); // CRC evidence; authentication is always "none".
  return result.bytes;
}
```

See [the capability guide](../docs/password.md) for work limits, resource ownership, evidence and unsupported profiles.
