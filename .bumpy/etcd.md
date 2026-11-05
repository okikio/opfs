---
"@okikio/opfs": minor
---

Use native etcd byte keys and revision conditions without imposing a filesystem layout.

```ts
import { createEtcdClient } from "@okikio/opfs/etcd";

export async function replace(endpoint: string, token: string, name: string, bytes: Uint8Array) {
  const client = createEtcdClient({ endpoint, credentials: () => token });
  const key = new TextEncoder().encode(name);
  const current = await client.get(key);
  return current.entry === null ? await client.put(key, bytes, { create: true }) : await client.put(key, bytes, {
    modRevision: current.entry.modRevision,
    lease: "preserve",
  });
}
```

`applied:false` is a known native condition failure. The application decides whether to read again or choose another
operation; the client does not retry a mutation with a refreshed revision. Replacements explicitly preserve or detach
the current lease. Preserving a lease does not renew it, and a missing mutation receipt requires reconciliation.

Native revisions and cluster/member IDs remain exact decimal strings. Prefix cursors select one historical revision and
refuse a different cluster, but compaction can invalidate them. Values are bounded, materialized gateway bytes; there is
no watch, lease acquisition, large-file streaming, record driver or filesystem projection.

Official etcd/etcdctl fixtures compare complete binary values, conditional conflicts, lease choices and historical
pages. A single-node fixture does not qualify replicated consensus, deployment availability or durability. The
[guide](../docs/etcd.md) explains caller-owned credentials/transport, response cleanup, bounds and uncertain writes.
