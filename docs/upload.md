# Resume a known-length HTTP upload

`@okikio/opfs/upload` implements a deliberately explicit client for
[draft-ietf-httpbis-resumable-upload-15](https://www.ietf.org/archive/id/draft-ietf-httpbis-resumable-upload-15.html),
using interoperability version 10. This is an Internet-Draft, not a final RFC. It is separate from tus 1.0. The client
sends empty creation, bounded incomplete chunks, and an explicit empty completing request. It does not observe interim
104 responses or automatically upgrade an ordinary Fetch request.

The caller supplies the exact target and owns authentication, unchanged source bytes, exclusive upload ownership, and
atomic checkpoint persistence:

```ts
import { createUploadClient, UploadSessionSchema } from "@okikio/opfs/upload";

export async function send(
  fetch: typeof globalThis.fetch,
  bytes: Uint8Array,
  save: (value: string) => Promise<void>,
) {
  const client = createUploadClient({
    profile: "draft-15",
    target: "https://uploads.example/documents/report",
    fetch,
    headers: () => ({ Authorization: "Bearer caller-owned-token" }),
  });
  const created = await client.create({ method: "POST", size: bytes.byteLength });
  if (created.kind === "terminal") return created.receipt;

  // Persist before sending payload. Include a real source identity in your application checkpoint.
  let checkpoint = {
    session: created.session,
    sourceIdentity: "caller-verified-immutable-report-v1",
    acknowledgedOffset: 0,
  };
  await save(JSON.stringify(checkpoint));
  const upload = client.open(UploadSessionSchema.parse(checkpoint.session), {
    acknowledgedOffset: checkpoint.acknowledgedOffset,
  });
  let { offset } = await upload.status();
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + 1024 * 1024, bytes.byteLength);
    const result = await upload.append(offset, bytes.subarray(offset, end));
    if (result.kind === "terminal") return result.receipt;
    offset = result.offset;
    checkpoint = { ...checkpoint, acknowledgedOffset: offset };
    await save(JSON.stringify(checkpoint));
  }
  return await upload.finish();
}
```

Replace the example's token and source identity with application-owned values; the library does not discover credentials
or verify that an identity string matches bytes. On restart, read your durable checkpoint, verify the same source,
construct the client with the same target, and call `open()` then `status()`. A server offset ahead of the saved
acknowledgement can reconcile an append whose reply or local checkpoint was lost. This relies on exclusive ownership of
the same unchanged upload session. The local operation lock does not fence another process. A decreasing acknowledged
offset is refused.

`UploadSessionSchema` persists schema version 1, draft 15, interop 10, target, resource URL, initial method, known size,
optional media type and server advice. It contains no source digest, credentials, fencing token or publication receipt.
The resource URL may itself carry bearer authority. Store it securely and do not log it. Only the configured target
origin is allowed by default. An explicit `allowUploadURL` callback can admit another resource origin; admission occurs
before authentication. Saved targets must exactly match the constructed client. Redirects are not followed. Credentials
default to `omit`.

## Acknowledgements and terminal responses

An incomplete 2xx append acknowledges the entire request. Its explicit offset, when supplied, must equal the inferred
next offset. An append error or transport failure makes the wrapper require `status()` before further writes. No request
is retried automatically. Losing the creation response can lose the resource URL; issuing another creation could
duplicate a remote attempt.

HEAD must provide an offset. Its length and completeness fields may be absent; the result preserves that absence.
Reaching the declared length is not terminal completion. `finish()` requires reconciled acknowledged EOF and sends an
empty PATCH with `Upload-Complete: ?1`. Server minimum-append advice does not prevent that completing request.

A terminal receipt means the target application answered. It can carry 202, a redirect, or an application error such
as 422. It is **not proof of successful storage publication**. The caller must interpret the target's own status and
receipt contract. An application may answer before all source bytes are sent. If terminal receipt-body reading or
cleanup fails, `UploadError.terminal` remains true and `cause` retains the failure. If the final response is lost and
the server removes the upload resource, publication can remain unknown. The draft does not require replay of the final
target response. This is why this entrypoint does not implement the generic transfer destination interface.

`cancel()` acknowledges a successful DELETE request. It does not prove payload bytes were erased or an already published
target was removed. The caller owns remote cleanup policy. One operation is allowed per opened wrapper. Constructor,
opening and operation abort signals all retain authority; a fresh child signal cannot override an aborted parent.

## Finite admission and resource ownership

Known sizes and offsets use nonnegative RFC9651 integers, capped at999999999999999. The structured-field parser
distinguishes integers, decimals and dates; validates unknown parameters and dictionary values before ignoring them; and
follows RFC9651's final-duplicate dictionary rule. Each field is bounded to 8 KiB and 64 total members, items and
parameters. This is a local implementation profile, not a universal structured-fields library.

Local chunk policy defaults to 8 MiB, hard 64 MiB. Target receipt buffering defaults to 64 KiB, hard 1 MiB. Response
read results, including empty chunks and the terminal read, default to 4096, hard 65536. Lifetime request allowance
defaults to 4096, hard 1,000,000; attempts consume it even when authentication or transport fails. Limits can be lowered
at client construction. The caller must choose finite allowances appropriate for its number of chunks.

Headers are Fetch-normalized and bounded to 8 KiB/128 fields. Encoded response bodies are refused. The owned response
reader is cancelled when still active and released on every path; an already rejecting reader is not cancelled again.
Upload input extents are read using native typed-array slots and copied before asynchronous authentication. Response
chunks are copied before another reader pull. Peak memory includes the copied request body, buffered receipt chunks and
the final concatenated receipt. Native Fetch may allocate internally before the library sees a chunk; these checks do
not bound those opaque allocations.

`Upload-Limit` is dynamic server advice, separate from local policy and format limits. `options()` explicitly discovers
it; absent or empty advice is not an affirmative support advertisement. Valid unknown advice members remain inert.
`max-age` is remaining server advice in seconds, not an invented absolute expiry. This profile does not support deferred
length, automatic retries, parallel appends, arbitrary streaming request bodies or source-identity verification.

## Evidence and compatibility

Authored tests cover the wire state machine, structured fields and ownership failures. A pinned independent interop 10
FS-server baseline passed canonical HTTP requests, a server-process kill/restart with a lagging persisted checkpoint,
and full comparison of 131,089 published bytes. The baseline client process survived. A separate Testcontainers fixture
passed actual production-client kills after append and final replies, fresh-process checkpoint recovery, full-byte
publication comparisons, optional final replay, and publication-unknown behavior when the native upload record was
unavailable. 159 unchanged primary HTTP Working Group item/dictionary vectors run under their original names with
retained license and byte hashes. The adapter verifies bare values and grammar, while parameter retention and list
parsing are outside this internal profile.

The pinned native server advertises drafts 13/14 with interop 10 and parses only bare structured items. Its native 400
response to valid unknown parameters is retained; it is not called full draft 15 conformance. Native completion replay
returned 200, which is observed behavior rather than a standard requirement. No hosted endpoint, power-loss durability,
complete draft conformance, or generic application publication contract is claimed. See the
[fixture provenance](../tests/fixtures/upload/README.md) for exact pins and proof boundaries.
