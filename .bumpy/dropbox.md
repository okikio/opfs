---
"@okikio/opfs": minor
---

Read native Dropbox file metadata and content, and use explicit upload-session offset evidence. Caller credentials and
account context remain explicit; unknown publication is not retried automatically.

```ts
import { DropboxClient } from "@okikio/opfs/dropbox";

export async function preview(
  token: string,
  fileId: string,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string> {
  const files = new DropboxClient({ token: () => token, fetch });
  const metadata = await files.stat(fileId, signal);
  if (metadata.kind !== "file" || metadata.rev === undefined) {
    throw new TypeError("Select a stored file.");
  }
  // The native revision route avoids switching to a newly edited file between
  // separate preview reads. Dropbox still controls revision retention/access.
  const bytes = await files.read(`rev:${metadata.rev}`, {
    at: 0,
    length: 1024,
    signal,
  });
  return new TextDecoder().decode(bytes);
}
```

See the [dropbox guide](../docs/dropbox.md) for ownership, finite limits, unsupported profiles and recovery.
