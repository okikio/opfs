# Stage objects and commit repository state with lakeFS

Use `LakefsClient` when your application owns a lakeFS repository and must keep branch staging separate from committed
state. Uploading an object changes a branch's uncommitted view. Calling `commit()` publishes **all staged changes** on
that branch, including changes made by other writers. Coordinate exclusive branch ownership before using this flow.

This complete function stages one new object, commits the branch, and reads the committed bytes. The caller supplies an
existing, exclusively owned branch and the complete Authorization header. Repository creation and credentials remain
outside the production client:

```ts
import { LakefsClient } from "@okikio/opfs/lakefs";

export async function save(
  endpoint: string,
  repository: string,
  branch: string,
  authorization: string,
  path: string,
  bytes: Uint8Array,
): Promise<{ commit: string; bytes: Uint8Array }> {
  const client = new LakefsClient({
    endpoint,
    repository,
    credentials: () => authorization,
  });
  await client.put(branch, path, bytes, { ifNoneMatch: "*" });
  const receipt = await client.commit(branch, "Save staged objects");
  return { commit: receipt.id, bytes: await client.read(receipt.id, path) };
}
```

A failed commit does not undo staging. Do not rerun this function blindly after an uncertain upload or commit receipt.
Keep the repository, branch, path and intended bytes in application-owned state before starting. Inspect native branch
and commit state and decide recovery under the same exclusive ownership. Another observer cannot attribute a successful
commit merely from a later matching branch head or matching object bytes.

## Native identity, reads and authentication

`endpoint` is the service base, optionally under a reverse-proxy prefix; the client appends `api/v1/`. Use HTTPS.
`allowHttp: true` is an explicit opt-in for an owned local deployment or test fixture. The client borrows Fetch and the
credential callback; constructing or importing it does not discover accounts, read environment variables, or connect.
The callback receives a detached API URL and the request signal, and returns a complete printable-ASCII Authorization
value, such as `Basic ...` or `Bearer ...`. Its result never authorizes a separate physical storage URL.

`getBranch()` reports the native branch ID and committed head. The branch may also have uncommitted changes.
`getCommit()` reads one exact native commit ID. `stat()`, `listPage()`, `download()` and `read()` accept a native ref,
which can be a mutable branch or a commit reference. Commit IDs remain opaque; this client does not verify them as
cryptographic hashes. Garbage collection, retention and out-of-band modifications to backing storage remain deployment
responsibilities. No immutable `ByteSource` or filesystem projection is inferred.

Object names are literal query values, encoded once. Ref/repository route segments are encoded separately; dot-only
route segments, malformed UTF-16, controls and oversized fields reject before credentials. This is a finite text
profile, not a representation for arbitrary binary names. Object metadata exposes path, kind, safe byte size, provider
checksum, modification time and content type when present. The checksum is native metadata, not client-verified payload
integrity or publisher authentication. Physical storage addresses and presigned URLs are not returned by this profile.

`listPage()` returns at most 1000 entries and an optional native cursor. Pass that cursor explicitly to the next call;
applications own traversal limits and cannot assume a snapshot while listing a mutable branch. Duplicate page paths,
unsafe sizes and a non-advancing continuation reject. Control responses have the existing 8 MiB response-reader safety
bound. Its JSON profile also limits nesting to 32, tokens to 100000 and lexical strings to 512 KiB. Duplicate decoded
keys and prototype keys reject. Only canonical safe-integer numeric lexemes are admitted: fractions and exponent
notation reject before conversion, including values that JavaScript could round to an integer. Unknown metadata fields
are otherwise ignored. This intentionally narrow control profile must be extended explicitly if a deployment adds
noninteger numeric metadata.

`download()` returns `{ bytes, size, evidence: "server-trusted" }`. Consume or cancel the stream. A requested range must
return the matching HTTP 206/Content-Range with finite lengths; full reads require HTTP 200. Encoded responses and
actual body truncation or excess bytes reject. Range ends may clamp to EOF. A zero-length read performs no I/O and does
not prove existence. `read()` materializes the bytes with an 8 MiB default policy, configurable through `maxBytes` up to
the implementation ceiling `LAKEFS_BUFFER_BYTES` (64 MiB). Its size admission uses response headers, so it may perform
an HTTP request before refusing materialization. Streaming downloads do not inherit this whole-object buffering limit.

The client requests `presign=false` and rejects redirects, including to the same origin. It never follows or grants
credentials to physical/presigned addresses. A deployment requiring presigned object delivery needs a separate reviewed
profile. API reads use the shared request policy; mutations are never automatically replayed. Signals cancel the active
request or byte consumption, but cancellation does not prove an uploaded object or commit is absent.

## Staging and publication receipts

`put()` copies admitted bytes before credential awaits and returns validated native **staged-object metadata**, not a
repository commit. `ifNoneMatch: "*"` uses the native atomic create-only condition. Omission selects unconditional
replacement within the branch's staged view. Content type is explicit through `mediaType`; the default is
`application/octet-stream`. Uploads share the same materialization policy and 64 MiB implementation ceiling. Streaming
uploads, multipart, client-side digest validation and native metadata edits are outside this initial profile.

**ETag replacement is refused before I/O.** The pinned OpenAPI schema advertises `If-Match`, but the pinned native
`BuildConditionFromParams` implementation returns NotImplemented for every such value. The genuine server test confirms
HTTP 501. `LakefsPutType.ifMatch` is `never`, and JavaScript callers receive a local refusal rather than an ignored
condition. Create-only support must not be read as general compare-and-swap support.

`createBranch(name, source)` returns the native plain-text reference acknowledgement. It does not force replacement or
hide the branch. `commit(branch, message)` returns the validated commit ID, parents, message, committer and time. This
profile accepts a bounded single-line commit message. It neither checks out files nor offers merge, reset, rollback,
delete, import, repository administration or backing-store management.

`LakefsError` preserves a native refusal's HTTP status. `LakefsPublicationError` preserves `outcome: "unknown"`,
operation, repository, ref, optional object path and the original cause after a dispatched mutation lacks a validated
success receipt. Malformed, misattributed, truncated or wrong-size success receipts cannot establish safe failure.
Neither successful staging nor a successful branch commit proves publisher authenticity, disk durability, or
transactional isolation from other writers. Library-owned messages omit response bodies and physical URLs;
caller-injected transport or credential errors can still contain secrets in their causes, so do not dump arbitrary error
objects into public logs.

## Independent proof and supply chain

`tests/lakefs.test.ts` covers authored protocol cases for target/byte snapshots, conditions, receipts, unsafe input,
pagination, exact extents, terminal read errors, cancellation and credential-isolated redirect refusal.
`tests/lakefs-provider.test.ts` runs the actual pinned native server through Testcontainers, using its official bundled
`lakectl` as an independent producer and complete-byte reader. It exercises upload in both directions, a byte range,
create-only refusal, the actual If-Match 501 limitation, distinct staging/commit state, complete committed reads after a
branch replacement, branch creation and authentication refusal. The fixture uses ephemeral ports, explicit disposable
credentials, bounded resources, native readiness and shared cleanup. No host account or production repository is used.

The fixture deliberately uses the server's local database and local blockstore, which upstream marks **not supported for
production**. This proves that native wire profile against that build; it does not prove S3 gateway parity, cloud
object-store behavior, high availability, cross-process failure recovery or production durability.

The server/CLI are test-only tools, not production dependencies. Version 1.88.0 contains a Business Source License 1.1
file with an additional production-use grant limited to unmodified/internal use; the file itself names Licensed Work
1.87.0. Do not infer unrestricted Apache licensing from older lakeFS releases or from this client. Consult the pinned
license for deployments. This implementation uses the public protocol and copies no upstream implementation code.

Primary evidence inspected 2026-11-05, pinned to official commit `ef369be652b8110605ba19b770fddb8a337e8d20` (v1.88.0):

| Source                                                                                                                                               | SHA-256                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [REST OpenAPI contract](https://github.com/treeverse/lakeFS/blob/ef369be652b8110605ba19b770fddb8a337e8d20/api/swagger.yml)                           | `10a3acbbb1fd5237bf2a4aa7c0f3fe5ac05b459de02ba81870c4d9ba40829894` |
| [Actual conditional upload grammar](https://github.com/treeverse/lakeFS/blob/ef369be652b8110605ba19b770fddb8a337e8d20/pkg/api/apiutil/conditions.go) | `dd843aaf3c0ac6d03826a6de48a0a27f3f7d71ee309f4fe0b623d2d21da2d872` |
| [Server/CLI image build](https://github.com/treeverse/lakeFS/blob/ef369be652b8110605ba19b770fddb8a337e8d20/Dockerfile)                               | `b406c1688f6ecfd08b79b1a4c2d91fb7c89ff960305281923d388a5ac7d3bc2b` |
| [License](https://github.com/treeverse/lakeFS/blob/ef369be652b8110605ba19b770fddb8a337e8d20/LICENSE)                                                 | `f2a08ee5c7cbe51f6cbdda08f470e05a5a355943073010dc9ade988ed6485bf5` |

The image is `treeverse/lakefs:1.88.0@sha256:237a17c6b2d85ba71912aaf82ac61f17dcb4c1884301ff4638bd3d55fa4cb4d0` with
verified AMD64 and ARM64 manifests. An image pin and native interoperability test are supply-chain evidence, not an
independent security audit or a certification of lakeFS.
