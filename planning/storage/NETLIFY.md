# Netlify Blobs client and remaining expansion

This records the implemented first-party client and remaining decisions for maintainers continuing `netlify-blobs`.
This is not a released-support claim. The useful first flow is:
the application supplies one configured store, reads a bounded blob, conditionally replaces it, and retains the provider
outcome. The independent SDK/local-server and reciprocal candidate qualification gates have passed for the narrow local
profile. Extracted-package consumers passed; exact-commit CI is a separate delivery gate. A driver over a caller-owned public SDK store is an
alternative to owning Netlify's undocumented HTTP exchange. Neither route currently supplies a filesystem adapter or
archive source. The application owns authorization and recovery after an uncertain mutation.

## Evidence and its limits

The [catalog](research/catalog.json) preserves the original proposed provider route. Current
[Netlify documentation](https://docs.netlify.com/build/data-and-storage/netlify-blobs/) describes named and
deploy-scoped stores, configurable consistency, conditional writes and ETags. It documents nonempty Unicode keys up to
600 bytes, store names up to 64 bytes without `/` or `:`, objects up to 5 GB and metadata up to 2 KB. These service
limits are not appropriate local allocation defaults. Documentation does not establish a stable raw REST specification,
guarded range reads or resumable upload sessions.

The [old `netlify/blobs` repository](https://github.com/netlify/blobs) explicitly says it does not contain the SDK
source. The retained research instead identifies `@netlify/blobs` 11.1.7, registry gitHead
`e85a36b11c821f043ed7d9f4f0c5f79f8c599b76`, in the `netlify/primitives` monorepo. Inspect these pinned primary files:

| Source                                                                                                                        | Contract to preserve                                                | SHA256 of retained source copy                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [client.ts](https://github.com/netlify/primitives/blob/e85a36b11c821f043ed7d9f4f0c5f79f8c599b76/packages/blobs/src/client.ts) | API/edge routing, signed data URLs and credential separation        | `244100353049bbaa71aa2649f32722c27d6fa331f515428ff0a2cf2a0ce96833` |
| [store.ts](https://github.com/netlify/primitives/blob/e85a36b11c821f043ed7d9f4f0c5f79f8c599b76/packages/blobs/src/store.ts)   | Conditional writes, conditional cache reads and opaque list cursors | `e1366bc1e21074d5f711d31cbcb674d6f57e56fb0200739492530a0c3c60e4ee` |
| [server.ts](https://github.com/netlify/primitives/blob/e85a36b11c821f043ed7d9f4f0c5f79f8c599b76/packages/blobs/src/server.ts) | Official local server behavior and its proof limits                 | `84b6b2cf6c151a51561604121d06668261a4bf731ae88aa935b9d62106deb7b5` |

The 2026-11-06 follow-up retrieved pinned official source successfully and checked the
[registry's exact 11.1.7 manifest](https://registry.npmjs.org/@netlify/blobs/11.1.7). Its `gitHead` remains the revision
above, its Node requirement is `>=22.12.0`, and it exports both the SDK and `./server`. A streamed read of the
[published tarball](https://registry.npmjs.org/@netlify/blobs/-/blobs-11.1.7.tgz) matched registry integrity:

```text
sha512-iOOQSC990P5JtvBGfPMngRxId9H7FWJWAZrzGyYWanCreYElkU5VjoTBt0DgJE859ukNGHAwULZlOdiYHESHfA==
```

The tarball contains 13 entries, including `package/LICENSE` with Netlify's MIT license, the generated SDK/server
entrypoints and their shared chunk. This verifies the inspected root archive's identity; it does not establish source
build reproducibility or admit its transitive dependencies. The exact direct dependencies are runtime-utils 3.0.0,
dev-utils 6.0.4 and a declared otel range `^7.0.6`; the implemented test fixture pins otel to 7.0.6 rather than accepting a
floating future resolution. Their public entrypoints pull in further runtime dependencies.

The historical `opfs-netlify-acquire-resolve-third/receipt.json` under ignored `.tmp/implementation/` lists 47
package-version metadata records. It reports `partial-copyout:external-nonzero`, and the closure file did not survive
copyout. Its recorded closure SHA256, `7927cbfee9ffc455b0d64d16a715597d5e81909d2d01347b2cd7c5219c8220ce`, is a receipt
observation, not retained, independently checked closure bytes. Neither this receipt nor earlier admission-unit success
admits the packages. The maintained TypeScript acquisition stage instead freezes all runtime, optional and peer edges,
verifies each archive's SRI and packed manifest, retains licenses/notices, inspects public entrypoints and refuses
lifecycle execution. SDK development dependencies such as its build system, Vitest and test-utils are outside the
fixture.

## The implemented HTTP profile owns a versioned compatibility boundary

The current [official OpenAPI](https://github.com/netlify/open-api/blob/master/swagger.yml) has no Blobs CRUD paths; the
public Blobs documentation describes SDK methods. The HTTP routes below are observations of the pinned SDK, not a
verified stable public REST standard. The implemented first-party client explicitly selects
`netlify-blobs-11.1.7-api-v1` as its reviewed source-compatibility policy. The local qualification supports that narrow
choice; it does not resolve production REST stability or imply complete SDK parity.

The portable `src/netlify.ts` module takes injected Fetch and explicit site, store, API origin and authentication inputs. Construction
does not inspect environment variables, import an SDK, discover accounts or perform requests. A separately named host
factory may acquire Fetch when called. Keep URL selection, bounded response admission and outcome parsing independently
readable and testable.

The implemented first profile uses explicit API access, not ambient runtime edge context. The inspected SDK routes
account-authorized requests through `/api/v1/blobs/{site}/{store}`; `{store}` includes the native `site:` prefix for a
site-wide store rather than just the application's display name. HEAD, DELETE and listing stay on the API. Keyed GET/PUT
first negotiate JSON using `Accept: application/json;type=signed-url`, then use the returned capability URL. The account
bearer must remain confined to the configured API authority; it must not accompany the signed data request. Require
HTTPS, no URL userinfo or fragment, explicit capability-URL authorization and refused redirects. Local HTTP is an
explicit fixture-only grant. Never log tokens or signed queries. Preserve the signed URL's query without rebuilding its
signature. Do not copy the SDK's automatic retry or signed-URL refresh into this client: a lost PUT reply can mean
publication succeeded.

It provides bounded full-byte GET, HEAD, single-page listing with opaque cursor, payload PUT with either create-only or
ETag-match conditions, and explicit DELETE. The inspected store maps conditional PUT 409/412 to a non-modified result;
DELETE admits 200/204/404. Represent absence, not-modified cache reads, precondition refusal and unknown mutation
outcomes distinctly. The SDK uses `If-None-Match` for cached reads; that is not an immutable-version read guard.
Response/status/metadata admission follows the inspected SDK source and the local controls described below. Local
listing does not qualify production cursor behavior. Arbitrary metadata writing and deploy stores remain separate future profiles.

The first profile admits ordinary ASCII path segments beginning with an alphanumeric, `_` or `-`, followed by
alphanumerics, `_`, `-` or `.`, separated by `/`. Apply the documented byte ceilings. This deliberately excludes empty,
dot-only, percent, query, fragment, backslash and Unicode vectors until their wire identity is proven. The inspected SDK
interpolates keys into URLs without explicit component encoding. Blind copying can change key identity through URL
normalization; silently encoding differently does not prove compatibility either. Capture SDK request URLs and actual
stored/listed identities for those excluded vectors before expanding the subset.

Use finite per-operation source/response/JSON/header and request-count limits, exact body lengths, cancellation and
owned byte snapshots. Its default 1 MiB payload ceiling is implementation policy, not Netlify's service limit.
No automatic credential refresh, cleanup worker or mutation retry starts in the background.

## Alternative: borrow the public SDK store

The caller can install and configure `@netlify/blobs`, then supply an object exposing only the public store methods the
driver uses. The proposed OPFS module would describe that structural TypeScript capability and import no runtime SDK.
The SDK remains the external client that owns the wire protocol. The driver owns its admitted key profile, limits,
returned-byte ownership, provider outcomes and inspection metadata. An adapter would translate those mechanics into
filesystem primitives only after the remaining semantic gaps are resolved. This is not a proposed first-party client
whose only job is forwarding SDK calls.

The [published SDK declarations](https://registry.npmjs.org/@netlify/blobs/-/blobs-11.1.7.tgz) expose
`getStore({ name, siteID, token, apiURL, fetch })`. Configuration and any injected Fetch policy belong to the caller.
Construction of a borrowed driver must bind methods without invoking them, acquire no credentials, and retain no ambient
store registry. It must not call a store-wide cleanup operation when disposed. The public SDK has no store `close()`
method; only streams or iterators explicitly obtained by the driver can become its resources. Require an explicit
caller-declared site/store identity without tokens. The opaque store object does not expose a public
namespace-inspection method, so this label is caller authority, not an independently discovered namespace.

| Public capability                               | Useful driver behavior                                                  | Required restriction                                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `getMetadata(key)`                              | Observe absence or ETag and user metadata                               | No object byte length, immutable version or last-modified time is returned. An ETag is an opaque condition, not a digest.          |
| `getWithMetadata(key, { type: "stream" })`      | Return owned, bounded payload streaming with its observed ETag/metadata | Do not pass the cache `etag` option as a read revision guard. A cache hit can return null data, and no `If-Match` read is exposed. |
| `set(key, arrayBuffer, { onlyIfNew: true })`    | Request creation only when absent                                       | `modified: false` reports the final SDK condition result, not proof that an earlier SDK attempt did not publish.                   |
| `set(key, arrayBuffer, { onlyIfMatch: etag })`  | Replace only the matching ETag                                          | Require a nonempty opaque ETag. Do not implement arbitrary `ifNoneMatch` values or combine both conditions.                        |
| `delete(key)`                                   | Idempotent unconditional removal                                        | Success includes an already absent key. There is no conditional delete or deleted-revision receipt.                                |
| `list({ prefix, directories, paginate: true })` | Read SDK pages without collecting the entire store                      | The SDK owns the continuation cursor and accepts no page-size bound. Entries expose key/ETag, not required object sizes.           |

These are source-verified public SDK semantics, not native fixture results. Use the pinned
[store implementation](https://github.com/netlify/primitives/blob/e85a36b11c821f043ed7d9f4f0c5f79f8c599b76/packages/blobs/src/store.ts)
when qualifying them. Arbitrary JSON metadata must remain native data or undergo explicit validation before entering a
string-only object metadata contract. Streamed SDK reads do not imply streamed SDK writes: its public `set` accepts a
string, ArrayBuffer or Blob. The first proposed write profile snapshots bounded bytes and preserves their known input
length with a successful acknowledgement. It does not obtain a later HEAD and attribute that observation to the write.

Raw keys must remain provider keys. Do not normalize them as filesystem paths, trim Unicode or silently escape a
different spelling. The documented key set is broader than the initial qualified ASCII subset above. SDK validation and
URL construction alone do not prove that dot segments, percent escapes, query/fragment characters and Unicode retain
their stored/listed identity. Before expanding the subset, capture SDK requests and independently compare the bytes
written, read and listed. A native driver can reject unqualified keys before invoking the borrowed store without
claiming the provider rejects them.

The public methods accept no AbortSignal or per-call deadline. The pinned
[retry implementation](https://github.com/netlify/primitives/blob/e85a36b11c821f043ed7d9f4f0c5f79f8c599b76/packages/blobs/src/retry.ts)
also retries thrown Fetch failures and selected statuses, with up to five retries and delayed signed-URL refresh.
Therefore a borrowed store alone cannot promise cancellation of underlying requests, a finite request budget or
exactly-once publication. Racing its promise against a timer would leave foreign work running. The driver must report
this requirement and refuse a profile that promises stronger cancellation unless the caller supplies separately
qualified transport/lifetime control. It may check cancellation before invocation and cancel a returned owned stream;
that does not retroactively cancel SDK retry timers or an outstanding mutation.

Once `set` or `delete` is invoked, an exception or cancellation without a completed result conservatively means an
unknown mutation outcome. Preserve the cause and do not retry in the driver. A completed `modified: false` is a known
final SDK condition result. It does not establish that this entire call performed no write: an earlier conditional PUT
could publish, lose its reply, and then fail its original condition when the SDK retries. The pinned retry and condition
code predicts this behavior, and the independent local SDK control now observes it. Do not translate that result into a
no-publication receipt without separately qualified attempt evidence. The local SDK oracle now demonstrates this exact
lost-reply case: one successful publication, a retry, then `modified: false`, with the original full bytes read back. A
completed `modified: true` is a known acknowledgement, not proof of one transport attempt or of indefinite retention.
Preserve that acknowledgement if later driver-owned resource retirement fails. The caller owns SDK retries, credentials,
transport retirement and reconciliation of any late result.

This SDK store is **not a drop-in `ObjectDriverType`**. Its required `head` result needs a byte size, every list entry
needs a size, and its list contract accepts a caller cursor and limit. The SDK does not expose these together.
Downloading a bounded full object could calculate an observed size, but that adds full-read cost and cannot be presented
as cheap metadata. Retaining iterators or materialized local snapshots to invent caller cursors would require an
explicit stateful ownership, expiry and memory policy. A list ETag must not be combined with the size of an unguarded
later read as though they describe one revision. Revision-bound GET/DELETE, native range reads, copy and resumable
writes likewise remain unsupported. The next design decision is a narrowly typed native capability driver, or an
intentional extension of the generic object contract. Do not publish a nominal object driver or attach a filesystem
adapter to hide these gaps.

## Consistency, preview and resumption remain separate gates

The SDK selects an uncached edge endpoint for strong edge reads and refuses that mode without the endpoint. API-path
requests have no corresponding consistency header in the inspected source. Report the selected native route instead of
inventing an API strong-read guarantee. A local server cannot establish production edge propagation behavior.

Neither inspected SDK reads nor its local server establish conditional ranged reads: the local GET materializes the
whole file and does not implement Range/If-Match handling. Its generated ETag uses path/mtime, which is not a content
digest. Do not expose a provider-stable `ByteSourceType`, advertise native range reads or use an ETag as authenticity
evidence from these observations. A separately owned, fully downloaded bounded byte snapshot can supply immutable local
ranges, with its whole-download cost disclosed. Remote preview needs independent evidence of exact 206 extents,
identity-guard enforcement and rejection after replacement.

PUT accepting a stream does not establish acknowledged offsets, session identity or restart recovery. No resumable
destination or checkpoint format is proposed until an actual provider contract supplies those properties. A retry after
an uncertain write remains caller-owned reconciliation, not continuation. Filesystem publication and directory semantics
likewise require a later driver/adapter decision.

## Independent fixture and decisive implementation gates

The smallest credible local oracle is the public SDK plus its public `./server` entrypoint, isolated from candidate
imports. It is JavaScript service tooling, not a native C executable. Use original binary/empty/128 KiB vectors in both
directions, full-byte comparisons, metadata/ETag receipts, create-only and stale-match refusals, list cursors, wrong
authentication and capability-origin refusal. The local server cannot qualify production pagination, atomic races, cache
consistency, range guards, signed-URL expiry or durability. Authored request tests cover malformed replies and unknown
outcomes; they do not become independent provider proof.

The public entrypoints depend on runtime-utils, dev-utils and otel, with further dependencies. Do not load private SDK
files or stub those imports and call it the official oracle. Exact closure resolution, SRI/hash and notice retention
preceded the explicit test-only execution review; package entrypoints and scripts were inspected without installing or
running package lifecycle hooks. No
production SDK dependency is proposed. Prior scratch admission tools are historical research; maintained replacement
tooling must be TypeScript and retain bounded transport, filesystem and subprocess ownership.

Only after admission, run one root-owned Testcontainers lane with explicit disposable credentials/directory, pinned Node
image, no external execution-time network, memory/swap and PID ceilings, bounded diagnostics and verified cleanup. Do
not infer memory feasibility from package size; the official local server buffers bodies. Live service testing needs an
explicitly supplied disposable site/store and caller-owned credentials; this research makes no paid request.

The fixture awaits the public `BlobsServer.start()` before emitting its authored ready marker and awaits `stop()`
before container retirement. Run SDK oracle and candidate invocations inside that isolated container so capability URLs
minted for its localhost remain valid without rewriting signed URLs. Qualify SDK writes followed by candidate reads,
candidate conditional writes followed by SDK reads, create-only/ETag refusal, absence, deletion and listing. Authored
transport tests separately cover malformed replies, cancellation boundaries, retry-policy limits and unknown outcomes.
This route needs no production credentials. It cannot establish live edge propagation or production durability.

The final delivery gate is **verify current-head CI for the locally qualified first-party
`netlify-blobs-11.1.7-api-v1` client**. The narrow HTTP profile is a deliberate compatibility choice, not a claim that
the SDK's private HTTP exchange has become a public service standard. Remote range sources, resume, deploy namespace,
generic filesystem projection and strong live-service claims each retain their own unresolved gate. Follow
[GROUPS](GROUPS.md#object-native) without rewriting historical catalog records.

The inert 46-package acquisition passed in run `1a62180a-cbeb-4346-9415-e805c4c14156`, with closure SHA256
`1b975c457b7f2a0b890f28325f041cfc5b9f9573f33a4829dc615e13422c1ec9`. After separate offline test-only execution review,
SDK observation run `3e785505-7179-4e1f-b448-b56ff45cc800` passed full empty/128 KiB originals, Unicode metadata through
GET and HEAD, native conditions, credential separation and the lost-reply retry control. Actual resource inspection
confirmed the 1 GiB memory/swap, CPU/PID and private-network recipe; retirement reported exit zero without Docker's
OOMKilled flag. This is one Node SDK/local-server implementation, not an independent production-service engine.

That run also exposed a local prefix-list parser defect. The pinned server's API regular expression admits the query
inside `store_name`; reconstructing the signed local URL appends another `?signature=` suffix to the effective prefix.
The fixture records only safe boolean comparisons of this corruption, observes the empty prefix result and requires both
original keys in an unfiltered listing. No production prefix, pagination, cache-validation or HEAD-size guarantee
follows from that server. Node's Buffer-based UTF-8 metadata encoding passed; the SDK's browser `btoa` fallback remains
outside this qualification.

The reciprocal runner checks a separately hash-admitted standalone candidate bundle before copying it into the private
container. SDK→candidate and candidate→SDK paths each compare full empty/128 KiB original bytes. Its other controls
cover Unicode read-only metadata, missing HEAD ETags and optional declared sizes, unfiltered listing,
create-only/stale/current ETag conditions, deletion, capability-origin refusal before data dispatch and a lost candidate
PUT acknowledgement with one attempt and SDK publication readback. Isolated run `bf81a0ee-fb7e-4f89-afe9-b7daee2758e6`
passed both SDK and reciprocal tests using candidate SHA256
`1b9453b981d441ee74cfc4c69d388a6a40356b2d41396fd2f1ce89605709667b`. Both servers retired with exit zero and without
Docker's OOMKilled flag. This is local SDK-wire compatibility, not production service, range, resume, driver or adapter
qualification. The extracted npm package passed all 171 exports, Node/Deno/Bun consumers, strict declarations,
browser bundling, import safety and selective adoption in isolated run `7c5fc551-cd24-4730-96bb-00e645a6db2b`.
The [pull request checks](https://github.com/okikio/opfs/pull/1/checks) record exact-commit CI results.
Fixture admission, commands and remaining proof limits are
in the [fixture guide](../../tests/fixtures/netlify/README.md).
