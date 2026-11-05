# Read and replace files in a WebDAV collection

The native client exposes regular resources and collections under one configured URL. The driver turns that protocol
into file operations, and the adapter attaches it to the filesystem facade. Authentication, account selection and
installation of third-party code remain application decisions.

```ts
import { createWebdavClient } from "@okikio/opfs/webdav";
import { createWebdavAdapter } from "@okikio/opfs/adapter/webdav";
import { createFileSystem } from "@okikio/opfs";

export async function replace(endpoint: string, authorization: string, account: string) {
  const client = createWebdavClient({
    endpoint,
    headers: () => ({ authorization }),
    namespace: account, // Stable caller assertion including the authenticated account context.
  });
  const filesystem = createFileSystem(createWebdavAdapter(client));
  try {
    await filesystem.writeFile("/notes/example.txt", "hello WebDAV", { parents: true });
    const text = await filesystem.readText("/notes/example.txt");

    const source = await client.openSource("/notes/example.txt");
    const preview = await source.read(0, Math.min(5, source.size));
    return { text, preview, identity: source.identity };
  } finally {
    await filesystem[Symbol.asyncDispose]();
  }
}
```

The endpoint names a collection, for example `https://files.example/dav/account/`. Every operation stays under it. URLs
containing embedded credentials, a query or fragment are refused. A header callback runs per HTTP attempt; the
application owns token refresh. Browser cookie policy is explicit through `credentials`, which defaults to `omit`.
Callback URLs are borrowed copies. The client and credentials remain borrowed by the driver and adapter, so disposing
the filesystem does not revoke or close them.

An identical endpoint can expose different users' home directories. `namespace` must therefore bind the authenticated
account context as well as the intended collection. It must stay fixed for a replay and change when that context
changes. Without it, the client omits automatic replay identity; ranged previews still work, but a resumable transfer
requires an explicit identity. A URL alone cannot safely identify an authenticated snapshot. `openSource()` also accepts
an explicit per-source `namespace` assertion through the ordinary object-source options.

## Metadata, range reads and namespace safety

`stat()` performs Depth:0 PROPFIND; `list()` performs Depth:1 and returns direct children after validating the complete
response. DAV properties must have the `DAV:` namespace. Default declarations, prefixed declarations and disjoint
successful property groups are supported. Foreign or rebound namespace lookalikes, nested scalar lookalikes, duplicate
properties, unsupported resource types and partial resource errors reject rather than authorize a path or size.
Unavailable optional properties may appear in 404 property groups; required file length and resource type must still be
present in successful groups.

Returned hrefs must name the requested collection or an allowed direct child, stay on the configured origin, and remain
inside its decoded collection path. Encoded separators, backslashes, dot segments, repeated separators, query/fragment
hrefs and duplicate canonical identities are refused. The XML parser and control-response reader enforce their existing
byte, node, depth and attribute limits. `maxEntries` defaults to 10,000 children and can be configured from 1 through
100,000; that does not override the separate XML/control-body ceilings.

A PROPFIND may follow exactly one 301/308 response that appends a slash to the same collection path. Its body is retired
before the next request. Arbitrary redirects, changed origins, queries and other path changes are refused. Mutation and
GET redirects are never followed. This supports collection URLs used by the retained WsgiDAV fixture without introducing
a general authorization-forwarding policy.

`openSource()` requires a known regular-file size and an enforceable strong validator, unless the caller explicitly
asserts source stability through `assumeStable`. A conforming strong DAV:getetag can bind the subsequent `If-Match`
range GETs directly. When that property is absent, weak or malformed, the client obtains an independent HTTP HEAD
validator and checks that its finite size equals the PROPFIND file size and that it has identity content encoding. It
does not quote an arbitrary bare property into a strong validator. WsgiDAV 4.4.0 in the pinned fixture returns a bare
property but a quoted HTTP ETag, so that path needs the additional HEAD. A disagreement rejects instead of combining two
descriptions. HTTP HEAD without a usable strong validator still needs an explicit caller stability assertion.

Native `get()` returns a caller-owned stream and supports byte ranges and ETag revisions. Ignored/malformed ranges,
encoded responses and different returned ETags reject before body handoff. A caller must consume or cancel a successful
stream. The driver `readFile()` uses the revision-bound source and defaults to an 8 MiB materialization ceiling;
configure `maxReadBytes` on the driver/adapter for a different positive safe-integer limit, or use `openReadStream()`.
The ceiling applies to returned range allocation, not arbitrary hidden server work. Oversized complete reads reject
before GET, rather than silently buffering the complete file. Reading one source range does not authenticate a provider
or establish archive CRC/encryption evidence.

## Writes, namespace changes and recovery

The native client supports materialized PUT, MKCOL, DELETE, COPY and MOVE. PUT accepts `ifMatch` or `createOnly`;
COPY/MOVE accept `sourceIfMatch`, `overwrite` and cancellation. These conditions do not implement LOCK/UNLOCK, a lease,
a transaction across a collection, or a generic resumable upload. Successful PUT may omit ETag; no later HEAD is used to
invent an acknowledgement belonging to that write.

The file projection admits **replacement writes only**. Append, positional update and streamed writes reject through
hard driver admission before metadata acquisition or source consumption. They are not emulated by an unprotected
read-modify-write. Native COPY/MOVE require explicit `preserve: false` through the driver/facade and are reported as
best-effort. Exclusive publication is unsupported. The protocol's `Overwrite: F` is retained, but the profile does not
claim atomic replacement, a whole-directory transaction or durable staging. The native client remains useful for these
operations without a filesystem facade.

A 207 multistatus from a namespace mutation can describe partial effects. It is a failure, not a success receipt.
`WebdavPublicationError` also identifies a dispatched mutation whose acknowledgement was lost, timed out or failed on
the server. Some remote changes may already have happened; retrying is an application reconciliation decision.
`WebdavError` preserves a known HTTP refusal. Driver translation maps known statuses into filesystem categories while
retaining causes; uncertain-publication errors remain distinguishable.

The driver and facade refuse all canonical removal before provider I/O, including removal of a known file. HTTP strong
ETags bind selected representation bytes, not DAV resource type. A file can become a collection with an equal selected
representation, and conditional DELETE can then recurse into descendants. A metadata check and `If-Match` do not make
that a safe one-entry file primitive. Native `client.remove()` remains an explicitly recursive namespace operation with
an optional `ifMatch` representation condition; the application owns its scope and consequences. There is no generic
`removeFile()` promise, no automatic destructive fallback and no claim that a collection ETag covers its descendants.

Cancellation stops admitted work where the transport supports it and awaits owned response retirement. It cannot undo an
already completed PUT, COPY, MOVE, MKCOL or DELETE. DELETE on a collection is a remote namespace mutation: another
client can add children between a facade's checks and deletion. Do not treat local facade coordination as a remote lock.
The profile supplies no permanent key store, background work, dependency discovery or codec download.

## Verification and maintenance

The protocol tests include default/prefixed/rebound namespaces, foreign/nested authority, escaping hrefs, duplicate
identities, partial status failures, bounded reads, strong-HEAD fallback and mutation acknowledgement loss. They use
injected responses and are not deployment certification.

`tests/webdav-provider.test.ts` runs against the maintainer's WsgiDAV image, pinned to
`sha256:53573e6705ed6fda1451713b160ca08b28238b19d016056f4bc4d67c954c59c7`. The fixture starts one anonymous development
share on an ephemeral port, limits it to 512 MiB and one CPU, drops capabilities, uses no host data mounts or ambient
credentials, and awaits disposal. The observed server identifies as WsgiDAV 4.4.0. Tests cover real PROPFIND,
collection-slash normalization, range/If-Match reads and stale conflicts, PUT create conditions, COPY/MOVE/DELETE and
filesystem replacement with append refusal. The same server also proves the independent `openHttpSource()` HEAD and
conditional-range path. This does not verify production authentication, CORS, TLS termination, lock middleware,
arbitrary WebDAV extensions, replication or every vendor implementation.

The protocol source is [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918). The development server comes from the
[WsgiDAV maintainer's image repository](https://github.com/mar10/docker-wsgidav). Review a replacement image digest and
rerun these exact workflows before upgrading the fixture. Native WebDAV, its OPFS projection and an archive preview are
separate contracts; support for one does not imply support for the others.
