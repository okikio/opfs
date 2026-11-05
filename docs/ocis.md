# Use one ownCloud Infinite Scale space through WebDAV

ownCloud Infinite Scale exposes a WebDAV collection for each selected space. Use the existing WebDAV client rather than
a separate provider wrapper. The application chooses that collection and supplies its own authentication context.

This complete function reads an existing file's first bytes under the server's strong ETag:

```ts
import { createWebdavClient } from "@okikio/opfs/webdav";

export async function preview(
  collection: string,
  authorization: string,
  account: string,
  path: string,
): Promise<Uint8Array> {
  const client = createWebdavClient({
    endpoint: collection,
    headers: () => ({ authorization }),
    namespace: account,
  });
  const source = await client.openSource(path);
  return await source.read(0, Math.min(32, source.size));
}
```

Use an explicit reachable collection such as `https://cloud.example/dav/spaces/{resourceID}/`. The space ID is a native
identifier, not a display name or a local path. A caller that obtains a URL through LibreGraph must validate its origin
and selected space before granting credentials. This profile does not discover accounts or spaces. The namespace is a
caller assertion that includes the account context; it is not a provider identity proof.

## What the shared client provides

The [WebDAV guide](webdav.md) owns the actual programming model, bounds, XML namespace rules, ETag requirements,
cancellation and uncertain-publication behavior. Infinite Scale's `DAV:` properties can describe regular files and
collections; ownCloud-specific permissions, checksums and resource IDs remain separate metadata and are not inferred
from path operations. An ETag is a provider validator, not a cryptographic digest or proof of publisher authenticity.

The native client offers bounded listing, exact GET ranges, materialized PUT and MKCOL. The pinned native 8.2.2 test
found three important condition differences. GET ignores stale `If-Match` and returns the replacement bytes; the client
checks the returned ETag and refuses those bytes with `WebDAV GET returned a different revision.` Stale conditional PUT
is refused with HTTP 409, preserving the existing bytes, rather than HTTP 412.

More seriously, PUT with `If-None-Match: *` succeeds against an existing file and replaces its bytes. Thus `createOnly`
does not provide its intended guarantee on this server. Do not rely on atomic creation or infer safe competing creators.
The filesystem's existing `noReplace` behavior is cooperative and does not become atomic on this server. Read-only
driver/adapter use is qualified; ordinary facade replacement writes were not exercised by this test. Explicit native
replacement remains a caller-owned operation whose conditions must match the deployment. Append and positional/streamed
writes remain unsupported. Canonical removal refuses before I/O because generic WebDAV DELETE can recursively remove a
collection; this profile does not weaken that admission. Native client DELETE, COPY and MOVE are not qualified by the
initial Infinite Scale test and are not a filesystem transaction or retention guarantee.

LibreGraph space discovery and sharing, permissions administration, trash/versions, LOCK and resumable TUS uploads are
outside this compatibility slice. In particular, native upload offset evidence and asynchronous processing do not by
themselves prove final file publication. The PHP-based ownCloud Server and Nextcloud are different deployments and do
not inherit this profile's evidence.

## Independent verification and fixture ownership

The native recipe in `tests/provider/ocis.ts` and `tests/ocis-provider.test.ts` uses official rclone, an independent
complete-byte producer and reader against the disposable service. It checks full binary bytes in both directions, exact
ranges, Unicode listing, conditional replacement, native stale-GET behavior, client ETag refusal and the observed
create-only incompatibility. No production module imports rclone, a provider SDK or its configuration.

Run `node --test tests/ocis-provider.test.ts` from the repository with Docker available. The passing test establishes
this constrained profile, including the assertions that expose incompatible native conditions; it does not establish
full WebDAV or filesystem-write equivalence.

The fixture uses the released official Infinite Scale 8.2.2 image and rclone 1.75.2, each pinned by immutable index
digest. Testcontainers owns a private network, ephemeral host port, native initialization/readiness, partial-start
cleanup and reverse-order teardown. The server has a 2 GiB/1 CPU quota and the CLI has 0.125 GiB/0.25 CPU. No host data,
ambient account or host configuration is mounted. The CLI receives only fixture-created credentials and a private
service URL for the same selected space; complete binary output is transported as base64 rather than decoded as text.

Development Basic authentication and plaintext transport are enabled only inside this isolated fixture, as the official
deployment supports behind a TLS-terminating proxy. Production applications own HTTPS, OIDC/app credentials and their
deployment policy. The fixture's HTTPS-form canonical `OCIS_URL` follows native IDP configuration, while the candidate
uses its actual mapped HTTP authority. Candidate URLs, XML hrefs and conditional requests are not rewritten. The native
`GATEWAY_FRONTEND_PUBLIC_URL=http://ocis.test:9200` setting directs the service's internal data transfer to its real
private listener. The first fixture run lacked that setting and failed during independent rclone upload because the
native gateway tried HTTPS port 443; this setup failure is separate from the condition findings above.

The fixture selects one personal-space ID through the native LibreGraph endpoint solely for disposable setup. That does
not implement a public Graph client or equate Graph drive IDs with arbitrary filesystem paths. The service initializes
fresh configuration through its pinned native CLI; it does not ignore arbitrary setup errors or depend on an existing
host installation.

Primary source inspected on 2026-11-05 is released commit
[`fbd21b636cb0fa8db2e62a5aae96f21ab082f871`](https://github.com/owncloud/ocis/tree/fbd21b636cb0fa8db2e62a5aae96f21ab082f871):

| Contract                                                                 | SHA-256 of inspected source                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `ocis/pkg/command/init.go`                                               | `9f4e5468411596572edd52512cb87a3cbed3b9b0bfa2178b91c5d4c59eeb6e44` |
| `deployments/examples/ocis_full/ocis.yml`                                | `63348f6f5b776c0f520106067ca8ea8716d0e1f74ebe4cde0d8e605af73cadee` |
| `services/gateway/pkg/config/config.go`                                  | `6532ea42cdd193cd3ea9e22e6a8f102ce0fb1c7bd6dbebaddf2e0414d70bad8f` |
| `services/gateway/pkg/revaconfig/config.go`                              | `23c10fd05d139419f8db87e7b7fa2ed22504321eb205d30f3566c6bc09b87ccd` |
| `tests/acceptance/features/coreApiWebdavOperations/downloadFile.feature` | `9dd523b8365458fe5a4ab0e91444d255a0dee2b33856c86906ba572199c737f2` |
| `tests/acceptance/features/coreApiWebdavUpload/uploadFile.feature`       | `90287b70cb78c7ca6b558c468da5d469bc4ad57b3e88da41ad8dcf31bd9138b5` |

The official [WebDAV contract](https://owncloud.dev/apis/http/webdav/),
[space API](https://owncloud.dev/apis/http/graph/spaces/) and
[proxy authentication configuration](https://doc.owncloud.com/ocis/8.2/admin/deployment/services/s-list/proxy.html)
provide additional context; current web documentation can describe a different release from the fixture.

Server index: `sha256:0367455bbde082e17f40bff5b906eb554c13d9a6e86134734a982239c5692383`. Independent CLI index:
`sha256:2687085f718d3c628f7fdfb77c52a1d344332aed543110bb88088f2c70d43eb5`. The released server source is Apache 2.0;
rclone is test-only and retains its own MIT license. Native images contain their own dependency graph. These pins do not
constitute a supply-chain audit or prove production scale, external identity providers, alternate storage layouts or
every server release.
