---
"@okikio/opfs": minor
---

Verify selected Arweave signatures and complete payload roots before previewing owned bytes.

```ts
import { verifyArweaveTransaction } from "@okikio/opfs/content/arweave";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(
  expectedId: string,
  header: Uint8Array,
  payload: ByteSourceType,
  subtle: Pick<SubtleCrypto, "digest" | "importKey" | "verify">,
) {
  const transaction = await verifyArweaveTransaction(header, {
    expectedId,
    profile: "rsa4096-pss32-v2",
    subtle,
  });
  const verified = await transaction.verifyData(payload, {
    chunkProfile: "arweave-js-1.15.7",
    maxDataBytes: 8 * 1024 ** 2,
  });
  return await verified.source.read(0, Math.min(1024, verified.source.size));
}
```

The first preview reads and verifies the whole bounded payload before returning a private immutable snapshot; later
ranges are owned copies. Header signatures, payload roots, computed owner addresses and chain inclusion have separate
proof scopes. The selected RSA4096-PSS32 format-2 profile refuses other valid signature forms, including observed
Node-SDK maximum-salt signatures. Native offline vectors retain both that refusal and explicit 32-byte-salt positives
across chunk boundaries. The configured `arweave` client composes injected Fetch and crypto with the same verification,
exact body bounds and inherited budgets. No transaction is posted, no wallet is acquired and no chain inclusion is
claimed. The [guide](../docs/arweave.md) explains the writer partition, full-read cost, ArFS composition and recovery.
