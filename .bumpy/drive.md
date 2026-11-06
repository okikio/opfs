---
"@okikio/opfs": minor
---

### Upload and read Google Drive stored files by ID

The optional drive subpath borrows per-request OAuth acquisition and exposes bounded pages, stored-file ranges and
fixed-size resumable sessions. Duplicate names retain distinct native IDs.

```ts
import { DriveClient } from "@okikio/opfs/drive";

// Your application obtains and refreshes this OAuth token. No ambient credentials are read.
const accessToken = "replace-with-an-OAuth-access-token";
const drive = new DriveClient({ token: () => accessToken });
const bytes = new TextEncoder().encode("hello");
const upload = await drive.createUpload({ name: "hello.txt", mimeType: "text/plain", size: bytes.length });
const result = await drive.writeUpload(upload, 0, bytes);
if (!result.complete) throw new Error("Upload is incomplete; query its session before continuing.");

// The receipt's ID identifies this creation even if another hello.txt already exists.
const stream = await drive.download(result.file.id, { at: 0, length: 5 });
console.log(await new Response(stream).text()); // hello
await drive.trash(result.file.id); // Reversible: drive.update(id, { trashed: false }).
// drive.remove(id) is a separate permanent deletion, including native folder deletion semantics.
```

Session receipts distinguish acknowledged bytes from validated final publication. Workspace export, filesystem path
projection and immutable-source identity remain unsupported. Authored protocol fixtures establish message handling, not
live Drive conformance.

See [the complete usage and limits guide](docs/drive.md).
