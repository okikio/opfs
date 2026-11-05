# Preview one HTTP resource

Use `openHttpSource()` when an HTTP URL names one file. A URL does not imply a directory or a writable service. For
collections use the WebDAV client instead. This complete example reads five bytes from a caller-owned resource:

```ts
import { openHttpSource } from "@okikio/opfs/http";

const source = await openHttpSource("https://files.example/report.zip", {
  identity: "application/account-one/report-v3",
  headers: () => ({ authorization: "Bearer application-owned-token" }),
  maxReadBytes: 1024 * 1024,
});
const preview = await source.read(0, Math.min(5, source.size));
console.log(preview);
```

Replace the example URL and token with your own resource. The library reads no credentials from the environment.
Authentication headers can refresh per request attempt. Cookies and client-certificate behavior require an explicit
`credentials` option; the default is `omit`. Redirects fail without forwarding authentication to a new destination.

Opening performs HEAD and requires a finite, safe-integer Content-Length and a strong ETag. Each later read sends
If-Match plus an exact byte range. HTTP 206 and a consistent Content-Range are required. Ignored ranges, encoded
representations, changed response ETags and incorrect body lengths reject; acquired bodies retire before failure is
reported. A conforming server must enforce If-Match. This cannot certify a server that lies about validators or bytes.
Browser use needs the server's CORS policy to expose metadata and permit the requested headers. Exact HTTP byte/range
semantics follow [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html).

For a server without a strong ETag, `assumeStable: true` explicitly accepts caller-owned consistency. Its source reports
`stability: "caller"`; this option does not make a mutable URL immutable. Unknown-length and HEAD-unsupported servers
are outside this source profile. Empty exact reads perform no GET. Reads are bounded by `maxReadBytes` (8 MiB by
default); compose `budgetSource()` to bound aggregate bytes and requests across archive and encrypted range readers.

Replay identity is omitted by default. Query strings can contain both object identity and bearer secrets, so stripping
them would create collisions and saving them could expose credentials. The optional caller identity must bind the full
resource, authentication context and immutable representation. The library does not compute a content digest. See
[sources](source.md) and [transfer](transfer.md) before promising recovery across application restarts.

The source borrows Fetch and authentication callbacks, owns acquired response readers, propagates AbortSignal and starts
no background work. Shared request policy applies only to these read-only requests. There is no upload, filesystem
adapter, HTML directory scraping, global registry or automatic codec download on this path.
