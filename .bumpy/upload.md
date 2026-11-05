---
"@okikio/opfs": minor
---

Resume a known-length HTTP upload while keeping byte progress separate from application publication.

```ts
import { createUploadClient, UploadSessionSchema } from "@okikio/opfs/upload";
import type { UploadSessionType } from "@okikio/opfs/upload";

export async function resume(
  target: string,
  saved: UploadSessionType,
  acknowledgedOffset: number,
  original: Uint8Array,
  saveOffset: (offset: number) => Promise<void>,
) {
  const client = createUploadClient({ profile: "draft-15", target });
  const upload = client.open(UploadSessionSchema.parse(saved), { acknowledgedOffset });
  let { offset } = await upload.status();
  while (offset < original.length) {
    const next = await upload.append(offset, original.subarray(offset, Math.min(offset + 65536, original.length)));
    if (next.kind === "terminal") return next.receipt;
    offset = next.offset;
    await saveOffset(offset);
  }
  return await upload.finish();
}
```

Create a resource with `client.create({method:"POST",size:original.length})`, then atomically persist its descriptor and
a verified source identity before sending content. The example assumes exclusive ownership of the saved resource, the
same verified original bytes and application-owned checkpoint persistence. Inject authentication when required. Losing
creation's resource URL can leave an unknown remote attempt; do not blindly create another one.

This explicit Internet-Draft 15 profile uses interop10; it is separate from tus and is not a final RFC. HEAD reconciles
the server offset after a lost acknowledgement. Reaching the known length does not complete the upload: `finish()` sends
a separate completing request. A terminal receipt can contain an application error or 202, and a completed resource can
disappear before its final response is recovered. Neither case becomes an invented storage success or safe retry.

Pinned independent server fixtures and actual client process kills verify complete published bytes after append/final
reply loss. The server implements the exercised canonical interop10 dialect, not every draft15 extension. The
[guide](../docs/upload.md) explains structured fields, limits, credentials, cancellation and publication uncertainty.
