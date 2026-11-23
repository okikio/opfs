# Supabase Storage native REST files

Read a private file through an explicitly configured Storage API:

```ts
import { SupabaseClient } from "@okikio/opfs/supabase";

export async function readPrivateNote(
  endpoint: string,
  accessToken: string,
  apiKey: string,
  key: string,
): Promise<Uint8Array> {
  const files = new SupabaseClient({
    endpoint,
    bucket: "notes",
    credentials: () => ({ accessToken, apiKey }),
    maxBytes: 8 * 1024 * 1024,
  });
  return await files.read(key, { access: "authenticated" });
}
```

Supply the Storage API root, such as `https://project.example/storage/v1/`, not a PostgREST or GoTrue URL. A standalone
Storage server can use a root such as `https://storage.example/`. The final slash is required. The application owns the
JWT, any gateway API key, authentication, refresh, account continuity and cancellation. Importing this module does not
read credentials, connect, install an SDK or configure a Supabase project.

This native client targets files buckets. It is separate from the existing catalog target's S3 route and does not count
as another storage provider. It does not imply S3 parity, a filesystem, directory mutation, bucket administration,
analytics/vector buckets, image transformation, resumable transfer or an Auth client. Existing tus support is a separate
protocol, not an inferred destination capability of this REST profile.

## API and media authority

Configure one explicit `bucket`, `endpoint` and optional `credentials(url, signal)` callback. It returns
`{ accessToken,
apiKey }`; either field can be absent. Supply the JWT without a `Bearer` prefix: the client adds that
prefix only to the Authorization header. The separate `apikey` header is gateway context, not a discovered login or a
claim of a particular role. Tokens admit nonempty whitespace-free printable ASCII up to 8,192 characters. No
service-role credential is discovered or acquired implicitly. The callback receives a copied URL after pre-abort
admission.

The application and server own JWT acceptance and Row Level Security. Choosing an authenticated route causes an API
credential request; it does not prove which principal the server accepted or override a bucket's native public behavior.
HTTP error status can hide data that exists. A denied response or omitted list/delete result is not authoritative
absence. `SupabaseError.status` exposes the HTTP status, not a synthesized interpretation of a diagnostic body.

`download(key, { access: "public" })` selects the native public route and never acquires or forwards API credentials.
`access: "authenticated"` selects the authenticated route with captured API credentials. There is no automatic fallback
between them. Every HTTP request omits ambient cookies/referrer and refuses redirects. HTTPS is required unless
`allowHttp: true` explicitly admits a local test server. URLs cannot contain userinfo/fragments or path aliases.

Signed access has a separate authority boundary. `createSignedUrl(key, { expiresIn, signal })` requests a secret
capability using API credentials. Expiry is explicit positive seconds, bounded by this profile to 86,400. It is native
authorization evidence, not proof of content identity, publisher authenticity, future availability or retention. The
client does not refresh or silently reacquire an expired capability.

Native signed receipts use `/object/sign/...` relative to the Storage API root. The client appends that route to the API
root rather than dropping a project's `/storage/v1/` prefix. It verifies the exact expected bucket/key route and one
`token` query field. Absolute or aliased native receipt routes are outside the initial profile.

To consume the returned URL, separately configure `signedOrigins: ["https://project.example"]`, then call
`readSigned(key, signedUrl)` or `downloadSigned(key, signedUrl)`. Grants are exact origins, including scheme and port;
at most 64 grants are admitted. The API's own origin receives no automatic grant. Each signed target must match the
expected configured signing path, bucket and key, with exactly one token and no foreign query fields. No API JWT,
gateway key or credential callback is used on a signed hop, even when its target is the API origin. Redirects remain
refused. Grants do not authenticate the capability or make a future response trustworthy.

Signed URLs, tokens and persisted capability results are secrets. Own URL/JSON/status errors omit secret inputs; native
server diagnostic bodies are not echoed. Foreign injected Fetch/credential errors retain their primary error/cause and
can contain secrets. The application must redact them before logging.

## Keys, metadata and native list pages

An object key is a native bucket-relative identifier such as `folder/note.txt`. The client encodes its segments once
without filesystem normalization. The initial URL-safe profile refuses empty segments, normalizing `.`/`..`, slash or
backslash inside a segment, control characters and malformed UTF-16. A segment admits at most 1,024 characters and a
complete key at most 8,192. These are implementation admission limits, not a claim of the provider's configured limits.
Bucket names use one admitted segment. A file called `folder` and keys below `folder/` can have distinct native meaning;
no directory-ownership or atomic tree operation follows from that naming.

`info(key, signal)` requires the returned bucket/key to match and returns safe-integer `size`, native `id`, optional
internal `version`, ETag/media type and inert user metadata. These values are server evidence. An internal version
string or randomized ID is not a content hash, CAS condition or immutable remote `ByteSourceType`. No version selector
or retention guarantee is exposed in this initial client. The inspected server has deployment-gated versioning
migrations; the historical catalog's S3 compatibility notes do not define all current native API behavior.

`listPage(prefix, { offset, limit, signal })` fetches one native list-v1 page sorted by name. Prefix `""` selects the
bucket root. A nonempty prefix can end with one `/`; its admitted spelling is sent as native prefix data. `offset`
defaults to zero and is bounded to 1,000,000. `limit` defaults to 100 and admits 1–500. Results distinguish
`{ kind: "prefix", name }` placeholders from `{ kind: "object", name, id, metadata? }`. A null native ID is not turned
into a zero-byte file. Duplicate/ambiguous names and inconsistent prefix metadata fail instead of being merged.

Offset pages are independently mutable and subject to RLS. A full page does not prove another page exists, and no
cursor, `hasMore`, complete scan or snapshot is invented. The caller decides whether to continue and owns total scan
budgets. Relative list names are not silently turned into another object's identity.

Control responses are bounded to 8 MiB by the response owner. JSON preflight refuses duplicate keys, prototype-sensitive
keys, nesting deeper than 32, more than 100,000 values, lexical strings over 65,536 characters, numeric tokens over 128
characters, nonfinite numbers and unsafe integer values. Inert metadata still uses finite JavaScript numbers; this is
not an arbitrary-precision JSON representation. The client does not render or execute metadata.

## Upload, deletion and uncertain outcomes

`upload(key, bytes, { mode, mediaType, cacheControl, signal })` copies byte input before awaiting credentials and admits
an explicit `mode: "create" | "upsert"`. Create sends native `x-upsert: false`; an existing object produces a native
conflict. Upsert explicitly grants the server its overwrite behavior. Neither mode provides revision CAS or attributes a
later read to an earlier request with a lost acknowledgement. All keys/options are captured before asynchronous
credential acquisition. Concurrently modified shared memory is not an atomic snapshot; the caller must synchronize it.

Uploads use the native raw-body POST route. Defaults are `application/octet-stream` and the complete cache header
`max-age=3600`. Custom complete media/cache headers admit at most 256 printable ASCII characters. The copied payload
defaults to an 8 MiB limit, configurable through the 64 MiB `SUPABASE_BUFFER_BYTES` implementation ceiling. Native
transport can allocate further copies, and server bucket/project limits can be stricter. Custom metadata upload,
signed-upload sessions, copy/move and streaming upload are separate future profiles.

A successful result has `state: "acknowledged"`, the matched bucket/key and optional native ID. It acknowledges native
metadata response, not an independent stored-byte digest check, immutable revision or future retention. Download and
compare complete content separately when required.

`remove(exactKeys, signal)` admits 1–100 unique explicit keys. Its native request property is called `prefixes`, but
this API sends exact object names, not a recursive prefix tree. It returns only identities actually acknowledged by the
server: `{ key, id, version? }`. Foreign or duplicate returned identities fail. RLS-hidden, missing or otherwise omitted
requested keys remain unresolved; they are not silently marked absent or deleted. An empty returned array is valid
evidence of no acknowledged removals. No all-or-nothing bulk transaction or directory deletion is inferred.

Every mutation is non-replayable. A dispatched mutation without a valid delivered acknowledgement throws
`SupabasePublicationError` with `outcome: "unknown"`, preserving its cause. This conservative result also includes error
responses; it does not assert that a rejected request caused effects. Reconcile storage explicitly before retrying.
There is no automatic retry, rollback or attribution from a later HEAD/list.

## Downloads and previews

`download()` and `downloadSigned()` return `{ bytes, size?, evidence: "server-trusted" }`. The caller owns the stream
and must consume it to actual EOF or await cancellation. A complete response requires HTTP 200; a range requires HTTP
206, finite consistent Content-Range and the requested start. The end can clamp at EOF. Ignored ranges, real content
encodings, unsafe Content-Length and actual short/excess bodies fail. No declared full-response size leaves `size`
unknown, not an invented metadata value. A zero-length selection is local and proves no remote existence.

`read()` and `readSigned()` materialize within the configured byte limit, preflighting any response extent and enforcing
the bound during collection. They do not preclude I/O merely because a requested range exceeds that bound: the provider
can clamp it at EOF. Collection retains source chunks plus assembled bytes, and native layers can allocate more copies.
Native terminal stream failures retain their identity; independent extent and cleanup failures are preserved together.

These methods do not hash content or expose a stable multi-range source. Stage and independently verify bytes under
application policy before archive preview that depends on consistent repeated ranges. No derivative, thumbnail, CDN
snapshot, retention or content-authenticity claim is made.

## Pinned authority and separate verification

The official [Storage guide](https://supabase.com/docs/guides/storage) and
[asset delivery guide](https://supabase.com/docs/guides/storage/serving/downloads) describe the route boundaries.
Inspected 2026-11-05, the exact tested native authority is server v1.89.12 commit
[`1c49b6a4cb123c5f0edf05505a846956820a5e67`](https://github.com/supabase/storage/tree/1c49b6a4cb123c5f0edf05505a846956820a5e67).
Unmodified source SHA-256 hashes:

| Source                                    | SHA-256                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `src/http/routes/object/getObject.ts`     | `3f3ab65fb722053b74a7d023599df907a23dc5bf93ae60c8666b4e3ea7fb6a82` |
| `src/http/routes/object/getSignedURL.ts`  | `d97adbe322475c3996c2642ad210b90c1baac257c4641ddefa5f5d270592e6ef` |
| `src/http/routes/object/deleteObjects.ts` | `ab5ff4b86991f52f78baabb7ddba904211bdb11df0a59bf53d513ab71e310cff` |
| `src/test/db/01-auth-schema.sql`          | `128ec1e7013202c44631e20c9ec6dd86a0a735f177458f4cb52a562c39f26c3e` |

The separate Testcontainers fixture pins official Storage image index
`sha256:8526956cb462e9f7d392e9848ec77133b2769982ed614e9753cc687e8e4339a6`, PostgreSQL15/pgvector index
`sha256:88164492558c9773a1e17a8305abaca7863e05b3d8bbcdb792774890a2047e06`, and official Node24.15.0 Alpine index
`sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f`. It uses the real server's local-file backend
and database migrations, a private network, mapped-port readiness and bounded container resources. The fixture adapts
minimal auth schema/functions; it does not execute upstream setup scripts or read host authentication state.
Fixture-only HS256 JWTs name explicit test subjects/roles. They exercise native Storage authentication and real RLS, not
GoTrue, production signing-key management or the hosted gateway.

The independent official storage-js2.12.2 oracle is pinned to commit
[`563c8313d70a8c6114e9d4f9958b4b64f3f1d95d`](https://github.com/supabase/storage-js/tree/563c8313d70a8c6114e9d4f9958b4b64f3f1d95d)
and npm archive integrity
`sha512-SiySHxi3q7gia7NBYpsYRu8gyI0NhFwSORMxbZIxJ/zAVkN6QpwDRan158CJ+UdzD4WB/rQMAGRqIJQP+7ccAQ==`. Its
`src/packages/StorageFileApi.ts` SHA-256 is `0ae88e4f6ee85e7710333701789e57610bde3f407264029416b3d6f87d052fc9`. Artifact
download is bounded to 32 MiB and verified before extraction. The SDK receives explicit native Node Fetch, so its
optional node-fetch fallback is not installed. Its fixture-only transport removes exactly the fixed `/storage/v1`
gateway prefix before the standalone server, preserving the remaining path, query and headers at the exact expected
internal origin. This models the SDK's normal project API root; that SDK version serializes a bare origin with a final
slash and otherwise produces a rejected double-slash standalone route. The candidate client performs no such rewrite. No
SDK or new dependency enters production imports.

The provider scenario creates public/private buckets with the SDK, uploads independent producer bytes, and compares
candidate full/range downloads and candidate uploads against complete SDK reads. It also exercises native create
conflict/upsert, prefix placeholders, signed/public access, a denied subject and exact-key deletion omissions. Running
it requires Docker, image/release access and existing Testcontainers tooling. Authored protocol tests separately cover
malformed authority, credentials, copied inputs, extents and failure ownership. Named-server/local-backend evidence does
not certify other versions, external S3 backends, deployment policies, hosted CDN, image transforms or versioning. No
benchmark claim is made.
