---
"@okikio/opfs": minor
---

Retain GCS metadata versions and reported CRC32C checksums, and pair metadata conditions with exact object generations.

```ts
import { createGcsClient } from "@okikio/opfs/gcs";

export async function removeObservedObject(bucket: string, token: string, key: string) {
  const client = createGcsClient({ bucket, token });
  const observed = await client.head(key);
  if (observed === null) return;
  if (observed.revision === undefined || observed.metageneration === undefined) {
    throw new Error("The provider omitted the versions required for guarded deletion.");
  }
  await client.delete(key, {
    revision: observed.revision,
    ifMetagenerationMatch: observed.metageneration,
  });
}
```

Native client and driver results preserve optional `metageneration` strings and canonical four-byte Base64 `crc32c`
values through observations, listings and publication receipts. Omitted fields stay absent; null and malformed fields
are rejected. Decimal tokens never pass through Number. A checksum is a provider observation, not verified bytes.

Native reads, observations, deletion and upload initiation accept a metadata match paired with a positive generation.
Rewrite can separately guard the source and destination. Invalid pairs fail before credentials or source acquisition; a
provider 412 requires deliberate reconciliation. Upload guards are sent at initiation; final-publication rechecking is
not established. Invalid final metadata retains unknown-publication errors rather than implying that no write occurred.
Native driver types now retain provider-specific signatures; portable filesystem stat remains unchanged.

The pinned official-SDK/emulator fixture compares reported metadata and complete bytes. Its emulator hardcodes
metageneration "1" and does not enforce metadata guards; authored tests cover query construction and failures. Neither
SDK metadata equality nor its disabled checksum validation proves content integrity. The [GCS guide](../docs/gcs.md)
explains precision, recovery, checksum and native-service verification limits.
