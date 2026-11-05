# Use native Swift regular objects

Use this profile when an application already has an OpenStack Swift account storage URL and access token. It speaks
Swift v1 directly, without a provider SDK, Keystone discovery or an S3 compatibility gateway. This example writes a
small regular object and opens a revision-bound byte source for a preview:

```ts
import { createSwiftClient } from "@okikio/opfs/swift";
import { openObjectSource } from "@okikio/opfs/source";

export async function preview(
  endpoint: string,
  container: string,
  token: () => Promise<string>,
) {
  const client = createSwiftClient({ endpoint, container, token });
  const receipt = await client.put("notes/example.txt", new TextEncoder().encode("hello Swift"));
  const source = await openObjectSource(client, "notes/example.txt");
  const bytes = await source.read(0, Math.min(5, source.size));
  return { receipt, text: new TextDecoder().decode(bytes), sourceIdentity: source.identity };
}
```

`endpoint` is an account URL such as `https://storage.example/v1/AUTH_project`, rather than an authentication URL or
container URL. The application owns token acquisition, refresh and account selection. The token callback runs for each
HTTP attempt and supplies `X-Auth-Token`; omitting it is suitable only for an explicitly public deployment. The client
never reads environment credentials. Endpoint credentials, query strings and fragments are refused. Redirects are
returned as failures instead of forwarding authorization elsewhere.

For a filesystem projection, pass the client to `createSwiftAdapter()` from `adapter/swift`, then use
`createFileSystem()` as for the other object adapters. `createSwiftDriver()` constructs an independently useful driver;
`createSwiftDriverFromClient()` borrows an existing client. The configured account URL and container contribute to the
credential-free source identity. Tokens are not included.

## Supported operations and concurrency

The client implements HEAD, full/ranged GET, JSON container listings, regular-object PUT and unconditional DELETE. HEAD
preserves safe-integer size, modification time, media type, user metadata and normalized ETag. Swift's unquoted
regular-object MD5 ETags become quoted entity tags; they remain provider validators, not a collision-resistant content
identity. Listing records are enumeration metadata and are not an immutable snapshot of the container.

`openObjectSource()` binds subsequent ranges through `If-Match`. A replacement with a different ETag fails instead of
mixing revisions in an archive index. The client rejects ignored or malformed ranges, mismatched response ETags, unsafe
range totals and HTTP content encodings before transferring the body. A source still needs trusted provider semantics;
matching an ETag is not proof against a malicious storage service or an adversarial MD5 collision.

Native PUT accepts `ifNoneMatch: "*"` for create-only publication. Destination `ifMatch`/`revision`, other `ifNoneMatch`
values and conditional DELETE are refused before credentials or input acquisition. The driver's `conditionalWrite` flag
is **false** because create-only admission does not provide replacement compare-and-swap. Native copy, versions,
large-object segmentation and resumable sessions are also **false**. No generic capability is inferred from an optional
middleware deployment.

The filesystem adapter uses the existing object-family cooperative overwrite contract. Append/update read the current
bytes and publish a replacement. Another writer can change the object during that interval and be overwritten. Directory
and create checks also do not become a cross-object transaction. Applications that require concurrent-writer protection
must serialize writers through their own coordination or select a driver with enforced replacement conditions. The
facade's local coordination does not lock a remote Swift account against other clients. DELETE cannot condition its
removal on a prior stat.

## Streams, receipts and recovery

PUT accepts native `Uint8Array` bytes or an unlocked native `ReadableStream<Uint8Array>`. Materialized bytes are copied
before asynchronous token acquisition. Native byte slots authorize their extent, so caller-owned metadata getters cannot
change the admitted length. Stream input is pulled in bounded 64 KiB chunks, checked against the object limit and
optional `size`, and retired after completion or failure. A transport must support native request streams; the default
transport checks this before acquiring caller input. An injected Fetch owns its declared transport behavior.

Stream upload is one request. There is no session URL, persisted offset, restart protocol or automatic mutation retry. A
failed input or transport can occur after some bytes were dispatched. `SwiftPublicationError` means that the library
cannot attribute publication from a complete valid acknowledgement. A later HEAD can show current storage state but
cannot prove that this attempt, rather than another writer, published it. Reconcile under application ownership before
starting another write. A known HTTP refusal remains `SwiftError` with status and request ID. The adapter maps known
HTTP failures into filesystem categories while preserving causes; it retains uncertain-publication failures.

A successful receipt takes ETag and transaction ID from that PUT's response, size from its fully consumed admitted
input, and properties from its normalized request headers. It never treats the acknowledgement body's
`Content-Length: 0` as object size or invents a receipt from a later HEAD. Cancellation stops work started by the call;
it cannot undo an already committed remote PUT. Successful GET streams transfer to the caller, who must consume or
cancel them. Sources, clients and token providers remain borrowed by composed readers and adapters.

## Listing and implementation limits

JSON listing requests use `prefix`, optional one-character `delimiter`, `limit` and the previous page's marker as
`cursor`. Object names and `subdir` records share the binary UTF-8 ordering used for cursor progress. The implementation
rejects nonadvancing names and results outside the prefix. Every nonempty page gets a continuation marker, even when it
is shorter than requested: deployments can cap pages below the requested limit. Continue until an empty terminal page; a
short nonempty page does not establish completion. Listings are not snapshot-isolated against concurrent changes.

| Policy              | Default and meaning                                                              |
| ------------------- | -------------------------------------------------------------------------------- |
| `maxObjectBytes`    | 5 GiB application ceiling for a single regular object; configurable safe integer |
| `pageSize`          | 1000 requested entries, configurable from 1 through 10000                        |
| One listing body    | Existing 8 MiB provider control-response ceiling                                 |
| Stream upload chunk | 64 KiB owned chunk; transport and source buffering are separate                  |
| HTTP retry          | Shared read policy for GET/HEAD only; PUT/DELETE never automatically replay      |

Cluster limits and middleware are deployment configuration, not universal limits learned by this client. This slice does
not probe `/info` or create containers. The application provisions the target container first. SLO/DLO manifests and
symlinks require different size, dependency and revision contracts and are refused. Reads request
`multipart-manifest=get` and `symlink=get` so an installed middleware cannot silently project assembled segments or a
link target as this regular-object profile. HTTP-encoded objects and URL-normalized dot-segment keys are refused too.
Use an explicit archive/encryption byte-source composition for payload previews; this client does not decrypt Swift
middleware or unlock ZIP passwords.

## Verification and maintenance

`tests/swift.test.ts` exercises injected protocol responses, range/revision refusal, marker progress, native byte
admission, bounded stream input, cancellation/retirement and uncertain acknowledgements. These tests do not discover a
service or use ambient credentials.

`tests/swift-provider.test.ts` uses `tests/provider/swift.ts` to start the community-maintained
[Swift All In One image](https://hub.docker.com/r/openstackswift/saio), pinned to the inspected linux/amd64 manifest
`sha256:86d661810cf1d19f23af2b43f69be4cfd69bb13630755c1d8a4056f49f0785e3`. It owns an ephemeral host port, limits the
container to 1 GiB and one CPU, obtains the image's documented test account, creates a private test container and awaits
cleanup. This is real Swift service evidence for the retained image, including stale ETag/create conflicts, ranges,
marker pagination, streamed PUT and facade append. It does not establish production Keystone/IAM, CORS, replica failure,
durability, all middleware combinations or vendor-branded Swift compatibility. SAIO is a development fixture, not a
production storage recommendation. A release owner must review a replacement digest and rerun the profile before
upgrading it.

The wire contract is grounded in the upstream
[Swift Object Storage API](https://docs.openstack.org/api-ref/object-store/) and
[pagination guide](https://docs.openstack.org/swift/2026.2/api/pagination.html). The explicit limitations above are part
of this profile rather than a claim of complete Swift API coverage.
