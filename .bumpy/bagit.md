---
"@okikio/opfs": minor
---

Inspect preservation inventories and verify selected BagIt files

BagIt 1.0 inspection now compares an explicit caller-owned inventory with manifests and supplies bounded selected-file
SHA256/SHA512 verification. Coverage, fixity and author authentication remain distinct; no filesystem discovery or fetch
URL execution occurs.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { openBagit } from "@okikio/opfs/archive/bagit";

export async function inspectBag(
  files: readonly { path: string; blob: Blob }[],
  subtle: Pick<SubtleCrypto, "digest">,
) {
  const bag = await openBagit([
    { kind: "directory", path: "data" },
    ...files.map(({ path, blob }) => ({ kind: "file" as const, path, source: createBlobSource(blob) })),
  ]);
  const manifest = bag.manifests.find((entry) => entry.algorithm === "sha512" && entry.kind === "payload");
  const row = manifest?.rows[0];
  const selected = manifest && row
    ? await bag.verify(manifest.id, row.path, { subtle, maxVerifyBytes: 1024 * 1024 })
    : undefined;
  return { coverage: bag.coverage, info: bag.info, selected };
}
```

See [the capability guide](../docs/bagit.md) for work limits, resource ownership, evidence and unsupported profiles.
