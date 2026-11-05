# PocketBase record files

Read a protected original file with separate API and file authority:

```ts
import { PocketbaseClient } from "@okikio/opfs/pocketbase";

export async function readProtectedNote(
  endpoint: string,
  apiToken: string,
  recordId: string,
  serverFilename: string,
): Promise<Uint8Array> {
  const files = new PocketbaseClient({
    endpoint,
    collection: "notes",
    field: "documents",
    credentials: () => apiToken,
    maxBytes: 8 * 1024 * 1024,
  });
  const token = await files.fileToken();
  return await files.read(recordId, serverFilename, { token });
}
```

Supply an explicit endpoint such as `https://records.example/`, an application-owned authenticated PocketBase token, the
record ID and a file name returned by that server. The endpoint requires a final `/` and cannot contain a query,
fragment or userinfo. HTTPS is required; `allowHttp: true` is an explicit local-server opt-in. The client does not log
in, discover an account, read environment configuration, create a collection or acquire connections on import.

PocketBase stores files in record fields. A record ID, collection ID/name, configured field and server-generated file
name are different values. An uploaded `note.txt` can become a sanitized name with a random suffix. Use the names from
the acknowledged record rather than predicting them. This native client does not project collections into a filesystem,
add a generic record driver, or claim directory operations, byte append, transactions, CAS or resumable uploads.

## API authority and file tokens

`credentials(url, signal)` returns the native `Authorization` header value for record operations and `fileToken()`. The
application owns authentication, refresh, token scopes and account continuity. The complete header admits nonempty
printable ASCII up to 8,192 characters, including spaces. The pinned server accepts both a raw token and a
case-insensitive `Bearer` prefix; the client adds neither. Returning `undefined` makes an anonymous API request. Every
callback receives a copied URL, and an aborted operation fails before acquiring credentials. Query file tokens remain
separate whitespace-free printable ASCII values; a complete Authorization header is not a file token.

File downloads never call that callback or forward API authorization, even to the same origin. They receive only an
explicit `{ token }` query value supplied for that operation. `fileToken()` obtains a native short-lived file token but
does not cache, refresh or automatically use it. Ordinary API and file tokens are not interchangeable.

In the inspected server, protected-file access replaces request authorization context with the auth record resolved from
the file token, then applies the collection's `viewRule`. A field being protected is not alone a guarantee that every
anonymous request fails: an unrestricted view rule can still allow access. The server owns that policy. Denied downloads
can appear as HTTP 404, so that response does not distinguish hidden content from absence.

Every request uses manual redirect handling, omitted cookies and no referrer. No redirect is followed and no external
storage URL is discovered. File tokens and their URLs are secrets. Own URL/JSON/status errors omit secret values, but
foreign Fetch or credential errors retain their primary error/cause and can contain secrets. Redact foreign diagnostics
before logging. This client does not claim production access-policy correctness or secure application rendering of
downloaded content.

## Records and file-field changes

The configured `field` is a plain file-field name, not a native modifier expression. Record data remains inert and
schema-specific. `getRecord(id)` returns `id`, `collectionId`, `collectionName`, normalized `files` and native `data`.
The server collection must match the configured ID or name, the requested record ID must match and the file field must
be a string or array of at most 100 unique file names. Empty single-file fields normalize to an empty list. This does
not discover the collection's file limits, encryption or storage layout.

`listPage({ page, perPage, signal })` requests one native page, sorted by `id`. Pages start at one and are bounded to
1,000,000; page size defaults to 30 and is bounded to 500. Returned page settings must match, duplicate record IDs fail,
and counts must be nonnegative safe integers. Pages are independently mutable; totals and sorting do not provide a
snapshot. This API does not run a hidden complete scan or expose filter/expand expressions.

File changes use the native Records API:

| Method                                                      | Native effect and authority                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `createRecord(files, { data, signal })`                     | Creates a record with copied file parts; requires the collection's create permission.                       |
| `uploadFiles(id, files, { mode: "replace", data, signal })` | Replaces the configured file-field contents, subject to update permission and the server's schema.          |
| `uploadFiles(id, files, { mode: "append", data, signal })`  | Adds file-field entries using the `field+` modifier. This is not byte append or a client read-modify-write. |
| `deleteFiles(id, names, signal)`                            | Removes named file-field entries through `field-`; requires update permission.                              |
| `deleteRecord(id, signal)`                                  | Deletes the whole native record and its associated files; requires separate delete permission.              |

The client never falls back from file-field deletion to deleting the record. A deployment can grant update permission
while denying record deletion; the genuine server test exercises that distinction. Empty upload replacement is refused:
use `deleteFiles()` with explicit server names. Empty create parts remain useful when the collection permits an empty
file field. The server can reject additions, mutate records through hooks or apply stricter configured limits.

Each upload admits at most 100 parts with an aggregate copied payload limit of 8 MiB by default, configurable through
the 64 MiB `POCKETBASE_BUFFER_BYTES` implementation ceiling. Individual names are bounded to 1,024 characters and media
types to 256 printable ASCII characters. Parts become private copied Blob bytes before credential awaits; targets, mode
and scalar data are captured too. Concurrently modified shared memory is not an atomic snapshot; the caller must
synchronize it. Blob/FormData/native transport can allocate further copies and multipart framing.

Optional `data` admits at most 64 small scalar fields, 8,192 characters per value and 65,536 total key/value characters.
File-field modifiers, server identity and timestamp fields cannot be smuggled through this map. It is not an arbitrary
collection administration or nested-record API. Scalars become native multipart strings; `null` becomes an empty field.
The collection's schema decides how to validate or clear that value. Numeric values use finite JavaScript numbers;
arbitrary-precision decimal JSON is outside this profile. Malformed UTF-16 strings are refused before FormData can
replace lone surrogates. Native response bodies are independently bounded to 8 MiB; duplicate JSON keys,
prototype-sensitive keys, nesting deeper than 32, more than 100,000 values, lexical strings over 65,536 characters,
numeric tokens over 128 characters and nonfinite/imprecise integer values are refused before use.

Successful mutation receipts establish native record metadata acknowledgement. They do not prove that a future download
contains the submitted bytes, survives retention policy, or belongs to an immutable version. Independently read and
compare complete content when the application requires that proof. A dispatched record mutation without a valid
delivered acknowledgement throws `PocketbasePublicationError` with `outcome: "unknown"`. This includes rejected or
malformed responses conservatively; it does not assert that a failed response caused effects. Reconcile the record
explicitly before retrying. No mutation is automatically retried, rolled back or attributed to a later read.

## Original downloads and previews

`download(recordId, serverFilename, { token, at, length, signal })` returns
`{ bytes, size?, evidence: "server-trusted" }`. The caller owns the stream and must consume to EOF or await
cancellation. Native file URLs do not contain the configured field: the server checks which file field owns the explicit
requested name. The client does not first search records or acquire broader credentials. Paths are literal single
components encoded once; slash, backslash, NUL, control characters, ill-formed Unicode and normalizing `.`/`..` names
are refused.

A complete read requires HTTP 200, a selected range requires HTTP 206 and a consistent finite Content-Range. A requested
end can clamp at EOF, but the start must match. Real content encodings, unsafe lengths, ignored ranges and actual short
or excess bodies fail. An absent full-response length leaves `size` unknown until the caller consumes the stream; it
does not invent a metadata size. A zero-length selection is local and gives no remote existence evidence.

`read()` materializes at most the configured byte budget, preflighting any declared extent and enforcing the bound while
reading. It does not compute a content digest. Native terminal stream errors retain their identity; independently
detected extent failures cancel the underlying stream and preserve distinct cleanup failures.

This initial profile requests originals only. PocketBase thumbnail options can return the original when a size or format
is unsupported, so a requested rendition is not proof that a transformed image was returned. No thumbnail or derivative
identity is implied here. No immutable `ByteSourceType` is exposed from timestamps, randomized filenames or mutable
record fields. Stage and independently verify bytes under application policy before stable multi-range archive preview.

## Primary authority and verification

The official [file handling](https://pocketbase.io/docs/files-handling/),
[Records API](https://pocketbase.io/docs/api-records/) and [Files API](https://pocketbase.io/docs/api-files/) describe
the native model. Retrieved 2026-11-05, those pages displayed v0.41.1, but that tag did not resolve in the actual
upstream repository. The tested source authority is official v0.40.6 commit
[`9d281ccaba65f2686eb7b0b614ccda72d1116a1b`](https://github.com/pocketbase/pocketbase/tree/9d281ccaba65f2686eb7b0b614ccda72d1116a1b).
Exact inspected source SHA-256 values:

| Source                | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `apis/file.go`        | `c8ca827af390f8a792e7bc53fd1c35d88d8aee5f6f3ec9b5115f031c138ff9c7` |
| `apis/record_crud.go` | `a277f2ea8ab41cc40b5f5aa29ba72935115bb25a1dcad71398f4aff484428ce2` |
| `apis/middlewares.go` | `a0ba83a4d6c992dd0b32effa2c6efb9fd7889406a467aeacc3cdfe4f1174e699` |

The separate Testcontainers fixture runs that native server, with official release ZIP bytes hash-checked before
extraction: Linux amd64 `0e1f609158ed945f809f8a02ae012aa0427129c66ebb63c1aee76f2c0309373f`, Linux arm64
`d22c66ceb67ca92b7d767f36d826e848a276bcfa3c197ead20bf87c42208984f`. Its official Node24.15.0 Alpine base is pinned to
multiarch index `sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f`. Test artifact downloads have
a separate 32 MiB bound. No floating installer or global CLI is needed.

Official JavaScript SDK0.28.1 is test-only, pinned to commit
[`ff30f71041aeb8107001bb1ac82ad56a4fbeb93c`](https://github.com/pocketbase/js-sdk/tree/ff30f71041aeb8107001bb1ac82ad56a4fbeb93c)
and npm archive integrity
`sha512-/3ihkq+rvfcs0MQgrK4sEElOg6gfenHW9S/O+3BSO+V1yT+4B10+9aT22uTQUPqze9ItwNtwWyY5ZmdgVCTdVA==`. Its inspected
`src/services/FileService.ts` SHA-256 is `cfdd7814090329b1d09cd0fa1c0a4452d82731f1e144a45c8b1d06ac4cadb348`. The fixture
extracts the SDK's bundled ES module without installing dependency scripts or introducing production SDK imports.

The server/SDK test owns schema creation and SDK-produced uploads, then checks candidate full/range reads and candidate
uploads against independent SDK full-byte reads. It also exercises replacement/addition/deletion, protected-file tokens
and distinct update/delete permissions. The disposable container owns SQLite, accounts, records and SDK code;
Testcontainers owns mapped-port readiness and cleanup. Running it requires Docker, image/release download access and
existing repository Testcontainers tooling. This is named-server evidence, not conformance for all versions, production
hooks, external S3 storage, retention, user applications or deployment rules. Protocol tests separately cover malicious
responses and caller-input mutation. No benchmark claim is made.
