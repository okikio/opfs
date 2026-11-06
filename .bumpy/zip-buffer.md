---
"@okikio/opfs": patch
---

Keep ZIP previews and header evidence independent of borrowed scratch buffers.

```ts
import { openZip } from "@okikio/opfs/archive/zip";
import type { ByteSourceType } from "@okikio/opfs/source";

export async function preview(source: ByteSourceType) {
  const archive = await openZip(source);
  const member = archive.entries.find((entry) => entry.kind === "file");
  if (!member) throw new RangeError("ZIP has no file member.");
  const result = await archive.read(member.id, { length: Math.min(16, member.size) });
  await source.read(0, Math.min(1, source.size));
  return result.bytes;
}
```

A byte source can retain immutable logical contents while reusing the buffer returned by `read`. The ZIP reader
previously kept local-header views across later source reads and could expose a borrowed STORED prefix. It now keeps
fixed 30-byte headers and its bounded directory independent of those reads, and returns an owned selected interval. The
caller still owns the source. Regressions reproduce scratch reuse with STORED, DEFLATE, ZipCrypto and WinZip AES, and a
name callback that starts another source read. No checksum or authentication scope changes.
