# Read and publish documents through CMIS

CMIS is a repository protocol for documents and folders. An object ID identifies one native object; its name, filing
paths, version-series ID and change token are different properties. This client uses the CMIS 1.1 JSON Browser Binding
without turning those objects into filesystem paths.

This complete function inspects a caller-selected repository, lists one root-folder page and reads one selected
document:

```ts
import { createCmisClient } from "@okikio/opfs/cmis";

export async function readDocument(
  repository: string,
  repositoryUrl: string,
  rootUrl: string,
  authorization: string,
  documentId: string,
): Promise<Uint8Array> {
  const client = createCmisClient({
    repository,
    repositoryUrl,
    rootUrl,
    credentials: () => ({ authorization }),
    maxBytes: 8 * 1024 * 1024,
  });
  const info = await client.repository();
  const page = await client.list(info.root, { limit: 100 });
  console.log(page.objects.map((object) => ({ id: object.id, name: object.name })));
  const metadata = await client.get(documentId);
  if (metadata.baseType !== "cmis:document") throw new TypeError("Select a document object.");
  return await client.read(metadata.id);
}
```

The repository URL and root-folder URL are exact caller-granted API targets, such as `/browser/A1` and
`/browser/A1/root`. They are not inferred from a path convention. Repository information can report other URLs; these
remain inert strings and never replace the configured targets or acquire credentials. The credential callback receives a
detached URL and the operation signal. It can supply `authorization`; cookies, account discovery and redirects are
disabled. HTTPS is required unless a caller explicitly enables `allowHttp` for its own deployment.

## Preserve native properties and evidence

`get()` returns the object's ID, name, base type and a frozen property dictionary. Each property retains its declared
native type and `single`/`multi` cardinality. `values: null` means unset. A set single value has one array member;
multi-value order and an empty array remain intact. IDs, HTML, URI and string values are inert text. The client does not
render HTML, follow URI properties, infer parentage or select a latest version automatically.

Integer and decimal property values are exact JSON numeric text, not rounded JavaScript numbers. For example, an integer
property can return `"900719925474099123456789"`; its property type remains `integer`. Decimal exponent spelling is
retained. Datetimes are exact safe integer Unix epoch milliseconds. Fractional/unsafe datetimes and fractional/unsafe
page counts are refused. This finite profile requires declared property types/cardinalities and rejects duplicate or
prototype-affecting JSON keys, numeric tokens over 128 characters, excessive depth, properties and page sizes. Control
JSON is limited to 8 MiB, depth 32 and 100,000 tokens. Each object admits at most 2,048 properties, each property at
most 4,096 values, and each child page at most 1,000 objects. These are implementation safety bounds, not provider
capacity claims.

`list()` returns one bounded `skipCount`/`maxItems` page and the next offset only when `hasMoreItems` is true. This is
not a snapshot. Concurrent repository changes can reorder later pages. The caller owns traversal, deduplication and any
repository-specific consistency policy. Multifiling means one document may appear in several folders; the client does
not invent one canonical path.

`read()` materializes the current original content stream within `maxBytes` (default 8 MiB; implementation ceiling 64
MiB). A declared Content-Length must agree with the complete body. Actual bytes are bounded even when that header is
absent. Compressed transfer representations and redirects are refused. Successful reads return caller-owned bytes;
native stream errors and cancellation retain their original failure and retire owned readers.

A CMIS object ID or change token alone does not prove that later content reads are immutable. This client therefore does
not publish a replay identity, ByteSource, rendition decoder, range source or content-hash verification claim. Metadata
and content are separate operations and can change between them. HTTP range support is not inferred from the SOAP
binding's offset/length arguments.

## Create or replace explicit content

`create(folderId, name, bytes, { versioningState })` creates an ordinary `cmis:document`. The caller must choose the
native versioning state: `none`, `major`, `minor` or `checkedout`. The repository enforces type/versioning support,
permissions, naming and duplicate-name policy. Creation is not an atomic create-by-name filesystem primitive.

`replace(objectId, bytes, { changeToken })` sends native `setContent` with `overwriteFlag=true`. It first requires the
repository to advertise `capabilityContentStreamUpdatability=anytime`. Repositories limited to private working copies
need a separate checkout/checkin flow, which this profile does not implement. The change token is caller-provided,
opaque and checked by the server; it is not an ETag, content digest or universal compare-and-swap guarantee. Returned
object IDs can change when native version rules create another version.

The client reads the target's metadata before dispatch and requires a replacement receipt to name that same object ID. A
changed object ID is accepted only when both the target and receipt explicitly identify the same nonempty native
version-series ID. This check binds native identity evidence; it does not pin content reads or replace the caller's
change-token condition. An unrelated same-length document is not a valid replacement receipt.

Both operations copy bounded upload bytes, media type, target and options before credential/discovery awaits. The client
validates a complete document receipt, expected content length, and the name for creation. That receipt is server
evidence, not independent proof of stored bytes. Complete-byte readback through an independent client is a separate
verification step.

Native 4xx refusals remain `CmisError` with HTTP status and a sanitized exception category. Raw server messages are not
echoed. If a dispatched mutation loses its response, returns a server error, or lacks a complete receipt, it throws
`CmisPublicationError` with `outcome: "unknown"`, operation and target ID. Do not retry blindly: inspect the selected
folder/object using the application's naming, version and change-token policy. A later resource cleanup failure does not
turn an already validated publication receipt into an unknown publication. Foreign Fetch/credential errors can contain
their own diagnostic data; the client preserves these causes rather than claiming to sanitize arbitrary code.

This Browser Binding profile requires HTTP 201 for both `createDocument` and `setContent`, as specified by section
5.4.3.22 for the latter. It does not inherit AtomPub status rules.

## Verification and limits

Protocol tests cover credential isolation, inert discovery URLs, exact numeric properties, cardinality, pagination,
bounded content, terminal stream failures, byte snapshots, native capability admission, conflict receipts, uncertain
publication and cancellation. Replacement receipt tests accept changed IDs only with matching explicit version-series
metadata and reject unrelated same-size documents, absent series and mismatched series.

The native test in `tests/cmis-provider.test.ts` passed against the independent archival Apache server/client. It checks
SDK-produced complete binary bytes through the candidate, candidate create/replacement through SDK complete-byte
readback, repository discovery, typed metadata and offset pages. The native stale-token request returns HTTP 409
`updateConflict` and leaves the stored bytes unchanged. These are ordinary document operations; the test does not
qualify a complete vendor versioning workflow. Run `node --test tests/cmis-provider.test.ts` with Docker available. No
production module imports an Apache SDK or acquires a Java runtime.

The primary [OASIS CMIS 1.1 standard](https://docs.oasis-open.org/cmis/CMIS/v1.1/os/CMIS-v1.1-os.html) and
[approved errata](https://docs.oasis-open.org/cmis/CMIS/v1.1/errata01/os/CMIS-v1.1-errata01-os.html) were inspected on
2026-11-05. Their inspected SHA-256 values are respectively
`f087b11cab424505f013c10289cb49c327843574e4857698dbe042ec08e62c42` and
`6288d20cee0843f83fdb8a1040844a303c5e7262a54719c77339dbdb961902d1`. The independent Apache OpenCMIS 1.1.0 release source
is pinned at
[`d29990d9eb952c155776611f870d58904c04d977`](https://github.com/apache/chemistry-opencmis/tree/d29990d9eb952c155776611f870d58904c04d977).
[Apache Chemistry retired in 2022](https://attic.apache.org/projects/chemistry.html); its archival oracle is test-only,
not a maintained deployment recommendation or a supply-chain audit. A passing fixture cannot establish every vendor's
version, ACL, multifiling, checkout or retention behavior.

At that release commit, the inspected Browser `RepositoryService.java` SHA-256 is
`751cdb600a29e1a215256f252cfda9aaa4afaa12851f4cc318878f7b814f3d28`; `ObjectService.java` is
`8622247d6f389267281500c99cef08c3bb03d0a94ffc51caa0fd808f068449bd`. These sources establish the repository-ID map and
HTTP 201 `setContent` response. The inspected commons `JSONConverter.java` is
`c77cbcc7c4ac510f95b190e799cbb9ebeca030068c53398925d204a5e2290000`, which preserves the distinction between scalar
single-value properties and arrays of multi-value properties.

The prepared fixture uses the official InMemory WAR and the independent official Java client ZIP, whose acquired bytes
were inspected before extraction:

| Artifact                                                                           | SHA-256                                                            |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Maven `org.apache.chemistry.opencmis:chemistry-opencmis-server-inmemory:war:1.1.0` | `e64213571d416a5ff03a923693b97bb32d680b353af40d6807ce007197ae71d9` |
| Apache `chemistry-opencmis-client-impl-1.1.0-with-dependencies.zip`                | `8ee3726aad738ac4b8866aeb9db31a56880ef44678374e1fa043213834aefd2c` |

They also matched the publisher's legacy SHA-1 values `a3571ac1c5ffb712a0d61fdbad76282adfb08bb2` and
`b7e1e1d5cf06fb2e3283e4f3a246ca8b9ac21d3f`; those comparisons do not establish modern artifact authenticity. Inspection
found 82 WAR entries with 10,479,172 expanded bytes and 28 client ZIP entries with 6,920,936 expanded bytes, without
absolute paths, traversal or backslash aliases. The digest check binds those exact inspected bytes before Java's native
archive extraction. Apache licenses/notices and the historical client dependency graph remain in the test artifacts;
nothing is copied into production.

Testcontainers owns a private network, ephemeral host port, native readiness and reverse-order cleanup. The official
Tomcat9/Java8 index is pinned to `sha256:340be5aeee31d66d3b0ea39263737e2066f98b96e2832fd85eb58da41c0ce0da`. The server
has a 1 GiB/1 CPU quota with a 512 MiB Java heap; the independent client has 0.5 GiB/0.5 CPU and a 128 MiB heap. Only
the fixture's own credentials and repository are used. SDK seed bytes are copied into its container as a bounded file;
full binary readback crosses the exec text channel as base64. No host configuration is mounted.

The archival InMemory WAR does not install an HTTP authentication filter. In the first native run it accepted a GET with
invalid Basic credentials despite its configured users/password. Its `WEB-INF/web.xml` explicitly leaves an
authentication filter to the deployment. The fixture therefore qualifies request credential isolation and native
document/change-token behavior, not HTTP authentication enforcement or production authorization. The initial failed
authentication assertion is retained separately from complete-byte protocol evidence. The inspected packaged
`WEB-INF/web.xml` SHA-256 is `2f8a7091c270200e8b31d62b18e18e324070de03dc0d358e4814e98399dd1dd8`.

AtomPub/SOAP, arbitrary type definitions, property mutation, renditions, queries, ACLs, policies, relationships,
checkout/checkin, repository deletion, filesystem projection and streaming uploads remain separate profiles.
