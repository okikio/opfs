---
"@okikio/opfs": minor
---

Preview unencrypted ZIP BZip2 members through the existing ZIP reader.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(file: Blob, name: string) {
  const archive = await openZip(createBlobSource(file));
  const member = archive.entries.find((entry) => entry.name === name);
  if (!member) throw new RangeError("ZIP member does not exist.");
  return await archive.read(member.id, {
    length: Math.min(1024, member.size),
    bzip: { maxMemoryBytes: 8 * 1024 ** 2 },
  });
}
```

Method 12 uses the project-owned bounded BZip2 decoder. Before returning plaintext, it checks the covering block; a
prefix still leaves the complete BZip2 stream and ZIP CRC pending. A full or explicitly verified read checks both
complete checksums. Small previews can require a whole block transform, so decoded work and returned bytes have separate
limits. Native Python, 7-Zip and libarchive fixtures compare every original byte. Encryption with method 12, randomized
blocks and concatenated streams remain unsupported. The [guide](../docs/zip-bzip.md) explains work, cancellation and
checksum scopes.
