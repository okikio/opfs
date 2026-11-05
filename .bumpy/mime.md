---
"@okikio/opfs": minor
---

Preview MIME bodies and attachments with explicit encoding examination

MIME multipart indexing scans bounded wire bytes; decoded previews return buffered bytes and never render HTML,
authenticate senders or decrypt opaque bodies. Complete reads examine the entire transfer encoding, while prefixes
report whether a suffix remains unexamined.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openMime } from "@okikio/opfs/archive/mime";

async function previewAttachment(eml: Blob): Promise<Uint8Array | undefined> {
  const mail = await openMime(createBlobSource(eml));
  const attachment = mail.entries.find((part) => part.filenameStatus === "decoded");
  if (!attachment) return undefined;
  const result = await mail.prefix(attachment.id, 1024);
  console.log(attachment.filename, result.complete, result.work);
  return result.bytes;
}
```

See [the capability guide](../docs/mime.md) for finite budgets, source ownership, exact unsupported profiles and
independent fixture evidence.
