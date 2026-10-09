---
"@okikio/opfs": patch
---

### Classify file creation against the entry observed under its lock

`getFileHandle(path, { create: true })` now rejects with `type-mismatch` when its locked recheck finds a directory.
Previously, a directory that appeared after the first missing-entry check could receive a file-shaped handle. The second
check already avoided overwriting an existing file; it now also refuses the wrong entry kind.

```text
initial stat: missing → acquire file lock → locked stat
                                         ├─ missing: create an empty file
                                         ├─ file: return a handle without truncating it
                                         └─ directory: reject type-mismatch and release the lock
```

For example, an application that imports a directory while another task requests a file handle can classify the refusal
using the public error fields:

```ts
import { createFileSystem, FileSystemError } from "@okikio/opfs";
import { createMemoryAdapter } from "@okikio/opfs/adapter/memory";

await using fs = createFileSystem(createMemoryAdapter(), { disposeAdapter: true });
await fs.ensureDir("/imports");
try {
  await fs.getFileHandle("/imports", { create: true });
} catch (error) {
  if (!(error instanceof FileSystemError) || error.code !== "type-mismatch") throw error;
  console.log(error.operation, error.path); // get-file /imports
}
```

The lock coordinates participating facade operations. This check does not make external host writers atomic, and a
returned handle is not a permanent reservation of its entry kind. A creation refusal releases its lock so the
application can correct the path and retry. An existing file remains intact when the recheck finds it.

`readDir()` also reports `operation: "read-dir"` when its physical-entry guard refuses a link or foreign entry. It
previously reported `empty-dir`, which could send diagnostic or recovery code down the wrong route. The guard still
refuses traversal before metadata lookup or child enumeration. Callers should classify the stable code, operation and
path instead of matching the human-readable message.

Held native-storage controls cover both kinds appearing after absence, unchanged existing bytes, zero writes on refusal,
and successful retry after lock release. Separate listing controls cover link and foreign refusal plus an
ordinary-directory positive control. These changes add one local kind comparison; no performance measurement or broader
external-writer guarantee is claimed.
