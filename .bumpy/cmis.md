---
"@okikio/opfs": minor
---

Read and publish native CMIS documents without inventing filesystem paths.

```ts
import { createCmisClient } from "@okikio/opfs/cmis";

export async function preview(
  repository: string,
  repositoryUrl: string,
  rootUrl: string,
  id: string,
  authorization: string,
) {
  const client = createCmisClient({
    repository,
    repositoryUrl,
    rootUrl,
    credentials: () => ({ authorization }),
    maxBytes: 8 * 1024 ** 2,
  });
  const document = await client.get(id);
  if (document.baseType !== "cmis:document") throw new TypeError("Select a document.");
  return await client.read(document.id);
}
```

The CMIS 1.1 Browser Binding preserves typed properties, exact numeric text, opaque IDs, offset pages and native change
tokens. Content reads are bounded complete current streams, without immutable-range or rendition claims. Creates and
replacements require complete receipts; changed replacement IDs need explicit matching version-series metadata.
Uncertain publication is observable and must be reconciled before retry. Native archival Apache server/SDK tests compare
all bytes and stale-token conflicts. That fixture does not install an authentication filter, so it does not qualify
native authentication enforcement. No Java runtime or SDK enters production. The [guide](../docs/cmis.md) explains
credential targets, versioning scope, costs and recovery.
