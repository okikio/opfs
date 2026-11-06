---
"@okikio/opfs": minor
---

Stage lakeFS objects and commit branch state through a native client, with separate publication receipts.

```ts
import { LakefsClient } from "@okikio/opfs/lakefs";

export async function save(
  endpoint: string,
  repository: string,
  branch: string,
  authorization: string,
  bytes: Uint8Array,
) {
  const client = new LakefsClient({ endpoint, repository, credentials: () => authorization });
  await client.put(branch, "note.bin", bytes, { ifNoneMatch: "*" });
  const receipt = await client.commit(branch, "Publish staged objects");
  return await client.read(receipt.id, "note.bin");
}
```

The caller must exclusively own the existing branch and fresh object name. A commit includes **all staged branch
changes**, including other writers' work. Upload acknowledgement is not a commit; uncertain mutations retain operation
context and must be reconciled before retry. The [guide](../docs/lakefs.md) explains native refs, bounded exact ranges,
explicit credentials and commit-wide ownership. The pinned server accepts atomic create-only uploads, but contradicts
its schema by refusing If-Match; the client rejects that unsupported condition before I/O. Genuine server and official
CLI tests compare complete staged and committed bytes, including competing creates and reads after branch replacement.
The server/CLI is test-only software under its recorded BSL terms; no SDK or copied server implementation enters the
production graph. S3 gateway parity, merge, retention and general filesystem semantics are not implied.
