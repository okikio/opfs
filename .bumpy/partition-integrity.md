---
"@okikio/opfs": patch
---

### Reject damaged KV partitions before delivering bytes or publishing a patch

Deno KV files use immutable byte parts and a small manifest that fixes each part's position. A shortened part must not
shift the next part into that position. Previously, streaming reads could report success with too few bytes, and a patch
could copy a shortened predecessor into a new generation. Checking only the complete byte count also missed a shortened
part followed by an oversized part with the same total length.

Every partition read now validates the exact expected length before delivering its bytes. Whole-record reads, byte
ranges, streams, append, and update share that rule. The manifest must also declare the part count implied by its
logical size and part size. Invalid manifests reject before reader pin acquisition. Invalid parts reject with the
`unknown` filesystem category, release the read's pin, and leave the original logical entry in place when a patch fails.

```text
manifest: size=4, partBytes=2, parts=2
           |
           +-- part 0: [1]       -> reject: expected two bytes
           `-- part 1: [2,3,4]   -> equal total cannot repair the wrong boundary
```

Normal immutable insertion does not produce these shapes. The controls deliberately modify the driver's private
`${prefix}:v3` database namespace to model damaged storage or an external write. Applications must reserve that
namespace for the driver. Length validation detects malformed layout; it is not a cryptographic integrity check and
cannot detect a same-length byte substitution.

Use the existing API normally. A read failure is evidence to inspect or restore the stored file, not permission to
replay a write automatically:

```ts
import { createFileSystem } from "@okikio/opfs";
import { createDenoKvAdapter } from "@okikio/opfs/adapter/deno-kv";

const db = await Deno.openKv("application.db");
const fs = createFileSystem(createDenoKvAdapter(db, { prefix: "documents", partBytes: 48 * 1024 }));
try {
  await fs.writeFile("/report.bin", new Uint8Array(100_000));
  const finalByte = await fs.readFile("/report.bin", { at: 99_999, length: 1 });
  console.log(finalByte[0]); // 0; only the overlapping physical part is read.
} finally {
  const failures: unknown[] = [];
  try {
    await fs.close();
  } catch (reason) {
    failures.push(reason);
  }
  try {
    db.close();
  } catch (reason) {
    failures.push(reason);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Filesystem and database retirement failed.");
}
```

Valid empty files retain their single empty part, and a final partial part retains its exact remaining length. Ranges
still fetch only overlapping parts. Validation adds constant arithmetic and a byte-length comparison per fetched part;
it adds no provider requests, no full-file buffering, and no background work. These are source-level costs, not a
measured performance claim.
