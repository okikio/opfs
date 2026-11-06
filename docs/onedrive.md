# OneDrive and SharePoint drive files

Microsoft Graph identifies a stored item with a drive ID and an item ID. This native client preserves those IDs and
their file/folder facets. It does not turn names into unique paths or project Graph into filesystem primitives.

```ts
import { OnedriveClient } from "@okikio/opfs/onedrive";

const files = new OnedriveClient({
  driveId: "replace-with-your-drive-id",
  token: () => "replace-with-your-Graph-OAuth-token",
  // Exact deployment origins, obtained from your trusted tenant configuration.
  // These are examples; do not copy them as a general Microsoft host allowlist.
  downloadOrigins: ["https://contoso.sharepoint.com"],
  uploadOrigins: ["https://contoso.sharepoint.com"],
});
const bytes = new TextEncoder().encode("hello");
const upload = await files.createUpload({
  size: bytes.length,
  target: { kind: "create", parentId: "replace-with-a-parent-item-id", name: "hello.txt", conflict: "fail" },
});
const result = await files.writeUpload(upload, 0, bytes);
if (!result.complete) throw new Error("Upload is staged; inspect its missing ranges before continuing.");
const stream = await files.download(result.item.id, { at: 0, length: 5 });
console.log(await new Response(stream).text()); // hello
await files.trash(result.item.id); // Graph DELETE recycles this item; it does not permanently erase it.
```

Your application acquires and refreshes OAuth credentials with the scopes appropriate for its user, tenant and drive.
The client defaults to the Graph v1.0 endpoint. A custom `endpoint` can select another deployment; `driveId` is always
explicit. No account discovery or ambient credential loading occurs during construction or import. Returned streams
belong to their consumer, who must drain or cancel them.

## Item IDs, names and pages

`stat(itemId)` returns metadata with a `kind` derived from Graph facets. `root` explicitly selects the drive root.
Informational `etag` and `ctag` fields do not bind later content-download requests to the same revision. A remote item,
package, folder or deleted item is not silently treated as a regular stored file. An ambiguous combination of file and
container facets is also refused for media download and completed-upload receipts.

`listPage(parentId, { next, pageSize })` returns one native child page and its opaque continuation URL. `list(parentId)`
iterates within `maxPages` (1000 by default) and `maxEntries` (100000). Pages have an independent 1000-entry ceiling and
the shared provider JSON reader has an 8 MiB encoded control-body ceiling. Repeated continuation URLs and exhausted
budgets raise errors rather than restarting. Continuations must remain at the same Graph origin and exact selected
children route, with admitted pagination query fields, before acquiring another OAuth token.

IDs remain authoritative when names repeat in results or across folders and drives. This API neither claims that
duplicate names are permitted in every Graph folder nor selects the first matching name. Listing is not a consistent
snapshot: concurrent moves, renames and additions can affect pages. Folder/package traversal, remote-item resolution,
site/drive discovery and name-to-path lookup are outside this profile.

## Downloads without credential forwarding

`download(id, { at, length, signal })` asks Graph for the fresh `@microsoft.graph.downloadUrl` annotation alongside item
metadata. This avoids the authenticated `/content` redirect, which has additional browser restrictions. The returned URL
is short-lived preauthenticated authority. It is admitted against `downloadOrigins`, then requested without a Graph
token callback, Authorization header or cookies. `credentials: "omit"` and `redirect: "manual"` apply to every request;
the client does not follow further service redirects or forward OAuth credentials to capability URLs.

Allowlist entries are exact origins, not host suffixes. There are no default download or upload origins: an unexpected
tenant/CDN origin is refused until the application explicitly configures it. Upload and download allowlists are
separate. `uploadPrefixes` can additionally constrain upload paths; encoded separator/double-encoding aliases are
refused when that path policy is active. Userinfo and fragments are always refused. HTTPS is required unless the
application explicitly sets `allowHttp` for its own trusted private endpoint or protocol fixture. Capability URLs,
including their queries, are secrets and must not be logged or shared.

Ranges go to the download capability, not the Graph metadata request. A range response must supply HTTP 206 and a finite
matching Content-Range. A full HTTP 200 substituted for a requested range is refused, as are encoded content and
mismatched extents; rejected bodies are cancelled. Zero-length reads are local and do not establish remote existence.
Reads remain mutable: separate calls can observe different revisions. There is no `ByteSourceType`, immutable replay
identity, verified hash or snapshot-read claim from an ID, tag, size, URL or modification timestamp.

## Native sessions and partial missing-range evidence

`createUpload({ size, target })` starts a positive, fixed-size stored-file upload. A create target supplies parent ID,
single name and conflict policy (`fail` by default, `replace` or `rename` explicitly). An update target supplies an
existing item ID. Names are confined to the create-session route; no general path parser is involved. Conflict policy
does not assert transactional filesystem replacement. The initial profile uses automatic commit and does not expose
deferred commit, label-specific authentication behavior or zero-byte sessions.

Keep the returned `OnedriveUploadType` in trusted storage and own it exclusively. Its URL is a preauthenticated upload
capability. A restored session is independently checked against the configured drive, allowed upload origin, optional
path prefixes and positive fixed size. OAuth is used only to create the session; session GET/PUT/DELETE requests never
call the Graph token provider and never carry Graph Authorization or cookies.

`queryUpload(session)` returns `complete: false`, `expires`, and inclusive missing ranges. A range with no `end` runs
through the end of the fixed source. These ranges may omit other missing regions; even an empty returned list does not
prove completion. They are native reconciliation evidence, not a contiguous acknowledged offset. For this reason this
profile deliberately has no `UploadDestinationType` wrapper. Flattening the first missing range into an offset would
claim more than the service reports.

`writeUpload(session, offset, bytes)` copies genuine Uint8Array backing bytes before awaiting transport. The caller
keeps the logical source unchanged and serializes fragments in provider order. Nonfinal fragment lengths must be
positive multiples of 320 KiB. This implementation caps one call at 8 MiB; the service requires requests smaller than 60
MiB. Choose aligned fragments such as `25 * ONEDRIVE_CHUNK_BYTES` (8,192,000 bytes). Final fragments may be smaller. The
fixed total is sent in Content-Range for every fragment.

HTTP 202 means staging only. Completion requires HTTP 200/201 with a regular, nondeleted file receipt, safe matching
size, a final extent ending at the fixed total, and matching update ID. A returned drive or create-parent ID must also
match; the returned create name must match unless the explicit conflict policy permits renaming. An omitted parent facet
is not invented as a verified path. These checks attribute the receipt and byte extent, not cryptographic integrity.

Mutating requests are never automatically retried. `OnedrivePublicationError` means a dispatched request or receipt did
not establish its outcome. Session status can assist recovery of missing bytes, but cannot reliably reproduce a lost
final item receipt. A later `stat` is not proof that this upload published the current file. HTTP 404 after an uncertain
final write remains unresolved; the client never automatically restarts creation or overwrites the item.
`OnedriveError.status` reports native HTTP failures without printing credential-bearing URLs or response bodies.

`cancelUpload(session)` explicitly DELETEs temporary upload state. It does not delete a published item, and a lost
cancel acknowledgement does not prove cleanup. Native temporary-state expiry is distinct from local cancellation.
`trash(itemId, { ifMatch })` uses Graph's recycle-bin DELETE and can include an explicit native item condition. Folder
deletion can affect descendants, so there is no canonical single-entry filesystem removal or permanent-delete/restore
claim.

## Evidence and sources

`tests/onedrive.test.ts` provides injected protocol cases for drive/item identity, metadata shapes, paging boundaries,
credential-free capabilities, facet admission, range rejection/retirement, sparse missing ranges, fragment admission,
byte ownership and final receipt attribution. This is protocol evidence, not live Graph/OAuth, tenant policy,
SharePoint, OneDrive Personal or Business conformance. No service credentials are used.

Primary contracts: Microsoft's
[driveItem](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0),
[downloads](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0),
[children](https://learn.microsoft.com/en-us/graph/api/driveitem-list-children?view=graph-rest-1.0),
[upload sessions](https://learn.microsoft.com/en-us/graph/api/driveitem-createuploadsession?view=graph-rest-1.0),
[session properties](https://learn.microsoft.com/en-us/graph/api/resources/uploadsession?view=graph-rest-1.0), and
[recycle-bin deletion](https://learn.microsoft.com/en-us/graph/api/driveitem-delete?view=graph-rest-1.0).
