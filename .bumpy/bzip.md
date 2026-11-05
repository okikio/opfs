---
"@okikio/opfs": minor
---

Decode BZip2 with bounded transformed block state and explicit verified-prefix costs.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createBzipDecoder } from "@okikio/opfs/archive/bzip";

export async function decode(file: Blob): Promise<ArrayBuffer> {
  const decoder = createBzipDecoder(createBlobSource(file), { maxOutputBytes: 16 * 1024 * 1024 });
  const [bytes, result] = await Promise.all([new Response(decoder.stream).arrayBuffer(), decoder.finished]);
  console.log(result.integrity, result.verifiedBlocks, result.work);
  return bytes;
}
```

A block is fully decoded and CRC-checked before its output is replayed into bounded chunks. The header bounds
transformed state, not expanded plaintext. Cancelling a verified prefix leaves whole-stream checksum evidence pending;
`finished` joins active borrowed callbacks after prompt stream cancellation. The [BZip2 guide](../docs/bzip.md) explains
finite CPU, memory and byte policies, source read-ahead, terminal extent and deliberately unsupported
randomized/concatenated profiles. Native bzip2, Python and 7-Zip check complete independent originals. Twelve benchmark
workloads retain actual work and a labelled copy-only baseline without claiming universal throughput or authentication.
