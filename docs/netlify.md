# Read and write one Netlify Blobs store

The implemented `@okikio/opfs/netlify` client copies one bounded blob at a time and preserves native acknowledgements.
Its source and public export map are present, and its narrow local SDK-wire profile passed reciprocal tests against
the official SDK and local server. Installed-package checks passed in Node, Deno and Bun. It does not mount a filesystem
or load the Netlify SDK. An application supplies its account, transport and permission to use negotiated
data URLs.

For example, this complete function creates a small report only if the key is absent, then reads its bytes. Its caller
supplies the site, account token, transport and actual data authority approved for that deployment.

```ts
import { createNetlifyClient, NETLIFY_PROFILE } from "@okikio/opfs/netlify";
import type { FetchType } from "@okikio/opfs/netlify";

export async function saveReport(
  site: string,
  token: string,
  approvedDataOrigin: string,
  fetch: FetchType,
  signal: AbortSignal,
) {
  const blobs = createNetlifyClient({
    profile: NETLIFY_PROFILE,
    api: "https://api.netlify.com",
    site,
    store: "reports",
    token,
    fetch,
    authorizeDataURL(url, request) {
      return new URL(url).origin === approvedDataOrigin &&
        (request.method === "GET" || request.method === "PUT");
    },
  });
  const receipt = await blobs.put("daily/report.txt", new TextEncoder().encode("Ready\n"), {
    condition: { kind: "new" },
    signal,
  });
  if (!receipt.modified) return { receipt, read: { state: "not-requested" as const } };
  try {
    const result = await blobs.get("daily/report.txt", { signal });
    return { receipt, read: { state: "completed" as const, result } };
  } catch (cause) {
    return { receipt, read: { state: "failed" as const, cause } };
  }
}
```

The application owns `site`, `token`, `approvedDataOrigin`, Fetch and cancellation. Construction does not read
environment variables, contact Netlify or call `authorizeDataURL`. A later read failure retains the known write receipt
in the function's result. Fetch must honor the supplied AbortSignal, settle after abort and avoid hidden mutation
retries. A wrapper that races an uncooperative Fetch against a timer cannot establish that its request stopped; this
client instead awaits the owned request's settlement.

The profile is **`netlify-blobs-11.1.7-api-v1`**. It follows the API route observed in SDK 11.1.7 at
[revision e85a36b](https://github.com/netlify/primitives/blob/e85a36b11c821f043ed7d9f4f0c5f79f8c599b76/packages/blobs/src/client.ts),
with explicit admission and ownership rules. This is versioned SDK wire compatibility, not a stable public REST
specification or byte-for-byte parity with every SDK feature. It excludes runtime edge routing, deploy stores, automatic
retries and signed-URL refresh.

## Follow the two requests

GET and PUT first negotiate a signed data URL through the account API. The negotiation uses the same HTTP method and
`Accept: application/json;type=signed-url`, but sends no object payload or conditional header. The application must
approve the returned URL before the second request can start. The account bearer stays on the API request; it is never
attached to the signed request, even when both URLs share an origin.

```mermaid
sequenceDiagram
  participant App as Application
  participant Client as Netlify client
  participant API as Account API
  participant Data as Approved data URL
  App->>Client: put(key, copied bytes, condition)
  Client->>API: PUT, bearer, signed-URL Accept; no payload
  API-->>Client: JSON URL
  Client->>App: authorizeDataURL(URL, method and key)
  App-->>Client: literal true
  Client->>Data: PUT bytes and condition; no account bearer
  Data-->>Client: Final status and optional ETag
  Client-->>App: Known receipt after response cleanup
```

Read the diagram from top to bottom as one acknowledged PUT. The application owns permission to use the data URL; the
client owns the copied payload and both response lifetimes. The final acknowledgement concerns the data PUT, not the
earlier URL negotiation. Lost replies and failures after acknowledgement follow the recovery rules below.

Authorization is synchronous and requires the literal boolean `true`. Accidentally returning a Promise or another truthy
value refuses the request. Data URLs must already have their canonical URL spelling, without userinfo, fragments or
unescaped whitespace. The client does not rebuild signed queries. Redirects are refused. HTTPS is required unless an
explicit `allowHttp` fixture grant is supplied; that grant does not bypass data URL authorization.

HEAD, DELETE and listing stay on the account API. Store `reports` becomes the native `site:reports` route segment. Keys
are provider keys rather than filesystem paths. This first profile accepts ASCII segments beginning with a letter,
digit, `_` or `-`, followed by those characters or `.`, separated by `/`. It refuses dot segments, percent escapes,
Unicode, empty segments and query/fragment delimiters before dispatch. The 600-byte key and 64-byte store ceilings do
not mean the provider itself has this narrow character restriction. Listed keys can contain broader valid Unicode;
listing one does not make it eligible for a GET through this initial profile.

## Interpret results without filling in missing evidence

| Operation                               | Result and meaning                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `head(key)`                             | `absent`, or `present` with optional size/ETag and decoded metadata. Missing size does not trigger a GET. This profile accepts only 200/404, not unsolicited HEAD 304.         |
| `get(key, { etag })`                    | `absent`, cache `not-modified`, or `present` with owned bytes and their measured size. The ETag option sends `If-None-Match` only to the data URL; it is not a revision guard. |
| `list({ prefix, directories, cursor })` | One page of keys, optional ETags, directory names and an optional opaque continuation cursor. There are no required sizes, page-size parameter or hidden later requests.       |
| `put(key, bytes, { condition })`        | Final modification observation, known input size, status and optional ETag. `{kind:"new"}` sends `If-None-Match: *`; `{kind:"match", etag}` sends `If-Match`.                  |
| `delete(key)`                           | An unconditional 200/204/404 acknowledgement. It does not identify a deleted revision or prove the key stays absent under concurrent writes.                                   |

The
[pinned SDK store](https://github.com/netlify/primitives/blob/e85a36b11c821f043ed7d9f4f0c5f79f8c599b76/packages/blobs/src/store.ts)
maps conditional PUT 409/412 to `modified: false`, conditional successful 2xx to `modified: true`, and unconditional PUT
success only to 200. This client preserves those distinctions without retrying. `modified: false` describes that final
response; it does not establish that no earlier caller or SDK attempt published data. Repeating a mutation after losing
its successful reply can produce a conditional refusal while the earlier data exists.

The SDK's list code also admits 204 before attempting to parse JSON. That does not establish an empty-page contract.
This first client requires a JSON 200 or an absent 404, and refuses 204 explicitly. A failed GET negotiation remains an
API failure, including 404; only a final data 404 is an admitted `absent` result. No extra request probes missing keys
to guess which phase failed.

Metadata is bounded `unknown` JSON, not a string-only object map. Reads accept the external `netlify-blobs-metadata`
header before `x-amz-meta-user`, canonical base64 after `b64;`, strict UTF-8 and finite bounded JSON structure. Missing
or unrecognized prefixes yield `{}` as in the pinned SDK. Metadata writing is deferred. The SDK's Node runtime utility
uses UTF-8 base64 while its browser fallback uses `btoa`; a Node oracle cannot prove that fallback's Unicode behavior.
No metadata byte sequence is executable configuration, authentication evidence or a codec registration.

## Bound work and retain the publication outcome

Defaults admit a 1 MiB copied PUT or complete GET, 64 KiB per negotiation/list JSON response, 32 KiB response headers, 2
KiB encoded metadata, 1,000 list entries, 2 MiB total response bytes, two requests, 65,536 body-read attempts and a
30-second operation deadline. Limits are configurable finite safety policy, not service quotas. Body-read attempts
include empty chunks and EOF across both responses, so alternating tiny and empty chunks cannot hide unlimited parser
work. The client copies input before reading foreign PUT option getters. Response bytes accumulate in a bounded
contiguous buffer rather than retaining one object or a large foreign backing allocation per chunk. Buffer growth and
the final exact-length copy can temporarily retain multiple bounded byte arrays; these limits do not measure exact heap
usage.

Every returned `work` reports concrete requests, observed response bytes and body-read attempts. A failed chunk can
exceed the admitted response budget and is counted before refusal. No implicit retries, backoff timers, connections, SDK
resources or background cleanup workers are created. The operation owns and clears its one deadline timer. It borrows
the application AbortSignal, joins response cancellation and releases reader locks before settling.

```ts
import { NetlifyCompletionError, NetlifyPublicationError } from "@okikio/opfs/netlify";
import type { NetlifyClient } from "@okikio/opfs/netlify";

export async function replaceReport(blobs: NetlifyClient, bytes: Uint8Array, signal: AbortSignal) {
  try {
    const receipt = await blobs.put("daily/report.txt", bytes, { signal });
    return { state: "acknowledged" as const, receipt };
  } catch (error) {
    if (error instanceof NetlifyCompletionError) {
      return { state: "completion-failed" as const, receipt: error.receipt, cause: error.cause };
    }
    if (error instanceof NetlifyPublicationError) {
      return { state: "unknown" as const, key: error.key, cause: error.cause };
    }
    throw error;
  }
}
```

This recovery function reuses an application-owned client and performs one bounded PUT. The caller saves returned
receipts and schedules reconciliation for `unknown`; the function never retries or starts a background task. A caller
that persists recovery state owns that separate operation and its failure policy.

A transport failure after final PUT or DELETE dispatch is unknown until an admitted native completion exists. Unexpected
negative HTTP statuses are conservatively unknown for mutations too; receiving an error response alone is not a rollback
guarantee. A known successful status or conditional refusal is retained before parsing headers or retiring its body.
Later admission, abort or cleanup failure becomes `NetlifyCompletionError` with that receipt. Errors keep causes;
library-owned messages omit tokens, signed queries and response text. Applications own how they log foreign causes.

This profile offers no stable remote byte-range source, authenticated content, upload session, resumable stream,
filesystem directory or ObjectDriver contract. A bounded successful GET can be copied into an immutable local byte
source separately, with the full-download cost visible. The
[Netlify expansion plan](https://github.com/okikio/opfs/blob/codex/release-2026-10-06/planning/storage/NETLIFY.md)
records the independent SDK/server fixture, its admission boundary and the further evidence needed for broader support.

The authored tests in `tests/netlify.test.ts` exercise request construction, bounded parsing and failure ownership.
They passed in Deno, Node and Bun; those injected peers are not independent service proof. Separately, the official
SDK 11.1.7/local-server fixture passed empty and 128 KiB full-byte comparisons in both directions, Unicode metadata
reads, conditions, credential separation and lost-reply reconciliation. Its exact candidate bundle and retained run are
recorded in the
[fixture guide](https://github.com/okikio/opfs/blob/codex/release-2026-10-06/tests/fixtures/netlify/README.md).
That Node-local result does not establish live
service, browser SDK fallback or production consistency behavior. The extracted npm artifact passed all 171 export
checks, Node/Deno/Bun consumers, strict declaration consumers, browser bundling, import safety and selective adoption.
CI is a separate delivery gate; the [pull request checks](https://github.com/okikio/opfs/pull/1/checks) identify the exact
commit they tested.
