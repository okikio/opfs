# Use pCloud by native file and folder ID

Choose the account's region and grant signed download origins explicitly. Inject a caller-owned OAuth token; the client
does not sign in, discover accounts, or choose a data center.

```ts
import { PcloudClient } from "@okikio/opfs/pcloud";

async function previewFile(
  fileId: string,
  getToken: () => Promise<string>,
  allowedContentOrigins: readonly string[],
): Promise<Uint8Array> {
  const cloud = new PcloudClient({
    endpoint: "https://eapi.pcloud.com", // Europe; US accounts use api.pcloud.com.
    token: () => getToken(),
    downloadOrigins: allowedContentOrigins,
    maxBytes: 8 * 1024 * 1024,
  });
  return cloud.read(fileId, { at: 0, length: 4096 });
}
```

Obtain the exact content-origin grant from your deployment policy. An empty allowlist permits metadata calls but refuses
content URLs. There is no implicit pCloud wildcard grant or default approval of the API origin. The official
`getfilelink` documentation restricts browser applications; this profile targets server-side native Fetch usage. A
successful mock Fetch test does not establish browser CORS or account eligibility.

Every API operation posts `access_token` in the request body, never a URL. It also sends `logout=1` before native
authentication, resets metadata filters, and requests Unix timestamps. These parameters matter: pCloud's documented HTTP
connections retain authenticated user and filter state across requests. Requests omit ambient cookies, which could
otherwise override form parameters. The caller owns token issuance, scope, rotation, regional endpoint choice, and any
injected Fetch transport. API redirects are refused.

## IDs, names, and bounded metadata

`statFile(fileId, { revisionId? })` gets one native file. `listFolder(folderId)` returns the folder and its direct
children in one bounded response. Root folder ID is `"0"`. IDs and revision IDs are full unsigned 64-bit decimal
strings; never convert them to JavaScript numbers. The parser preserves numeric JSON lexemes before conversion,
including the provider's opaque numeric `hash` field. File sizes must still fit JavaScript safe integers for exact byte
indexing.

Listing has no invented pagination. Its default cap is 10,000 entries, with a 100,000-entry ceiling. An oversized native
directory response fails; it is not reported as an empty or complete partial listing. The client checks concrete
file/folder IDs, parent IDs, duplicates, and direct-child scope. A file and a folder may legally share a name. Names are
case sensitive and shorter than 1,024 UTF-8 bytes; NUL, slash, backslash, and malformed Unicode are refused. Names can
contain control characters and must not be rendered as trusted labels or treated as host paths.

Control bodies use the shared 8 MiB response bound. The private JSON reader caps depth at 32, tokens at 1,000,000,
lexical strings at 32,768 characters, and numeric lexemes at 128 characters. It rejects duplicate decoded keys,
prototype-related keys, and malformed numbers before schemas select authority. Numeric field schemas then reject signs,
fractions, exponents, and unsafe sizes. These are local safety policies, not pCloud format maxima. Parsing needs bounded
complete control text plus objects; it is not a streaming JSON parser.

## Read content with explicit evidence

`getFileLink` returns an expiring secret URL and exact decimal Unix expiry seconds. Do not log it or persist it as a
replay identity. The client validates its host and path before use and does not silently normalize dot segments.

`download(fileId, options)` performs metadata/link requests and returns
`{ file, length, bytes, evidence: "server-trusted" }`. Consume or cancel `bytes`. Content requests and up to three
manually admitted redirects omit OAuth, cookies, and referrer context, including hops back to the API origin. Only exact
explicitly allowed origins can receive a content request. `allowHttp` exists for private fixtures; it permits only
separately granted HTTP origins and does not replace HTTPS with an implicit downgrade.

Range reads require HTTP 206, matching finite `Content-Range`, identity encoding, and the described file size. Full
reads require HTTP 200. The stream also checks actual EOF and byte count, refusing truncation, overrun, and excessive
empty chunks. `read()` buffers within the configured 8 MiB default / 64 MiB hard ceiling; a larger selected extent is
cancelled before materialization. Zero-length `read()` is local and provides no existence evidence. Use `read()` rather
than `download()` for an empty request.

Metadata and content requests are separate. A same-size concurrent overwrite can still pass extent checks. `revisionId`
selects native revision context but this client does not publish a provider-verified immutable `ByteSource` or claim
that an expiring URL is a revision proof. The numeric metadata hash is opaque. `checksumFile` returns server-computed
SHA-1 and optional regional MD5/SHA-256: MD5 is documented for US servers and SHA-256 for Europe. Those results are
service evidence, not publisher authentication or automatic verification of a separate download.

## Mutations and recovery

`upload(folderId, name, bytes, { conflict })` accepts one materialized file. Choose `conflict: "overwrite"` or
`"rename"` explicitly. Overwrite uses pCloud's native name replacement and revision behavior; rename can return a
different actual name. Neither is compare-and-swap or create-if-absent. Bytes and operation settings are captured before
awaiting the token. The multipart request places parameters before the file and sets `nopartial=1`. The upload receipt
must contain exactly one matching file ID and metadata with the requested parent, full byte size, and applicable name.
HTTP 200 or `result:0` alone does not prove publication. This validates a provider receipt, not a downloaded
byte-for-byte content hash.

`createFolder(parentId, name)` validates the returned folder/parent/name. `deleteFile(fileId)` requires that same file's
`isdeleted` receipt; it deletes the current file, not just a revision, and does not claim permanent trash removal.
Folder deletion and canonical filesystem projection are outside this profile.

Mutations are never automatically retried. Once transport dispatch occurs, a failed request, missing/malformed receipt,
service error, or undelivered receipt produces `PcloudPublicationError` with `outcome: "unknown"`. This conservative
classification does not claim every rejected operation had effects. Reconcile native IDs and destination contents before
deciding whether another mutation is safe. In particular, `nopartial=1` cannot settle whether a completed upload was
published before its acknowledgment was lost; conflict rename can publish a second file if repeated. Failures before
dispatch retain their original cause. `PcloudError` exposes HTTP status and optional native numeric result, without
copying raw provider error text or capability URLs into library messages. Library URL/JSON parser errors also omit
signed-path context. Arbitrary errors from injected Fetch/token capabilities are preserved and may themselves contain
secrets, including inside a `PcloudPublicationError` cause; callers must redact such foreign errors before logging them.

Signals propagate through requests and returned stream ownership. Cancelling a stream retires its reader; rejected
bodies are consumed or cancelled while preserving primary failures. Injected transport/token capabilities own their own
cancellation contracts and any errors they emit.

No resumable-session or `UploadDestination` contract is advertised. The published `uploadprogress` method observes an
ongoing request and includes multipart protocol overhead; it does not establish a durable committed-byte cursor.
Undocumented `upload_create`/`upload_write`/`upload_save`, binary protocol, `file_*` primitives, auth discovery,
recursive traversal, and SDK integration are deferred.

## Protocol evidence

Tests are authored protocol fixtures derived from the official documentation. They cover uint64 wire numbers,
duplicate/hostile JSON, connection reset settings, range/EOF checks, content credential isolation, mutation receipt
mismatches, conflict rename, and byte/target snapshots across token acquisition. They do not contact pCloud or prove
live account eligibility, deployed limits, CORS, or an independent server implementation.

Primary HTML was fetched on 2026-11-05. The site is mutable; these SHA-256 values identify the reviewed source bytes,
not a provider release or immutable source commit:

| Official source                                                                                       | SHA-256                                                            |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [/](https://docs.pcloud.com/)                                                                         | `e2c1226cf375007abb81b4507e8347cde36c18447fd51e7364b3f509f9071059` |
| [/protocols/http_json_protocol/](https://docs.pcloud.com/protocols/http_json_protocol/)               | `f3126170e532857f780ca861dee08090dab6e73414555982f3e16a511ad63c40` |
| [/methods/intro/global_parameters.html](https://docs.pcloud.com/methods/intro/global_parameters.html) | `2e16f20b19d37325d3076e86e366fb651a82cf59cd08d1b89fba7ac8c76e1d65` |
| [/structures/metadata.html](https://docs.pcloud.com/structures/metadata.html)                         | `6fd608a4ec293095b725f72c67215692d0cd576895877656da860af965419357` |
| [/structures/filenames.html](https://docs.pcloud.com/structures/filenames.html)                       | `02f45d72bfce77512e96c057142ebb0f63c77d09738e9c9b204015e3851e86ba` |
| [/methods/file/stat.html](https://docs.pcloud.com/methods/file/stat.html)                             | `2c438d0e0e21689a654415f6553d527d87206fc7e8fcec38829f7d7af07861fe` |
| [/methods/folder/listfolder.html](https://docs.pcloud.com/methods/folder/listfolder.html)             | `deb5e0d9e785b6449d1b026647b58865c0e5b3c15881174334f161013906a21e` |
| [/methods/streaming/getfilelink.html](https://docs.pcloud.com/methods/streaming/getfilelink.html)     | `d413368f6e254955c6468b52ed22f51fb63aba2af75cef1813bf214d286cf82d` |
| [/methods/file/uploadfile.html](https://docs.pcloud.com/methods/file/uploadfile.html)                 | `dec171caea130f30af259a504a8f1a144f33a8add45d81b18c0d3cd995bc0c70` |
| [/methods/file/checksumfile.html](https://docs.pcloud.com/methods/file/checksumfile.html)             | `2d610fa0717f9b94ecd8ac707b5b707eb098835e308903e1693117fadfd3d2dc` |
| [/methods/file/deletefile.html](https://docs.pcloud.com/methods/file/deletefile.html)                 | `62b23c6d500e14f2a9e8451651f5ee7fb53bd06e1353c3ae67f4466478eca65e` |
| [/methods/folder/createfolder.html](https://docs.pcloud.com/methods/folder/createfolder.html)         | `4967ed8eec271072431b980be04ae88d576ed91773d54d05771de331818afabc` |
