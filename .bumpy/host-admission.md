---
"@okikio/opfs": minor
---

Host storage now accepts an explicit deployment profile. Ordinary roots retain the existing API and owned sibling copy
staging. A native runtime exposing `copyFile`, `link`, and `rename` does not establish that every mounted filesystem
supports those primitives: real Mountpoint and BlobFuse runs rejected different parts of staged copying.

Select the actual known mount mode once at the composition root:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createNodeAdapter } from "@okikio/opfs/adapter/node";

const fs = createFileSystem(createNodeAdapter({ root: "/mnt/s3/app", profile: "mountpoint-s3" }));
try {
  await fs.writeFile("/draft", "new result");
  console.log(fs.plan({ operation: "copy", path: "/draft", destination: "/result" }).supported); // false
  // Explicit best-effort copying uses read/write and may expose a partial destination on failure.
  await fs.copy("/draft", "/result", { preserve: false });
} finally {
  await fs.close();
}
```

Node, Deno, and Bun share the same option. The mountpoint-s3 preset targets general-purpose S3 with the documented
writable/delete flags; blobfuse-block targets block-blob mode. Both reject default strong publication before metadata,
parents, staging, directory traversal, locks, or source acquisition. Turning off native copy/move cannot bypass the
requirement. No EPERM inference or automatic weaker retry is added. Atomic exclusive no-replace remains a separate
requirement and rejects a direct writer.

Complete caller declarations, including read-only policy, are available through `@okikio/opfs/driver/host`. Profiles are
validated, copied, frozen, and inspectable. Read-only policy reaches indirect parents and KV/unstorage namespace
mutations before I/O. Mutable resources in the two mount presets remain conservatively unadmitted until their complete
workflow is independently established. This is a deployment contract, not live discovery or a crash durability promise.
[Host roots](../docs/host.md) teaches ordinary and advanced examples, supported modes, ownership, publication
alternatives, and limits. Existing application publication queues remain application-owned.
