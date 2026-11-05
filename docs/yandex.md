# Use Yandex Disk's native REST API

Supply a caller-owned OAuth token and explicitly grant the content origins your application trusts. Yandex Disk is
separate from Yandex Cloud Object Storage. This client addresses mutable `disk:/` paths; it does not discover
credentials, claim immutable file IDs, or project the service into canonical filesystem primitives.

```ts
import { YandexClient } from "@okikio/opfs/yandex";

async function readSmallFile(
  path: string,
  getToken: () => Promise<string>,
  contentOrigins: readonly string[],
  oauthDownloadOrigins: readonly string[],
): Promise<Uint8Array> {
  const disk = new YandexClient({
    token: () => getToken(),
    downloadOrigins: contentOrigins,
    downloadAuthOrigins: oauthDownloadOrigins,
    maxBytes: 8 * 1024 * 1024,
  });
  return disk.read(path);
}
```

The API base defaults to `https://cloud-api.yandex.net/v1/disk/`. API calls send `Authorization: OAuth ...`, request
JSON, omit ambient cookies, and refuse API redirects. Token issuance, scopes, rotation, and account continuity belong to
the caller. No method retries automatically. Constructor defaults never grant content origins; empty allowlists permit
metadata but refuse content requests.

## Native paths and bounded listing

Pass literal `disk:/folder/file` paths. Percent characters are literal filename characters, encoded once by
`URLSearchParams`, not decoded as path separators. The local profile rejects dot/empty components, backslash, NUL,
malformed Unicode, paths longer than 32,760 UTF-16 units or 32,768 UTF-8 bytes, and components longer than 255 UTF-16
units. These conservative local limits are distinct from the provider's documented character limits. Root `disk:/` can
be read/listed but cannot be mutated through this client.

`app:/` is deliberately outside this profile. Official documentation says app aliases return absolute `disk:/Apps/...`
paths, and users can move or rename app folders. A caller must not infer that a guessed absolute prefix is a stable
application namespace.

`stat(path)` returns native path, name, kind, and selected optional metadata. File sizes must be safe JavaScript
integers. Modified time and the service's MD5 are metadata, not revision conditions or publisher authentication. The
current reviewed Resource contract does not establish stable-ID routing or a pinned version API. No `ByteSource`
identity is manufactured from a path or timestamp.

`listPage(path, { offset, limit })` returns native page bounds and direct children. Its default limit is 100, with a
local ceiling of 1,000. The response must provide `_embedded` listing evidence, even for an empty result; missing
evidence is refused rather than guessed empty. Offset, limit, total, parent paths, and duplicate paths are checked.
`list(path)` collects pages within default caps of 1,000 pages and 100,000 entries, with ceilings of 100,000 pages and
1,000,000 entries. It refuses stalled/repeated pages. Native ordering puts folders before files even when sorting by
name. Concurrent inserts, moves, or removals can still omit items across offset pages: the result is not an atomic
directory snapshot.

Control responses use the shared 8 MiB body bound. A duplicate-aware preflight rejects overwritten authority keys and
prototype-related keys before JSON parsing. The selected response profile accepts only safe integer numeric lexemes,
refusing fractions/exponents before rounding. It caps depth at 32, tokens at 1,000,000, lexical strings at 196,608
characters, and scalar tokens at 128 characters. This materializes bounded control text and objects; it is not a
streaming JSON parser.

## Download credentials differ from upload credentials

The official download contract requires the same OAuth token used to request the download link. `download()` captures
one operation token for metadata, link acquisition, and the initial content request. That initial origin must appear in
both `downloadOrigins` and the separate `downloadAuthOrigins` grant. A returned URL cannot grant credentials by itself.

All subsequent download redirects strip OAuth permanently, even if they return to the original origin, the API origin,
or an origin listed for initial OAuth. At most three redirects are admitted; each still needs an exact `downloadOrigins`
grant. There is no silent authenticated retry if a redirect hop requires credentials. Requests omit cookies and
referrers. This conservative profile may refuse deployments whose redirect target requires OAuth.

`getDownloadLink(path)` returns the secret native link without exposing the operation token. Do not log or persist
content URLs as replay identities. `download(path, options)` returns the owned byte stream, native metadata, selected
length, and `evidence: "server-trusted"`. Consume or cancel the stream. Full reads require HTTP 200. Ranges require HTTP
206, finite matching `Content-Range`, the metadata's total size, identity encoding, and true EOF at the selected extent.
Ignored ranges, truncation, overrun, or excessive empty chunks fail. Range support is admitted from actual response
evidence; authored tests do not prove every Yandex deployment supports it.

`read()` buffers within an 8 MiB default and 64 MiB local hard ceiling. It checks metadata admission before opening
content. A zero-length read is local without existence evidence. A nonzero range starting at or beyond EOF is refused.
Metadata and content are separate requests; same-size concurrent overwrites can still pass these checks. No immutable
revision-bound random-access claim is made.

## Upload acknowledgments and recovery

`getUploadLink(path, { overwrite })` requests the provider's expiring PUT URL. The documented link lifetime is 30
minutes if unused; the API does not provide an absolute expiry receipt here. `upload(path, bytes, { overwrite })`
snapshots the bounded bytes, target, and explicit overwrite flag before token acquisition. A separate exact
`uploadOrigins` grant is required. The uploader receives `application/octet-stream` bytes with **no OAuth**, cookies, or
referrer; redirects are refused. Copying needs owned buffer storage in addition to caller bytes; callers must
synchronize concurrent shared-memory writes because copying a SharedArrayBuffer is not an atomic snapshot. `allowHttp`
exists only for explicitly granted private fixtures.

An upload returns one of:

- `state: "created"`, `acknowledgment: "http-201"`: native creation acknowledgment.
- `state: "pending"`, `acknowledgment: "http-202"`: bytes were received but have not yet been moved to Disk according to
  the native contract.

Both retain the intended path and submitted byte length. Neither is a returned file ID, complete digest receipt, or
independent attribution of later path contents. Upload202 has no documented operation URL, so the client does not invent
one or report completion. The application must reconcile separately. A subsequent path stat alone cannot prove which
concurrent writer published it. No resumable destination, committed-offset probe, or checkpoint contract is inferred
from upload `Content-Range` error descriptions.

## Native mutations can be asynchronous and recursive

`createFolder(path)` requires HTTP 201 with a metadata link matching that exact requested target.
`copy(from, to, { overwrite })` and `move(from, to, { overwrite })` return native HTTP201 completed acknowledgments or
HTTP202 pending receipts. Copy/move receipts retain the intended `from` and destination `path`. Pending receipts include
a validated operation link. Native copy/move may recurse over folders; neither is a version-bound or atomic tree
operation.

`deleteResource(path, { recursive: true, permanently })` explicitly admits current-path recursive deletion. Set
`permanently: false` for native Trash behavior or `true` for native permanent deletion. Even if the current path names a
file, another writer can replace it with a directory before deletion. This method does not pretend to be a one-entry
filesystem remove. HTTP204 is a native completed acknowledgment; HTTP202 requires operation tracking.

`statusOperation(receipt.operation)` polls once and returns `in-progress`, `success`, or `failed`. Only the exact API
authority and native operation routes are admitted: documented `operations/<id>` and the official examples' sole
`operations?id=<id>` query spelling. No arbitrary API link, extra query, template, or redirect receives OAuth. A
successful status refers to that operation, not an immutable current destination; failure does not prove rollback. The
library does not sleep, poll automatically, or replay a failed mutation.

Once a mutation dispatches, transport loss, malformed/unrecognized receipt, or undelivered response becomes
`YandexPublicationError` with `outcome: "unknown"`. This conservative category does not assert that every rejected
request changed state. Preserve any received operation ID and reconcile before deciding whether another mutation is
safe. Losing a pending operation link is not evidence that the operation stopped. Failures before dispatch retain their
original reason. Library error messages omit raw signed-URL and JSON-parser context. Arbitrary injected token/Fetch
errors remain caller-owned and may contain secrets, including inside publication-error causes; redact such foreign
errors before logging.

Signals are passed through requests and returned stream ownership. Rejected bodies are consumed or cancelled, and
primary failures survive cleanup errors. Injected capabilities own their own cancellation contracts. Nothing in this
profile supplies SDK integration, public-sharing APIs, trash traversal/purge, app-folder alias discovery, native
file-version selection, resumable upload, or canonical filesystem projection.

## Evidence and primary contracts

Tests are authored Fetch protocol fixtures, not live Yandex or an independent server implementation. They cover path
encoding, hostile JSON, offset progression, credential grants and redirect stripping, exact extents, mutation receipts,
unknown outcomes, and snapshots across awaited token acquisition. They establish this finite client profile, not
subscription eligibility, deployed limits, browser CORS, or universal range availability.

Official HTML was retrieved directly on 2026-11-05; the documentation site's relative links duplicate the locale when
opened from some generated index pages. These SHA-256 values identify reviewed mutable HTML bytes, not an immutable
provider release:

| Official source                                                                                 | SHA-256                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [concepts/app-folders](https://yandex.com/dev/disk-api/doc/en/concepts/app-folders)             | `ff68bfe6ae101e72d616cc509a8e1c2de1f0bfeac76d39f9de0a124bacb9066f` |
| [concepts/quickstart](https://yandex.com/dev/disk-api/doc/en/concepts/quickstart)               | `bec04c63aeed9dc5255c97683dd7d17c53aa4bb251be840db9856556249d5a9c` |
| [reference/content](https://yandex.com/dev/disk-api/doc/en/reference/content)                   | `29a9a1ff5a10190b7e5e7b796d49417fd10aa573642a07d198392eeadee8ff7a` |
| [reference/copy](https://yandex.com/dev/disk-api/doc/en/reference/copy)                         | `c04b2aa319289dc50c15b0fd476456ff068e636f3bbef3b2ab015c8bdd88b383` |
| [reference/create-folder](https://yandex.com/dev/disk-api/doc/en/reference/create-folder)       | `9bbafe16ffd6b03cb80f1b250585a23849a60b79c7d75c387f47531f0b26d84d` |
| [reference/delete](https://yandex.com/dev/disk-api/doc/en/reference/delete)                     | `40d2bbd5d7ea265c5285fc17a87bba9851e6d221db4fbe3a877b4deaad16795f` |
| [reference/meta](https://yandex.com/dev/disk-api/doc/en/reference/meta)                         | `2bb866d6314e992435f176ca7e4a379c2ae1e7029d858d56b0b3a1732ed33ec4` |
| [reference/move](https://yandex.com/dev/disk-api/doc/en/reference/move)                         | `629123c6bee5eaf78309560e4d1879bbee00a64454cf5a676e03c681e4960049` |
| [reference/operations](https://yandex.com/dev/disk-api/doc/en/reference/operations)             | `56a10cc12c829fa34727a72c7caba89f635565917fb457678ca66cc691c4eaa6` |
| [reference/response-objects](https://yandex.com/dev/disk-api/doc/en/reference/response-objects) | `bfe4269b570f14b5db8f7abe9bc9c188a566f80563f3129edd2d4b0ffecec776` |
| [reference/upload](https://yandex.com/dev/disk-api/doc/en/reference/upload)                     | `0c6e69bfa6e7fe3f45d770a5ffb0c95a1c9d6026c43c73729f4d16560024f87f` |
