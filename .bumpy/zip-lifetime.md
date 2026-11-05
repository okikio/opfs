---
"@okikio/opfs": patch
---

Keep ZIP opening budgets and cancellation active for every later member read.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openZip } from "@okikio/opfs/archive/zip";

export async function preview(file: Blob, signal: AbortSignal) {
  const archive = await openZip(createBlobSource(file), { signal, maxOutputBytes: 1024 });
  return await archive.read(0, { length: 16 });
}
```

Previously, later reads could omit the opening ledger or replace its signal and limits. The opened archive now captures
source descriptors and callbacks before asynchronous work and retains opening authority. Per-read limits can narrow the
remaining allowance, and additional ledgers compose without charging the same owner twice. This applies to STORED,
DEFLATE, ZipCrypto and WinZip AES reads. Repeated previews must set a finite opening allowance for their total intended
work; per-read defaults remain unchanged. `archive.work` remains the opening snapshot, while each result reports its own
work. The [guide](../docs/archive.md) explains cumulative budgets and transport accounting.
