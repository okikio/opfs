---
"@okikio/opfs": patch
---

Directory admission now follows object-store continuation pages instead of treating one empty page as absence. This
credential-free protocol model demonstrates the public composition and a later-page descendant:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createObjectAdapter } from "@okikio/opfs/adapter/object";
import { defineObjectDriver } from "@okikio/opfs/driver/object";
import type { ObjectBackendType } from "@okikio/opfs/driver/object";

const backend: ObjectBackendType = {
  name: "paged-demo",
  capabilities: { rangeRead: false, streamRead: false, streamWrite: false, copy: false, conditionalWrite: false },
  async head() {
    return null;
  },
  async get() {
    return new Blob().stream();
  },
  async put() {
    throw new Error("This read-only model has no publication operation.");
  },
  async delete() {
    throw new Error("This read-only model has no deletion operation.");
  },
  async list({ prefix, cursor }) {
    if (prefix !== "reports/") return { objects: [], prefixes: [] };
    if (cursor === undefined) return { objects: [], prefixes: [], cursor: "next" };
    return { objects: [{ key: "reports/result", size: 1 }], prefixes: [] };
  },
};
const fs = createFileSystem(createObjectAdapter(defineObjectDriver(backend, { name: backend.name }), {
  maxListPages: 100,
}));
try {
  console.log((await fs.stat("/reports")).kind); // directory
  console.log(fs.inspect().optimizations.writeAdmission); // false
} finally {
  await fs.close();
}
```

S3 and Azure adapter option aliases expose the same `maxListPages` policy. The default is 10,000 pages per scan, an
application bound rather than a service limit. Exhausted policy, repeated cursors, foreign-prefix responses, and
provider errors reject explicitly. Empty-directory deletion checks all needed pages; lazy consumer return stops more
requests. Facade and adapter destination validation remain enabled by default. Explicit binary write-admission
delegation still retains adapter validation. Conditional providers now use fresh exact-object preconditions for bytes,
streams, and absent creation; native copy carries the source ETag observed by admission. These are exact-object fences,
not atomic ownership of the whole prefix hierarchy. Nonconditional providers retain their weaker contract.

The same review prevents diagnostics from changing live routes, retains construction-time read-only policy, rejects
record/bridge mutation before indirect storage work, excludes malformed or foreign namespace aliases, and protects a
Deno KV reader whose pin renews after the collector's expired listing snapshot. Pin deletion uses its current version
and deadline together, retaining exact accounting. [Adapter contracts](../docs/adapters.md) and
[storage ownership](../docs/storage.md) describe the boundaries and scan costs.

Direct host-driver signals now remain active after a read stream opens and between awaited append/update setup, partial
writes, and final truncation. Aborting releases the native source or acquired file before subsequent work is admitted.
Bun retains its ordinary fast path and uses the Node-compatible cancellation lane for signal-aware complete reads and
replacements. Already dispatched host work can still complete; these controls do not promise rollback.
