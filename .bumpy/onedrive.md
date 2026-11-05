---
"@okikio/opfs": minor
---

### Access OneDrive files through native IDs and upload capabilities

The optional onedrive subpath addresses an explicitly selected drive through Microsoft Graph IDs. It keeps Graph OAuth
separate from preauthenticated download and upload URLs.

```ts
import { OnedriveClient } from "@okikio/opfs/onedrive";

const files = new OnedriveClient({
  driveId: "replace-with-your-drive-id",
  token: () => "replace-with-your-Graph-OAuth-token",
  // Exact deployment origins, obtained from your trusted tenant configuration.
  // These are examples; do not copy them as a general Microsoft host allowlist.
  downloadOrigins: ["https://contoso.sharepoint.com"],
  uploadOrigins: ["https://contoso.sharepoint.com"],
});
const bytes = new TextEncoder().encode("hello");
const upload = await files.createUpload({
  size: bytes.length,
  target: { kind: "create", parentId: "replace-with-a-parent-item-id", name: "hello.txt", conflict: "fail" },
});
const result = await files.writeUpload(upload, 0, bytes);
if (!result.complete) throw new Error("Upload is staged; inspect its missing ranges before continuing.");
const stream = await files.download(result.item.id, { at: 0, length: 5 });
console.log(await new Response(stream).text()); // hello
await files.trash(result.item.id); // Graph DELETE recycles this item; it does not permanently erase it.
```

Exact origin allowlists and manual redirects guard capability requests. Native upload status retains partial and
possibly sparse missing ranges; it is not a contiguous transfer checkpoint. Lost final receipts remain unknown. Authored
protocol fixtures do not establish live Graph behavior; filesystem projection and immutable sources are not claimed.

See [the complete profile and limits guide](docs/onedrive.md).
