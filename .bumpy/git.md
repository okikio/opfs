---
"@okikio/opfs": minor
---

Verify bounded Git SHA-1/SHA-256 loose objects before exposing copied payload ranges or inert tree entries.

```ts
import { openGitObject } from "@okikio/opfs/content/git";
import type { ByteSourceType } from "@okikio/opfs/source";

async function previewBlob(
  source: ByteSourceType,
  oid: string,
  subtle: Pick<SubtleCrypto, "digest">,
): Promise<Uint8Array> {
  const object = await openGitObject(source, {
    algorithm: "sha256",
    oid,
    subtle,
    maxCompressedBytes: 16 * 1024 * 1024,
    maxObjectBytes: 8 * 1024 * 1024,
  });
  if (object.kind !== "blob") throw new TypeError("Expected a Git blob.");
  return object.source.read(0, Math.min(object.size, 4096));
}
```

Native zlib and whole-object hashing require finite materialization; no pack, traversal, publisher authentication or
SHA1DC equivalence is claimed. See the [Git guide](../docs/git.md) for ownership and budgets.
