---
"@okikio/opfs": minor
---

### Stream compressed TAR members without collecting an archive

The optional `archive/compress` subpath exposes native Web compression/decompression streams with explicit producer,
decoded-byte and delivered-output budgets. `createCompressedTar()` connects the TAR/PAX writer directly to a codec;
`readCompressedTar()` visits members sequentially and drains past TAR end blocks to validate the compression footer. See
[the complete streaming example](docs/compression.md) for separate TAR/codec policies and early preview.

```ts
import { createCompressedTar, readCompressedTar } from "@okikio/opfs/archive/compress";

const gzip = createCompressedTar([
  { name: "hello.txt", size: 5, body: new Blob(["hello"]).stream() },
], "gzip");
const result = await readCompressedTar(gzip, "gzip", async (entry, body) => {
  const decoder = new TextDecoder();
  for await (const bytes of body) console.log(entry.name, decoder.decode(bytes, { stream: true }));
  console.log(decoder.decode());
});
console.log(result.compression.integrity); // gzip-crc32
```

An early visitor stop cancels the stream and leaves the checksum pending. Successful gzip/zlib traversal checks CRC32
and size, or Adler32, independently of the native decoder. These are checksums, not authentication. Raw DEFLATE has no
checksum, and Deno 2.9.8's decoder can accept a truncated final block; raw EOF therefore reports integrity `none`.
Callers needing complete raw data must verify a trusted expected length/hash. Native codec allocation and CPU remain
opaque even though the wrapper bounds admitted work and output. This adds no random access or compression restart state.

Independent Python gzip/zlib and tarfile consumers exercise the writer output. Native Node, Deno and Bun tests cover
malformed/truncated input, cancellation, slow consumers and owned reader release. The benchmark compares a native codec
baseline with the wrapper's policy/checksum costs; timings are workload observations, not a general speed claim.
