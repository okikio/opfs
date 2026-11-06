# Decode one LZ4 frame incrementally

Use the decoder when an LZ4-compressed file is larger than the preview or output you want to keep. It validates each
block without retaining the entire file. Blocks can reach the caller before the complete frame checksum is known.

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

The function leaves successful destination closure to the caller. `pipeTo` retains its normal error/abort behavior; if
an application also needs to keep a failed destination open, it must explicitly choose that pipeline policy. The decoder
owns the input reader only after the first pull. It cancels that reader on failure, abort or output cancellation, and
releases its lock before `finished` settles. Merely constructing a decoder starts no reads or background work.

To preview a prefix, read the required chunks and cancel the decoder stream. The returned chunks remain owned by the
caller; cancellation returns `status: "cancelled"` and `integrity: "checksum-pending"`. It does not scan the rest of the
frame or certify its footer. Whole-frame verification requires consuming the stream through successful EOF.

## Supported frame and checksum scopes

This implementation decodes one modern LZ4 version-1 frame with 64 KiB, 256 KiB, 1 MiB or 4 MiB maximum blocks. It
supports compressed and uncompressed blocks, independent blocks, and dependent blocks with an owned 64 KiB history.
Content-size fields are validated as safe unsigned integer values and checked against the decoded total. Overlapping
match copies are supported without reading outside prior history or the current block.

The header checksum always passes before header metadata is accepted. If the frame has block checksums, each stored
block checksum must pass before that block is decoded or released. `verifiedBlocks` counts only these encoded-block
checks. The optional content checksum covers decoded bytes across all blocks; it is verified only after the end marker.
Successful EOF reports `integrity: "checksum-verified"` when that content checksum is present and `"not-provided"`
otherwise. The latter can still have independently verified block checksums. None of these xxHash32 checksums provides
cryptographic authentication or a trusted sender identity.

A later content-checksum failure, declared-size mismatch, truncated footer or trailing frame can occur after earlier
chunks were released. Use a temporary destination and publish only after successful completion when the application
cannot accept that outcome. `finished` rejects terminal parser, producer and cleanup failures; it has an internal
rejection observer so reading output before awaiting it does not create an unhandled-rejection window. Cleanup failures
are retained with the primary failure rather than replaced by a successful cancellation result.

Dictionaries and dictionary IDs (including ID zero), skippable frames, legacy frames, standalone raw LZ4 blocks,
concatenated frames and trailing bytes are explicitly unsupported. There is no automatic file extraction, native codec
fallback, global registry or runtime dependency. LZ4 is sequential here; this API does not claim random access or
durable resume checkpoints.

## Memory, work and cancellation

Each compressed block is walked once to validate tokens, extended lengths, match references and terminal conditions and
to measure its decoded size. That pass never expands matches. The decoder reserves that decoded size before allocating
the output and then walks tokens again to copy literal and match bytes. This costs two token passes plus checksum work;
it avoids allocating a maximum-size output for a block that the decoded budget would refuse.

The decoder retains at most one owned producer chunk, one encoded block, one decoded block, one 64 KiB history and a
sixteen-byte content-hash tail, plus the current returned chunk. With defaults, the two block buffers can each reach 4
MiB, the producer and returned chunks can each reach 64 KiB, and history can reach 64 KiB. History replacement can
briefly retain the previous and next 64 KiB copies. Producer buffers and downstream queues remain separately owned and
are outside that sum. Input acquisition is checked before making the decoder's copy; it cannot prevent the producer from
allocating its own chunk first.

`maxInputChunkBytes` defaults to 64 KiB. Producers with larger chunks must split them or explicitly raise this finite
policy. `maxBlockBytes` defaults to the 4 MiB implementation ceiling and is checked against the header before allocating
block data. A contiguous encoded extent is also checked against the remaining source allowance, accounting for already
buffered bytes, before that extent is allocated. `outputChunkBytes` defaults to its 64 KiB implementation ceiling.
Source, decoded and returned-byte defaults are each 64 MiB; the upstream-read request limit defaults to 4096, including
the EOF read. The block-count limit defaults to 100000, including empty blocks. A shared archive ledger bounds multiple
decoders and other nested archive operations. Options and the ledger owner are snapshotted when the decoder is created.
There are no refunds after a later failure.

Output admission occurs before copying the next returned chunk. Pull-based backpressure prevents decoding a new block
while a previous decoded block still has unread output. A synchronous block walk cannot be interrupted halfway through;
finite block and byte limits bound its work, not elapsed CPU time. Abort cancels a pending input read, waits for owned
cleanup, and rejects the terminal result. The decoder never closes an application-owned provider or filesystem.

## Independent evidence and format sources

The historical `tests/fixtures/lz4/create.py.snapshot` used the signed Debian LZ4 CLI to produce independent/dependent
frames, all four maximum block sizes, raw data blocks, empty content and checksum variants. It compares every original
payload through the C `LZ4F_decompress` API separately from the CLI. A repeated pseudorandom 65000-byte period fits the
maximum match distance and forces cross-block history use. `xxhsum -H0` supplies full expected xxHash32 values at
byte/stripe boundaries. The package adds neither tool as a runtime dependency. Native producer/consumer version strings
and original full payloads remain in the fixture JSON; provenance pins each file and archive hash.

The producer used signed Debian `lz4` package `1.9.4-1` and `xxhash` package `0.8.1-1` on arm64. Its local base image is
diagnostic provenance, not a publicly pullable complete producer pin. The source implementation follows the immutable
[LZ4 frame specification](https://github.com/lz4/lz4/blob/ebb370ca83af193212df4dcbadcc5d87bc0de2f0/doc/lz4_Frame_format.md),
[LZ4 block specification](https://github.com/lz4/lz4/blob/ebb370ca83af193212df4dcbadcc5d87bc0de2f0/doc/lz4_Block_format.md)
and
[xxHash specification](https://github.com/Cyan4973/xxHash/blob/bbb27a5efb85b92a0486cf361a8635715a53f6ba/doc/xxhash_spec.md).
The implementation is written from those format rules; it does not copy an upstream decoder or hash implementation.

## Reproduce the decoder workloads

Run `BENCH_JSON=1 deno task bench:lz4` on a quiet machine to retain Mitata distributions for twelve warm workloads. The
fixtures cover independent blocks, dependent history, overlapping matches and raw blocks. Each complete decode compares
4 KiB and 64 KiB output chunks, while a separate 4 KiB-prefix workload awaits cancellation. Full-byte and terminal-state
oracles run before timing, and timed consumers discard output without retaining a complete decoded file. Labels include
actual source, decoded and returned byte counts.

The 4 KiB policy is a comparison baseline for chunk policy, not an independent codec or a performance acceptance target.
Prefix cancellation and complete footer verification perform different work. These fixed fixtures do not measure cold
imports, remote I/O, engine peak heap or application queues. CI retains raw JSON and stderr alongside other archive
benchmark evidence; there is no universal throughput, speedup or memory-regression claim. Compare the same named cases
on recorded baseline and candidate revisions before changing the default policy, keeping semantic and cleanup tests as
required gates.
