---
"@okikio/opfs": minor
---

Object uploads and copies now return their own publication receipts. Previously a successful request was followed by
`HEAD`; a concurrent writer could replace the object before that read and make the receipt describe another operation.
`size` now comes from observed input or the pinned source, while ETag, version, and request identity come from the
publication response. Use `head()` separately to read current state.

```ts
import { AzureCommitError, createAzureClient } from "@okikio/opfs/azure";

const blobs = createAzureClient({
  endpoint: "https://example.blob.core.windows.net",
  container: "reports",
  credential: { kind: "sas", token: "APPLICATION_SCOPED_SAS" },
});

try {
  const receipt = await blobs.put("today.txt", new TextEncoder().encode("ready\n"), {
    mediaType: "text/plain",
    ifNoneMatch: "*",
  });
  console.log(receipt.size, receipt.etag, receipt.requestId);
} catch (error) {
  if (!(error instanceof AzureCommitError)) throw error;
  console.log(error.effect, await blobs.head(error.key));
}
```

Publication receives one transport attempt. A lost acknowledgement can follow a committed write, so the client raises
`AzureCommitError` or `S3CommitError` with `effect: "unknown"` and the original cause. It neither blindly replays the
publication nor aborts an uncertain S3 multipart completion. A later HEAD helps reconciliation but cannot prove which
writer published it. Ordinary validation and authorization failures keep their original errors. S3 multipart/copy
success requires a complete correctly shaped XML acknowledgement; `completeUpload()` returns its own `S3CommitType`
identity instead of `void`.

Azure block uploads and ranged copies now use a private 128-bit random attempt token plus a two-byte part number. Part
retries retain the same identity. Concurrent attempts can fail when Azure discards a peer's staged blocks, but a
successful commit cannot silently splice the peer's bytes. Source conditions are checked at HEAD and all copied ranges
are pinned to the resulting ETag. An intervening source replacement fails rather than producing a mixed revision.

**Azure migration:** the new decoded block-ID length is 18 bytes; the old length was 10. Stop old writers and finish or
drain their staged uploads before upgrading against the same blob names. Azure requires equal lengths while old
uncommitted blocks remain. Use a fresh object namespace when draining is impractical. The client never deletes a visible
blob to clear staged work. This explicit compatibility boundary is why the change carries a minor bump.

Empty streams must satisfy their declared size before any publication. Provider lists preserve exact whitespace, decode
only the service's declared name encoding, and leave continuation tokens opaque. Fetch-normalized `.`/`..` object-key
segments reject before dispatch. Physical preflight now distinguishes single-request bytes, multipart streams, Azure
REST version limits, and disabled block upload. The focused runtime suite covers these behaviors with controlled overlap
and response-loss models; these cases do not establish full live-cloud conformance or a performance claim.

### Keep applied properties stable while an operation runs

A publication owns its options before asynchronous source or credential work starts. Nested metadata and source Date
conditions are copied; the signal stays borrowed so cancellation remains live. Request headers and returned receipts use
the same Fetch-normalized properties, including configured metadata defaults. For example,
`{ metadata: { OWNER: " before " } }` sends and acknowledges `owner: "before"`. Mutating the options object while
awaiting `put()` cannot change the receipt into a description of properties that were never published.

S3 success XML must contain exactly one direct, nonempty scalar `ETag` in its expected result element. Nested and
contradictory fields produce an unknown outcome rather than fabricating an acknowledged revision. The pure admission
route and direct `copy()` also reject configured `copy: false` before source I/O.

A server/proxy HTTP 5xx response to publication also has an unknown outcome: a gateway can fail after the upstream
commit. The original structured provider error remains the cause, including status and request identity. Ordinary
provider rejection responses retain their provider error. Reconciliation precedes any application retry.
