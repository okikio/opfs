# OCI registry content

OCI Distribution stores manifests and blobs inside named repositories. This client reads that content while keeping
mutable tag lookup, server assertions and complete digest verification distinct. It does not construct an image
filesystem, extract layers or verify publisher signatures.

```ts
import { OciClient } from "@okikio/opfs/oci";

const registry = new OciClient({
  registry: "https://registry.example/",
  repository: "team/artifact",
  headers: () => ({ authorization: "Bearer replace-with-your-registry-token" }),
});
const manifest = await registry.getManifest("release");
console.log(manifest.digest); // SHA-256 of this response's exact bytes; release can move later.
if (manifest.kind !== "manifest" || manifest.layers?.[0] === undefined) {
  throw new Error("Select a manifest with an appropriate blob descriptor first.");
}
const descriptor = manifest.layers[0];
const source = await registry.openBlobSource(descriptor.digest, {
  size: descriptor.size,
  maxBytes: 16 * 1024 * 1024,
});
console.log(source.stability); // immutable: the complete blob has already been fetched and verified.
console.log(await source.read(0, Math.min(source.size, 64)));
```

The application chooses a registry, repository, credentials and byte budgets. The header callback only receives admitted
registry requests; no Docker credential files, environment credentials or WWW-Authenticate token exchanges are
discovered. Importing or constructing `OciClient` performs no I/O. HTTPS is required by default. `allowHttp: true` is an
explicit policy for the application's own trusted private registry or fixture.

## Manifests and declarations

`getManifest(tagOrDigest, signal)` requests an OCI image manifest/index or the corresponding Docker schema-2
manifest/list representation. Tags use the native 128-character grammar and remain mutable. Requested content digests
must be lowercase `sha256:` followed by 64 hexadecimal characters. Unsupported reference algorithms are refused before
credential acquisition.

The client collects the exact response bytes within `maxManifestBytes` (8 MiB by default), computes SHA-256, and checks
a requested digest before fatal UTF-8 decoding or JSON parsing. It also checks a SHA-256 Docker-Content-Digest header
when present; headers using other algorithms are not treated as verification evidence. Content encoding must be
identity, Content-Length must be safe and consistent when present, and the representation's JSON mediaType must match
its Content-Type when supplied. A tag result's computed digest pins the returned bytes, not future tag lookups.

Returned `bytes` are an owned mutable array, and parsed fields describe their received state. If a consumer changes that
array, the earlier digest no longer verifies its modified bytes. Descriptor records expose media type, digest, safe byte
size, annotations and artifact type when present. Unknown descriptor media types and digest algorithms can remain
declarations; fetching unsupported digest algorithms is still refused. URL/data/platform extensions are not traversed or
interpreted. An index does not select a platform, and a manifest does not prove referenced blobs exist, that all content
was verified, that the publisher is trusted, or that a runnable image has been reconstructed.

## Streamed trust versus complete verification

`statBlob(digest)` uses HEAD and returns `{ digest, size, integrity: "server" }`. Its size is a server assertion. A
digest header or digest-shaped URL does not prove that the server actually holds the named bytes.

`getBlob(digest, { integrity: "server", at, length, signal })` streams complete content or one selected range. The
explicit `integrity: "server"` is mandatory because partial bytes cannot establish a complete blob digest. Range reads
require HTTP 206 with a finite Content-Range matching the requested extent; the end may clamp at EOF. A server that
ignores Range, changes the offset, reports an inconsistent length or encodes the response is rejected and its body
cancelled. A zero-length request is local and supplies no remote-existence evidence. The caller owns draining or
cancelling a successfully returned stream. This method supplies no immutable source identity or hash proof.

`readBlob(digest, { size, maxBytes, signal })` fetches and buffers the complete blob, then verifies its SHA-256.
Optional `size` binds it to a descriptor and must match the actual byte count. The default complete-blob budget is 64
MiB; `maxBytes` can lower the client's `maxBlobBytes` policy but cannot silently exceed it. A client can explicitly
raise that implementation policy up to 1 GiB. `maxManifestBytes` has an independent 64 MiB ceiling. These are memory
policies, not OCI provider size limits.

WebCrypto is a complete-buffer hash API. Collection retains source chunks and creates one joined allocation, and the
runtime can copy hash input internally. JSON decoding and descriptor mapping allocate additional memory. Byte ceilings
do not promise a matching peak heap ceiling or constant-memory verification. Large blobs should use server-trusted
streaming unless the application can afford complete buffering or supplies a separate reviewed streaming verifier.

`openBlobSource(digest, options)` performs the same complete size/digest verification and retains only its private
verified array. It returns an immutable `ByteSourceType` with identity `oci:<digest>`. Every range read checks exact
bounds, returns a new owned copy and performs no registry I/O. Mutating a returned extent cannot change later reads.
This is the safe composition point for archive readers when the blob's actual format is supported; compressed OCI layers
do not automatically become a merged filesystem view.

## Redirect and credential ownership

Blob GET/HEAD requests may follow at most `maxRedirects` (3 by default, at most 10), only to exact `redirectOrigins`
explicitly configured by the application. The default allowlist is empty. Userinfo, fragments, oversized URLs,
unsupported schemes, HTTPS downgrades and repeated URLs are refused. Manifest and tag-control redirects are refused.

The initial registry request can acquire application headers. Every redirected hop rebuilds only the selected range and
representation headers, even for a same-origin redirect. It does not call the auth callback or forward Authorization,
Cookie or custom application credentials. All requests set `credentials: "omit"`, `redirect: "manual"` and
`referrerPolicy: "no-referrer"`. Range selection is preserved across hops. A redirected URL's query may itself be a
secret capability; do not log it. Each rejected or followed redirect response is retired before another request is
acquired. Configuring an allowed origin trusts it with the selected blob request and any capability already supplied in
that redirect URL.

## Tags, limits and failures

`tagsPage({ pageSize, next, signal })` returns one bounded mutable tag page. `tags(options)` lazily follows pages within
`maxPages` (1000) and `maxTags` (100000). Page size defaults to 100 and cannot exceed 1000; tag-control JSON has the
shared 8 MiB encoded body ceiling. Continuations must remain on the exact selected repository's tag-list route and can
carry only admitted `n` and `last` query fields, before any credentials are acquired. Repeated continuation URLs raise
an error. Full older-server pages without Link continue using the last tag rather than silently claiming EOF.

This profile accepts one simple `Link: <url>; rel="next"` relation and rejects ambiguous or more elaborate Link syntax.
It prefers that server link to synthesizing a cursor. Listing is not a transactionally consistent inventory: tags can
move or disappear between pages. `OciError.status` reports HTTP failures without credential-bearing URLs or response
bodies. Shared read-request policy controls retries and timeouts; caller abort signals propagate to transport and owned
body collection. Failed bounds, decoding, size or hash checks do not yield a verified result.

Push, blob upload sessions, mounting, deletion, registry catalog, referrers (including their required legacy fallback),
platform selection, layer decompression, whiteout application, layer merging, publisher signatures and OCI filesystem
projection are outside this read-only profile.

## Evidence and primary sources

`tests/oci.test.ts` supplies injected protocol cases for exact raw-byte manifest hashing, invalid UTF-8, digest and
representation mismatch, body budgets and cancellation, trust-separated ranges, private snapshots, credential-free
redirects and constrained tag pagination. These cases pass in Deno, Node and Bun.

`tests/oci-provider.test.ts` uses Testcontainers to start the Docker Official Distribution registry 3.1.2 at an
ephemeral port, pinned to index digest `sha256:d4032d4cc323c1731c707931ecada07a53076eac38e3b61ae57533f170f2c6c3`. The
pin was confirmed with Docker buildx manifest inspection on 2026-11-05. An independent raw REST fixture uploads real
blobs and an OCI artifact manifest. Four Node cases pass against that service: digest/tag manifests,
HEAD/ranged/verified blob reads, immutable local ranges and real registry tag pagination. This proves the stated local
provider profile, not OCI certification, production authorization, cloud CDN policy or all registries.

Primary contracts: OCI [Distribution 1.1.1](https://github.com/opencontainers/distribution-spec/blob/v1.1.1/spec.md),
[image manifest 1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md),
[index 1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-index.md), and
[descriptor 1.1.1](https://github.com/opencontainers/image-spec/blob/v1.1.1/descriptor.md). The
[official registry image](https://hub.docker.com/_/registry) and
[upstream image metadata](https://github.com/docker-library/repo-info/blob/master/repos/registry/remote/3.1.2.md)
identify the independent provider fixture.
