---
"@okikio/opfs": minor
---

Read and write bounded Netlify Blobs objects through an explicitly configured first-party client. Applications supply
Fetch, an account API authority, site, store, bearer and permission to use each negotiated data URL. Account credentials
stay on the API request; signed data requests never inherit that bearer, even on the same origin. No production Netlify
SDK dependency, environment discovery, filesystem adapter or background retry is added.

The client follows the API exchange observed in SDK 11.1.7 under the explicit profile `netlify-blobs-11.1.7-api-v1`.
This is versioned wire compatibility, not a stable Netlify REST specification or complete SDK parity. The first profile
supports owned full-byte GET/PUT, HEAD, one listing page and unconditional DELETE.

The authored benchmark compares a 128 KiB owned-array copy with the client's two-request GET and PUT against an
in-memory transport. Full-byte checks run outside timing; labels report requests, response bytes and body-read steps.
These workloads have different validation costs and do not measure the official SDK or live Netlify service. Benchmark
preflight passed its full-byte correctness checks; numerical results are not reported here.

This complete function creates a small report only if absent. The application supplies its actual approved data origin;
an unrecognized signed URL is refused before the payload request starts.

```ts
import { createNetlifyClient, NETLIFY_PROFILE } from "@okikio/opfs/netlify";
import type { FetchType } from "@okikio/opfs/netlify";

export async function createReport(
  site: string,
  token: string,
  dataOrigin: string,
  fetch: FetchType,
  bytes: Uint8Array,
  signal: AbortSignal,
) {
  const client = createNetlifyClient({
    profile: NETLIFY_PROFILE,
    api: "https://api.netlify.com",
    site,
    store: "reports",
    token,
    fetch,
    authorizeDataURL: (url) => new URL(url).origin === dataOrigin,
  });
  return await client.put("daily/report.bin", bytes, { condition: { kind: "new" }, signal });
}
```

The default policy copies at most 1 MiB of object bytes and limits JSON, headers, metadata, entries, requests, response
bytes and body-read attempts. Each operation has a deadline and joins owned request/body cleanup. Injected Fetch must
honor AbortSignal and must not add hidden mutation retries. These are implementation safety limits, not service quotas
or exact heap measurements.

PUT conditions stay on the final data request. A 409/412 conditional response reports `modified: false` as that final
observation; it does not prove that previous attempts left the object unchanged. A dispatched mutation without an
admitted completion throws `NetlifyPublicationError` with outcome `unknown`. A known acknowledgement followed by cleanup
or admission failure throws `NetlifyCompletionError` with the retained receipt. Applications reconcile uncertain keys
before retrying.

ETag and size observations remain optional. Metadata reads return bounded JSON as `unknown`; metadata writes remain
outside this first profile even though Node-local Unicode reads passed. Keys use a deliberate ASCII segment subset,
while listing preserves broader native identities without promising they can be read through that subset. There are no
ranged reads, stable remote byte sources, authentication guarantees, resumable uploads or ObjectDriver semantics in this
profile.

The source and export map are implemented. Authored request tests passed in Deno, Node and Bun, and a separately
admitted candidate passed reciprocal full-byte checks against the official Node SDK/local server. The extracted package
passed Node/Deno/Bun consumers, strict declarations, import safety and selective adoption with all 171 exports checked.
CI results are recorded against exact commits on the pull request. The local fixture does not qualify a production
Netlify deployment, browser SDK fallback, range source or filesystem driver. See the [Netlify guide](../docs/netlify.md)
for the two-request diagram, complete recovery function and implementation limits.
