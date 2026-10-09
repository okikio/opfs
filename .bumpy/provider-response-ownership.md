---
"@okikio/opfs": patch
---

### Retire internal provider responses before an operation returns

Typed S3 and Azure operations now own the complete lifetime of responses that they keep internally. For example, a
missing-object DELETE can return an XML error body even though `delete()` treats HTTP 404 as already removed. That body
must be retired before the operation returns; the caller receives `void` and has no response to release.

```ts
import { createS3Client } from "@okikio/opfs/s3";

const objects = createS3Client({
  endpoint: "https://storage.example.com",
  bucket: "reports",
  region: "us-east-1",
  credentials: { accessKeyId: "APPLICATION_KEY", secretAccessKey: "APPLICATION_SECRET" },
});

await objects.delete("already-removed.bin"); // Its accepted 404 response is retired internally.

const response = await objects.request({ method: "GET", key: "report.bin" });
try {
  // A raw request transfers the response body to you.
  console.log(await response.text());
} finally {
  if (!response.bodyUsed) await response.body?.cancel();
}
```

The same ownership applies to headers-only upload acknowledgements, staged blocks and parts, metadata and copy-source
responses. An unused body is cancelled rather than materialized, so an unexpected proxy payload does not require an
unbounded buffer. XML publication acknowledgements still require the entire body to parse successfully before they can
confirm success. An explicitly terminal read is not cancelled a second time. Successful `get()` streams and raw
`request()` responses retain their existing caller-owned lifetime.

Whole XML/error text now has an explicit native reader owner. EOF or a settled stream error establishes terminal
consumption; `bodyUsed` alone is not that proof. This matters on Deno, where an already errored `Response.text()` can
reject before marking the body used. The owner preserves the HTTP error and original stream cause without reporting the
same read fault again as disposal. Each read attempts to release its acquired lock and retains any release fault. A
conversion failure while the source is still readable instead awaits cancellation, retaining independent cancellation
and lock-release faults.

A body partly read by a previous reader still needs cancellation after that reader releases its lock. A used-body flag
cannot substitute for EOF. An injected response whose reader remains borrowed instead refuses retirement; the operation
leaves that outside reader untouched and retains any independent acknowledgement failure first.

UTF-8 still uses replacement decoding and removes exactly one initial BOM, including when multibyte characters or the
BOM cross chunk or empty-chunk boundaries. Incremental decoding preserves BOMs first, then the completed text removes
only its first decoded BOM. A second or middle BOM remains data; invalid or truncated UTF-8 retains replacement
characters. This common path avoids the different streaming BOM behavior observed in the supported runtimes. XML parsing
still materializes complete text and has no new payload-size limit. Header-only cleanup continues to cancel without
reading an arbitrary provider/proxy payload. A started internal text read is drained before its callback's outcome is
returned, including early callback failure; independently observed callback and read events remain present even when
they throw the same object.

Only a read fault delivered before its callback settles can classify that callback's outcome. A callback that starts
text reading, installs a detached rejection handler and returns a header acknowledgement still leaves the read owned by
the operation. A later handler can observe the fault but cannot turn that early acknowledgement into success.

Publication and retirement are separate terminal obligations:

```text
dispatch once → classify provider acknowledgement → retire unused response body → return receipt
                         │                                  │
               unknown outcome after loss          retain disposal failure
```

A disposal failure after a valid acknowledgement is returned as the actual disposal fault; it is not converted into an
unknown publication outcome or used to replay the write. If acknowledgement processing and disposal both fail, an
`AggregateError` keeps the classified operation failure first and the original disposal failure second, with the first
as its cause. Thrown `undefined` and `null` remain distinct from successful settlement. The operation waits for actual
body retirement before returning, including a delayed underlying cancellation.

Intermediate retry responses are also owned: the next attempt starts only after retirement succeeds. Independent
disposal failure refuses retry and retains the HTTP retry marker with the cleanup fault, even when the attempt's signal
expires during disposal. A received HTTP response is not additionally counted as a rejected Fetch. Provider error-body
read or XML parse failures enrich `S3Error.cause` and `AzureError.cause` while HTTP status and available service
identity remain primary; malformed proxy content does not invent a service error code. A custom Fetch stream must settle
its underlying cancellation; this change does not add a separate disposal timeout.

The request layer also keeps ownership when an injected `RequestMetrics` observer throws. A response observer failure
retires the acquired response before rejection. A Fetch failure followed by a rejected-observer failure keeps the Fetch
reason first; a terminal failure followed by a failure-observer fault keeps the prior reason first. Each independent
fault remains present even when a callback throws `undefined` or `null`. Observers cannot authorize another Fetch, and
no observer fault is counted as a new transport failure.

Retry permission comes from the current attempt's actual response, transport rejection, or owned preparation deadline. A
credential callback or observer that rethrows a retained retry error from an earlier request cannot borrow its retry
permission. External errors keep their original identity; only transport reasons created by this request are unwrapped.
This protects custom instrumentation and credential sources without changing ordinary publication's single-attempt rule.
Live caller cancellation retains the native `AbortSignal.reason`, including an explicit `null`. If a create or Fetch
operation settles with a different fault while cancellation is also observed, both reasons remain present and no retry
is admitted. Observing an aborted signal does not replace an independently settled failure.

The controls include accepted missing deletes, S3 part ETags, Azure streamed blocks and URL-copy blocks, acknowledgement
versus disposal failures, and raw response/stream transfer. These ownership fixes do not establish the cause of the
separately observed Docker gateway connection timeouts, change publication retry policy, or certify live-cloud behavior.
