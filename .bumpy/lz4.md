---
"@okikio/opfs": minor
---

Decode a single modern LZ4 frame incrementally with bounded blocks and explicit checksum scope. Observe finished after
stream cleanup; already emitted prefixes cannot be retracted after a later footer error.

```ts
import { createLz4Decoder } from "@okikio/opfs/archive/lz4";

export async function decode(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = createLz4Decoder(input, {
    ...(signal ? { signal } : {}),
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 64 * 1024 * 1024,
    maxRequests: 4096,
    maxInputChunkBytes: 65536,
    maxBlockBytes: 4 * 1024 * 1024,
    maxBlocks: 100000,
    outputChunkBytes: 65536,
  });
  try {
    // The caller supplies a temporary/quarantined destination if it cannot publish unverified prefixes.
    await decoder.stream.pipeTo(output, { preventClose: true });
    const result = await decoder.finished;
    if (result.status !== "complete") throw new Error("LZ4 decoding stopped before EOF.");
    console.log(result.integrity, result.verifiedBlocks, result.work);
  } catch (reason) {
    // cancel initiates teardown even when pipeTo rejected before acquiring a reader (for example, a locked destination).
    // finished owns the decoder's terminal failure, including cleanup errors.
    await decoder.stream.cancel(reason).catch(() => {});
    try {
      await decoder.finished;
    } catch (terminal) {
      // These are two observations of one decoder failure, not independent release events.
      if (terminal === reason) throw reason;
      throw new AggregateError([reason, terminal], "Destination/pipeline and LZ4 teardown failed.", { cause: reason });
    }
    throw reason;
  }
}
```

See the [lz4 guide](../docs/lz4.md) for finite limits, ownership, unsupported profiles and recovery.
