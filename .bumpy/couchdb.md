---
"@okikio/opfs": minor
---

Read and update native CouchDB attachments under explicit document revisions.

```ts
import { createCouchdbClient } from "@okikio/opfs/couchdb";

export async function replace(
  endpoint: string,
  authorization: string,
  document: string,
  attachment: string,
  bytes: Uint8Array,
) {
  const client = createCouchdbClient({
    endpoint,
    database: "documents",
    credentials: () => ({ authorization }),
  });
  const current = await client.document(document);
  const receipt = await client.put(document, attachment, bytes, { revision: current.revision });
  if (receipt.state !== "stored") throw new Error("Storage acknowledgement is still pending.");
  return receipt.revision;
}
```

A sibling attachment update advances the same document revision and can cause a conflict. The client does not refresh
that revision or replay a mutation. Attachment MD5 ETags, document revisions and compressed/logical lengths stay
separate. Streamed downloads require exact HTTP extents and caller consumption or cancellation. Missing mutation
receipts retain reconciliation context; native conflicts retain their identity even when response cleanup also fails.

Official CouchDB and Nano SDK fixtures compare complete bytes, literal Unicode IDs, ranges, authentication, conflicts
and attachment removal. This does not qualify replication, historical retention or physical erasure. No SDK enters
production. The [guide](../docs/couchdb.md) explains document ownership, bounds and recovery.
