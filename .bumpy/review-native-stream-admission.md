---
"@okikio/opfs": patch
---

### Refuse native Fetch stream coercion before signing or dispatch

A genuine browser stream can be accepted by the library while the runtime's native `Request` converts that stream to
text. A request that then sends `[object ReadableStream]` has neither the caller's payload nor its declared byte length.
Default raw S3 and Azure requests now check native Request stream admission before credential callbacks or dispatch. The
check creates one private closed stream, observes that Request retains that exact body without inventing a text
Content-Type and caches the result for the current constructor pair. Importing or constructing a client does no probe
work and the check opens no network connection or reader on caller input.

For a stream upload, use the public bounded upload path:

```ts
import { createS3Client } from "@okikio/opfs/s3";

const client = createS3Client({
  endpoint: "https://s3.example.com",
  bucket: "assets",
  region: "us-east-1",
  credentials: { accessKeyId: "application-key", secretAccessKey: "application-secret" },
});
const source = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([17, 31]));
    controller.close();
  },
});
const receipt = await client.put("payload.bin", source, { size: 2 });
console.log(receipt.size); // 2; put() sends bounded byte bodies.
```

```text
raw request + default Fetch → native stream admission → credentials → one dispatch
                            ↘ unsupported TypeError; caller retains input
public put(stream)         → bounded byte parts → ordinary materialized dispatch
```

An explicitly injected `fetch` remains a transport capability supplied by the application. It can consume raw stream
bytes independently of native Request support; it also owns reader retirement and its network semantics. Raw streams
remain one-shot and are not replayed after a retryable response. The library does not replace an unsupported raw stream
with an unbounded buffer. Azure Shared Key raw streams still require their explicit Content-Length.

The native check establishes constructor admission, not cloud interoperability, CORS permission or network streaming
support. Browser controls distinguish unsupported defaults from capable custom transports with real iframe streams,
exact payload bytes and input ownership counts. Available native-default realms still consume native Request bodies.
OPFS byte controls also use the package probe before root acquisition and retain explicit absence evidence instead of
assuming every browser profile permits storage. Runtime test results must accompany these claims; a formatted fixture
does not prove a live cloud or an unavailable native capability.
