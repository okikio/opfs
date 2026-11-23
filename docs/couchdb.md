# CouchDB attachments

Use the native client when an application owns a CouchDB database and document IDs. An attachment belongs to a
**document revision**: updating any attachment changes that document's revision, so a sibling attachment change can make
an earlier write condition stale.

```ts
import { createCouchdbClient } from "@okikio/opfs/couchdb";
import type { CouchdbReceiptType } from "@okikio/opfs/couchdb";

export async function replaceAttachment(
  endpoint: string,
  authorization: string,
  documentId: string,
  attachmentName: string,
  replacement: Uint8Array,
): Promise<CouchdbReceiptType> {
  const client = createCouchdbClient({
    endpoint, // Explicit HTTPS API base ending in /, optionally with a gateway prefix.
    database: "documents",
    credentials: () => ({ authorization }),
  });
  const current = await client.document(documentId);
  const receipt = await client.put(documentId, attachmentName, replacement, {
    revision: current.revision,
    mediaType: "application/octet-stream",
  });
  return receipt; // Caller checks stored versus accepted before assuming disk storage.
}
```

The result preserves both the new revision and its acknowledgement state. This example deliberately leaves a concurrent
update visible as `CouchdbError` with status 409. The application decides whether to merge its changes after inspecting
the new document; the library does not refresh a revision and blindly repeat a write. This client does not provide a
record driver or filesystem adapter: application fields, path layouts, directories, permissions and conflict resolution
remain application-owned.

## Identity and reads

The client has one caller-configured API base and database. Each operation names an ordinary document ID and attachment
name. IDs are literal strings, including slash, percent, query-looking characters and Unicode; each is encoded once as
one URL component. The selected profile excludes `_design`/`_local` document namespaces, leading-underscore attachment
names, exact `.`/`..` IDs, control characters and malformed UTF-16. Database names use the bounded ordinary ASCII subset
`[a-z][a-z0-9_$()+-]*`.

`document(id, { revision? })` returns only the native document ID, `_rev` and attachment stubs. Other application fields
are parsed within the control-body budget but are not returned or rewritten. The returned metadata objects and arrays
are frozen. Selected size/count fields require exact safe integer JSON spellings before conversion; a rounded fractional
size is refused. Duplicate and prototype-changing object keys are refused. The control parser permits at most 8 MiB
text, 100000 tokens, depth 32 and 512 KiB string tokens. `maxAttachments` defaults to 1000 and is capped at 10000.

These native values have different meanings:

| Value                           | Meaning                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Document `_rev`                 | Whole-document MVCC revision, shared by all attachments. Used in explicit `rev` query conditions/selectors. |
| Attachment `digest`             | Server-supplied `md5-` plus base64 digest in a stub. It is not the document revision.                       |
| Attachment GET/HEAD `etag`      | Quoted base64 MD5 digest of attachment content, not a document revision or publisher authentication.        |
| Stub `length`                   | Logical attachment byte length.                                                                             |
| Stub `encoding`/`encodedLength` | Native stored encoding and encoded length, kept separate from logical length.                               |
| `stat().size`                   | HEAD representation Content-Length. If HEAD reports encoding, this may be compressed size.                  |

`stat(id, name, { revision? })` makes HEAD explicit. `get()` returns a stream plus its declared size and server ETag;
`read()` consumes that stream into bounded memory. Both accept an optional `revision` and single `{ at, length }` range.
The native `rev` selects retained revision history; compaction can remove that history. No durable replay identity or
immutable `ByteSource` is inferred from a revision URL. Without `revision`, a read selects the server's current
revision.

GET asks for identity encoding and refuses unexpected encoded responses. A nonempty range must return 206 with an exact
Content-Range; EOF may clamp the requested end. Complete reads require 200. Content-Length and actual stream EOF must
agree, including full reads, so a truncated or oversized response fails during consumption. Range support can depend on
stored content and server configuration; a server that ignores a requested range is refused rather than silently
returning the complete object. A zero-length request makes no network request and proves no existence or revision.

The caller must consume or cancel `get().bytes`. For a preview, cancel after the desired bytes; cancellation propagates
to the owned response reader. Keep the operation signal live until consumption ends. Fetch and credential callbacks are
borrowed, and the client never disposes them. Materialized `read()` and `put()` default to 8 MiB `maxBytes`, capped at
64 MiB; this policy is separate from CouchDB quotas. Streamed reads are not bounded by that materialization policy, but
remain bounded by the actual declared extent. No MD5 implementation or full-content digest verification is claimed.

## Writes, acknowledgements and recovery

`put(id, name, bytes, { createDocument: true })` creates the attachment only if the **whole document** does not exist.
It is not attachment-only create-if-missing in an existing document. To add or replace an attachment in an existing
document, pass `{ revision: current.revision }`. The client copies admitted bytes and captures options before awaiting
credentials. Uploads are materialized; streaming/resumable upload and append are outside this profile.

`remove(id, name, { revision })` removes that attachment under the current document revision. It retains the document
and other attachments. Old revision bodies and attachment data may remain until native compaction; deletion does not
promise physical erasure. The client exposes no whole-document/database deletion, compaction, replication or maintenance
API.

Successful native receipts contain the requested document ID and a new revision:

| Receipt state | Evidence                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| `stored`      | Native PUT 201 or DELETE 200 acknowledgement. This is not a universal cross-cluster replication guarantee. |
| `accepted`    | Native 202 acknowledgement, explicitly not yet stored on disk.                                             |

No batch-write option is requested, but an observed 202 remains distinct. `CouchdbError.status` identifies a known
native HTTP refusal, including 409 conflicts. `CouchdbPublicationError` means a mutation was dispatched but a complete
validated acknowledgement was lost/refused. It retains operation, document, attachment and original revision. Inspect
the native current document/attachment to reconcile; equal bytes alone cannot attribute which concurrent writer
published them. Do not assume an exception means no effect, or repeat a mutation blindly. Once a complete receipt is
validated, a later cancellation/cleanup failure remains its own failure rather than being relabeled as absence of
acknowledgement.

All requests disable redirects and ambient cookies. Credentials may supply only Authorization, receive a detached URL,
and never select a route or condition. Preaborted calls stop before acquiring credentials. Library-owned errors omit
server-controlled response text and URLs; an injected Fetch/credential callback can itself throw sensitive foreign
errors, whose original identity is preserved.

## Contract and independent evidence

The profile is based on official CouchDB 3.5.3 source commit
[`7a1f97558cea50d7e79604c3f0707d4adfad3708`](https://github.com/apache/couchdb/tree/7a1f97558cea50d7e79604c3f0707d4adfad3708):
[attachments](https://github.com/apache/couchdb/blob/7a1f97558cea50d7e79604c3f0707d4adfad3708/src/docs/src/api/document/attachments.rst)
and
[documents](https://github.com/apache/couchdb/blob/7a1f97558cea50d7e79604c3f0707d4adfad3708/src/docs/src/api/document/common.rst).
`tests/couchdb.test.ts` uses authored protocol responses, including lossy-number/duplicate-key rejection, exact ranges,
stream ownership, borrowed-byte mutation across authentication, explicit MVCC choices, 202 and uncertain receipts. Those
responses are not independent service proof.

The native recipe in `tests/provider/couchdb.ts` uses the official CouchDB 3.5.3 image and official Nano 11.0.8 SDK in a
separate bounded Node container. The complete native test passed: SDK-produced binary bytes match candidate full/ranged
reads, and SDK reads match candidate replacements and zero-byte creation. Native 401 invalid-credential denial,
stale-sibling 409 conflicts, existing-document creation 409 conflicts and attachment-only deletion were observed. The
first SDK seed failed because Nano appends its attachment argument without encoding. The fixture now passes
`encodeURIComponent(name)` only to Nano; the candidate continues to accept and encode literal names itself. No
production request/response is rewritten. Exact source/image/package pins and actual service constraints are recorded in
`tests/fixtures/couchdb/provenance.json`. The server is disposable and single-node; this cannot qualify replication,
quorum durability, production access policies, historical retention, compaction or every encoded/ranged representation.

## Captured-fixture benchmark

`bench/couchdb.bench.ts` compares raw Fetch plus JSON/arrayBuffer decoding with client document/read operations over the
same 214-byte native metadata envelope and 6-byte independent SDK original. Both lanes consume their actual results;
complete-byte, identity and SHA256 provenance preflights run before timing. The raw cached-URL lanes omit request
construction, lossless numeric/identity checks, metadata freezing and extent ownership. They are lower bounds, not
equivalent conformance implementations. No CouchDB process, SDK, socket, TLS or deployed provider speed is measured.
These small payloads describe fixed client overhead, not bulk throughput. One Node 26.13.0 arm64 Linux run passed all
four cases in an isolated 1 GiB/1 CPU container with no network or host mounts. Its observed microseconds per operation
were:

| Captured operation            |  Mean | Median |    p99 |
| ----------------------------- | ----: | -----: | -----: |
| Raw JSON metadata lower bound | 12.48 |   8.46 |  39.08 |
| Client document metadata      | 40.47 |  29.58 | 106.50 |
| Raw bytes lower bound         |  8.99 |   8.08 |  12.07 |
| Client complete read          | 68.32 |  37.29 | 312.83 |

These are one bounded fixture observation, with scheduler/GC variability visible in the tail; they do not establish
service latency or universal performance ratios. The complete native Mitata distributions were preserved losslessly with
SHA256 receipts, and the durable provenance records the workload and report digests.

The native capture also exercised a compressible text attachment: the server reported 7936 logical bytes and 85 encoded
gzip bytes in its stub, while identity HEAD reported 7936 bytes and no range support. The client read the complete 7936
original bytes exactly. This observed configuration does not imply that every encoded attachment supports ranges.
