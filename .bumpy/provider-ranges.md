---
"@okikio/opfs": patch
---

### Read exact zero-length ranges without requesting a byte

Direct S3 and Azure clients, and their object drivers, now apply the same finite range admission. Previously,
`length: 0` produced an inclusive one-byte HTTP range. The filesystem adapter already returned no bytes, so applications
using a client directly saw different behavior.

```ts
import { createS3Client } from "@okikio/opfs/s3";

const client = createS3Client({
  endpoint: "https://s3.us-east-1.amazonaws.com",
  bucket: "example-bucket",
  region: "us-east-1",
  credentials: { accessKeyId: "replace-with-your-access-key", secretAccessKey: "replace-with-your-secret-key" },
});
const empty = await client.get("report.json", { at: 100, length: 0 });
console.log((await new Response(empty).arrayBuffer()).byteLength); // 0
const first = await client.get("report.json", { length: 1 }); // requests bytes=0-0
```

A zero-length read returns a local empty stream before credential refresh, authorization or Fetch. It does not check
whether the object exists. Offsets and lengths must be nonnegative safe integers, and the inclusive end must remain a
safe integer. Invalid ranges reject before dispatch; rounding and clamping cannot repair them. A captured pre-aborted
signal also rejects, preserving its observable reason, including null or undefined.

Nonzero reads retain provider HTTP errors and EOF behavior. In particular, a range starting at or beyond EOF can still
fail with the provider's range status; the direct protocol client does not promise filesystem slice semantics. Caller
settings are captured once before authorization. The stream returned for a remote read remains the caller's
responsibility to consume or cancel.

Maintained controls use real loopback Fetch through both clients and drivers to inspect headers, returned bytes, refusal
and absent credential/transport effects. These controls establish the client boundary; real provider interoperability
remains a separate gate.
