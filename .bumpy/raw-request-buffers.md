---
"@okikio/opfs": patch
---

### Keep raw request-buffer signing and transmission on the same native bytes

A low-level `request()` can receive an `ArrayBuffer` from another JavaScript realm. Native Fetch can read those bytes,
but the client previously used a local `instanceof ArrayBuffer` check when deciding how to hash an S3 body or derive
Azure's Shared Key content length. A foreign three-byte body could therefore use `UNSIGNED-PAYLOAD` in S3 or omit the
known length in Azure, while Fetch still transmitted all three bytes.

Raw buffers now use native brand, size and readability checks before credentials or dispatch. Own metadata cannot change
that range. Detached buffers reject rather than become empty bodies, and genuine empty buffers remain valid. Fixed
ordinary buffers retain identity without a byte copy only when they have this realm's captured native prototype and no
own metadata. Hosts can read ordinary backing properties, including `byteLength` and `detached`, during BodyInit
extraction. Resizable, foreign, custom-prototype or own-metadata backing therefore receives one clean fixed copy before
hashing, signing and retries. Byte views use the same backing policy with a copy of only their admitted native range.
Each attempt keeps that captured body even when the original input changes; caller getters are not consulted.

This function accepts an already configured, caller-owned S3 client:

```ts
import type { S3ClientType } from "@okikio/opfs/s3";

export async function writeRaw(client: S3ClientType): Promise<number> {
  const body = new ArrayBuffer(3, { maxByteLength: 6 });
  new Uint8Array(body).set([1, 2, 3]);
  const writing = client.request({ method: "PUT", key: "raw.bin", body });
  body.resize(0);
  const response = await writing;
  try {
    return response.status;
  } finally {
    await response.body?.cancel();
  }
}
```

The request keeps the initial three bytes because this resizable input is captured before the asynchronous signing and
transport steps. A clean local fixed buffer remains borrowed, so its caller still keeps bytes valid and unchanged until
the request settles, without adding backing properties or changing its prototype. A required raw-buffer copy costs the
native body length; it is not a performance speedup. Existing S3 raw-buffer hashing costs remain unchanged for fixed
inputs. Copying still requires caller cooperation during admission.

```text
native raw range → clean local fixed backing without own keys: borrow identity
                 → other genuine backing: copy once → hash/length → sign → repeated attempts
```

The maintained controls calibrate clean authored native `Request` bytes, then send actual same-realm and foreign-realm
original buffers through the client. They inspect authorization inputs and consume exact native request bytes, including
false own metadata, custom prototypes, empty and detached inputs, retries, immediate caller changes and credential-time
mutation. Raw and view backing with a true or throwing `detached` property must not trigger caller getters; clean local
fixed backing retains its no-copy path. Browser controls use actual same-origin iframe buffers, independently compare S3
hashes and Azure lengths, and mutate caller RAB storage at dispatch to test the fixed wire snapshot. These are
transport/signing controls with synthetic credentials, not evidence that a live cloud provider accepted a request. Raw
`SharedArrayBuffer` is still outside the declared `BodyInit` contract; shared-backed byte views retain their separate
fixed wire conversion.

Browser controls also construct fixed and resizable raw buffers in actual same-origin iframes. They compare the bytes
consumed by native `Request`, S3 payload hashes from independent Web Crypto, and Azure's prepared `Content-Length`.
Growing and replacing the caller's resizable bytes at dispatch must leave the admitted fixed wire snapshot intact. An
actual iframe native resize probe records feature absence. These controls do not claim cloud-network acceptance or
native `Request` support for bare resizable backing.
