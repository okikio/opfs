---
"@okikio/opfs": patch
---

### Cancel record planning before replacing persisted data

Record adapters now capture each operation's settings once and check cancellation after successful metadata/body
acquisition, before fresh mutation or result publication. Previously an append waiting for `get()` could continue into
`set()` after the caller aborted. The same ownership rule covers replace planning, directory creation, stat, native
materialized reads and stream acquisition across record backends.

```ts
import { createFileSystem } from "@okikio/opfs";
import { createLocalStorageAdapter } from "@okikio/opfs/adapter/localstorage";

const fs = createFileSystem(createLocalStorageAdapter(localStorage, { prefix: "drafts" }));
const controller = new AbortController();
try {
  await fs.writeFile("/draft.txt", "first");
  await fs.writeFile("/draft.txt", " next", { mode: "append", signal: controller.signal });
} finally {
  await fs.close();
}
```

Cancellation stops admission of new effects; it cannot roll back a mutation already dispatched to a store. Its actual
acknowledgement or rejection remains authoritative. An append/update implemented by separate record get/set operations
still requires cooperating writers; a backend-native transactional mode has its own stronger contract. Use the public
filesystem's `writeFile` with its append mode when constructing lower-level operations directly.

An acquired native read stream that cannot be published because cancellation arrived is cancelled exactly once before
refusal completes. The adapter joins the producer's actual cancellation; an independent cancellation fault remains
alongside the primary package `aborted` error. An uncooperative producer can keep that join pending. This does not
promise prompt physical retirement of arbitrary borrowed store effects.

Stored records are copied through their admitted schemas, so adapter decisions do not replay mutable getters. Directory
projection now owns its acquired iterator explicitly: malformed child metadata and an independently failed `return()`
both remain observable. Actual EOF performs no extra return, including cancellation caused by its done getter. A
consumer ending listing early still returns the acquired iterator once.

Finite controls cover delayed metadata for read/stat/append/replace/mkdir, raw undefined/null/Error cancellation causes,
preabort without option or storage effects, changing settings, actual store rejection, already-dispatched
acknowledgement, late acquired stream retirement and independent cleanup failure. These are behavior controls, not
timing benchmarks or browser durability claims.
