---
"@okikio/opfs": minor
---

Read native Brotli and optional Zstandard streams through the existing bounded compression API. Select the format
explicitly; unavailable native codecs refuse before acquiring the input, without a fallback dependency.

```ts
import { decompressStream } from "@okikio/opfs/archive/compress";

export function preview(input: ReadableStream<Uint8Array>, signal: AbortSignal) {
  return decompressStream(input, "brotli", {
    signal,
    maxSourceBytes: 1024 * 1024,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
  });
}
```

Consume or cancel the returned stream to retire its acquired input reader. Brotli is a standard Web compression format;
`zstd` requires a host extension. Native frame/window behavior remains runtime-owned, and neither format gains an
independent checksum or authentication claim here. TAR composition reports integrity `none` at complete native EOF;
early previews remain pending. See [compression ownership and limits](../docs/compression.md).
