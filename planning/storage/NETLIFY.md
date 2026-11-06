# Proposed native Netlify Blobs client

This is a research decision for maintainers continuing `netlify-blobs`, not shipped support. Implement a small,
import-safe native client before considering a driver, filesystem adapter or archive source. The useful first flow is:
the application supplies one site/store and credentials, reads a bounded blob, conditionally replaces it, and retains
the provider outcome. The application owns authorization, retries and recovery after an uncertain mutation.

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

This review inspected the retained source copies under ignored `.tmp/implementation/netlify-*-pinned.ts`. Fresh
retrieval of these pinned GitHub files failed during this review; current public documentation was reachable. Registry
gitHead and a source-copy hash do not prove published tarball equivalence. Admit the exact package bytes, generated
entrypoints and packaged licenses before executing an SDK oracle. The prior dependency-resolution receipt reports
`partial-copyout:external-nonzero`; it is not a completed artifact-admission result. Prior admission-unit success proves
only the exercised behavior of that earlier tooling, not the SDK closure or service.

## Proposed first client boundary

Use a portable module with injected Fetch and explicit site, store, API origin and authentication inputs. Construction
does not inspect environment variables, import an SDK, discover accounts or perform requests. A separately named host
factory may acquire Fetch when called. Keep URL selection, bounded response admission and outcome parsing independently
readable and testable.

The proposed first profile uses explicit API access, not ambient runtime edge context. The inspected SDK routes
account-authorized requests through `/api/v1/blobs/{site}/{store}`; `{store}` includes the native `site:` prefix for a
site-wide store rather than just the application's display name. HEAD, DELETE and listing stay on the API. Keyed GET/PUT
first negotiate JSON using `Accept: application/json;type=signed-url`, then use the returned capability URL. The account
bearer must remain confined to the configured API authority; it must not accompany the signed data request. Require
HTTPS, no URL userinfo or fragment, explicit capability-URL authorization and refused redirects. Local HTTP is an
explicit fixture-only grant. Never log tokens or signed queries. Preserve the signed URL's query without rebuilding its
signature. Do not copy the SDK's automatic retry or signed-URL refresh into this client: a lost PUT reply can mean
publication succeeded.

Start with bounded full-byte GET, HEAD, single-page listing with opaque cursor, payload PUT with either create-only or
ETag-match conditions, and explicit DELETE. The inspected store maps conditional PUT 409/412 to a non-modified result;
DELETE admits 200/204/404. Represent absence, not-modified cache reads, precondition refusal and unknown mutation
outcomes distinctly. The SDK uses `If-None-Match` for cached reads; that is not an immutable-version read guard.
Establish exact response/status/metadata schemas from admitted source and differential captures before freezing public
types. Arbitrary metadata writing and deploy stores can follow as separate profiles.

For the first profile, propose ordinary ASCII path segments beginning with an alphanumeric, `_` or `-`, followed by
alphanumerics, `_`, `-` or `.`, separated by `/`. Apply the documented byte ceilings. This deliberately excludes empty,
dot-only, percent, query, fragment, backslash and Unicode vectors until their wire identity is proven. The inspected SDK
interpolates keys into URLs without explicit component encoding. Blind copying can change key identity through URL
normalization; silently encoding differently does not prove compatibility either. Capture SDK request URLs and actual
stored/listed identities for those excluded vectors before expanding the subset.

Use finite per-operation source/response/JSON/header and request-count limits, exact body lengths, cancellation and
owned byte snapshots. An initial 1 MiB payload ceiling is a proposed implementation policy, not Netlify's service limit.
No automatic credential refresh, cleanup worker or mutation retry starts in the background.

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
files or stub those imports and call it the official oracle. First finish exact closure resolution, SRI/hash and license
admission, inspect package entrypoints and scripts, then review the test-only closure under the dependency policy. No
production SDK dependency is proposed. Prior scratch admission tools are historical research; maintained replacement
tooling must be TypeScript and retain bounded transport, filesystem and subprocess ownership.

Only after admission, run one root-owned Testcontainers lane with explicit disposable credentials/directory, pinned Node
image, no external execution-time network, memory/swap and PID ceilings, bounded diagnostics and verified cleanup. Do
not infer memory feasibility from package size; the official local server buffers bodies. Live service testing needs an
explicitly supplied disposable site/store and caller-owned credentials; this research makes no paid request.

The next concrete slice is therefore **admit and qualify the independent SDK/local-server fixture, then freeze the
bounded native-client profile above**. Production code waits for artifact admission and key-identity captures. Remote
range sources, resume, deploy namespace, generic filesystem projection and strong live-service claims each retain their
own unresolved gate. Follow [GROUPS](GROUPS.md#object-native) without rewriting historical catalog records.
