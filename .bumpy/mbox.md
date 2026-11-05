---
"@okikio/opfs": minor
---

Preview explicitly selected LF-native mailbox dialects

MBOX indexing keeps raw trailing bytes and requires a chosen dialect. Selected message sources expose bounded LF-to-CRLF
preview conversion and explicit quote/trailing policies; they never claim recovery of original signed bytes.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openMbox } from "@okikio/opfs/archive/mbox";
import { openMime } from "@okikio/opfs/archive/mime";

export async function previewAttachment(mailbox: Blob) {
  const box = await openMbox(createBlobSource(mailbox), { dialect: "mboxrd" });
  // This producer is known to append exactly one mailbox-owned blank line.
  const message = await box.openMessage(0, { trailing: "remove-one" });
  const mime = await openMime(message.source);
  const attachment = mime.entries.find((entry) => entry.filename !== undefined);
  if (!attachment) return undefined;
  return { filename: attachment.filename, preview: await mime.prefix(attachment.id, 4096) };
}
```

See [the capability guide](../docs/mbox.md) for ownership, work limits, recovery and independent interoperability
evidence.
