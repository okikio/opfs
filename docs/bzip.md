# Decode BZip2 with bounded block state

`createBzipDecoder()` decodes one BZip2 stream from a caller-owned exact-range byte source. It exposes a readable stream
and a separate terminal result. This example deliberately collects at most 16 MiB of returned bytes; callers that do not
need a complete buffer can consume chunks instead.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createBzipDecoder } from "@okikio/opfs/archive/bzip";

export async function decodeBzip(packed: ArrayBuffer): Promise<ArrayBuffer> {
  const decoder = createBzipDecoder(createBlobSource(new Blob([packed])), {
    maxSourceBytes: 64 * 1024 * 1024,
    maxDecodedBytes: 64 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxMemoryBytes: 8 * 1024 * 1024,
    outputChunkBytes: 65536,
  });
  const [bytes, result] = await Promise.all([
    new Response(decoder.stream).arrayBuffer(),
    decoder.finished,
  ]);
  console.log(result.integrity, result.blocks, result.steps, result.work);
  return bytes;
}
```

Both promises are observed. A block checksum can pass while the later combined checksum or terminal extent fails. Treat
the operation as complete only when `finished` resolves with `status: "complete"` and `integrity: "checksum-verified"`.
These CRCs detect corruption; they do not authenticate a publisher, filename or archive.

## A verified prefix still decodes its complete block

The stream releases bytes only after their complete block CRC passes. It does not buffer all expanded block output.
Instead it retains bounded transformed block state, traverses that state to check the CRC, then traverses it again to
emit chunks. A three-byte preview can therefore require much more input and CPU work than three bytes. There is no
random-access or constant-memory byte-streaming claim.

The header's `1` through `9` selects a transformed block capacity of 100,000 through 900,000 bytes. That is not a
plaintext limit: the independent corpus contains a genuine `BZh1` stream with 50 compressed bytes and two million
expanded `A` bytes. The inverse run-length transform can expand one block far beyond its header capacity.

To stop after a prefix, set `outputChunkBytes` to a suitable quantum, read a chunk and cancel the reader. Every returned
byte came from a block whose CRC passed, but `finished` reports `status: "cancelled"` and whole-stream
`integrity: "checksum-pending"`. `verifiedBlocks` names how many complete block checks passed, including a block whose
output was only partly consumed. It does not verify an unseen footer or later blocks. An empty stream can complete with
zero blocks and a matching zero combined CRC.

## Supported framing and deliberate refusals

The reader accepts one non-randomized `BZh1` through `BZh9` stream. It validates bit-aligned block markers, block CRCs,
the original BWT pointer, the used-byte alphabet, selector MTF values, 2..6 Huffman tables, code lengths 1..20,
fifty-symbol selector groups, symbol MTF, RUNA/RUNB expansion, inverse BWT, final RLE and the combined stream CRC.
Canonical tables are bounded by at most 258 symbols per table, rather than allocating an array indexed by every possible
twenty-bit code. Impossible or oversubscribed codes, selector exhaustion, runaway lengths/runs, invalid BWT positions
and missing RLE count bytes fail without publishing partial block plaintext.

After the combined CRC, the selected profile requires zero bits up to the next byte boundary and an exact match with the
complete source extent. Concatenation, whole trailing bytes, BZip1 and legacy randomized BZip2 blocks are refused. There
is no salvage mode, encryption, signature verification or compression writer in this subpath.

Zero padding is an explicit profile choice. The native bzip2 1.0.8 and Python decoders accept the retained diagnostic
with nonzero unused padding bits; 7zz 26.02 returns all payload bytes but exits with a data error. Those receipts remain
visible. This reader follows the stricter zero-padding profile, without claiming that every BZip2 implementation does.

## Resource and CPU policies

The source is borrowed and never closed. Source size, read method, identity, stability and options are captured before
the first asynchronous read. Stability must be exactly `immutable`, `provider` or `caller`; an identity alone is not
evidence of stable bytes. Unknown stability values are rejected even with `allowUnverifiedSource`. That opt-in accepts
mutation risk only when evidence is absent. An optional identity is bounded to 8,192 UTF16 code units.

| Policy             | Default | Implementation ceiling | Meaning                                 |
| ------------------ | ------: | ---------------------: | --------------------------------------- |
| `maxBlockBytes`    | 900,000 |                900,000 | Advertised transformed block capacity   |
| `maxMemoryBytes`   |   8 MiB |                 16 MiB | Decoder-owned typed scratch capacity    |
| `maxBlocks`        |   4,096 |                 65,536 | Data blocks in this stream              |
| `maxSteps`         |  256 Mi |                   1 Gi | Data-dependent kernel work units        |
| `inputChunkBytes`  |  65,536 |                 65,536 | Exact source request quantum; minimum 1 |
| `outputChunkBytes` |  65,536 |                 65,536 | Returned chunk quantum; minimum 1       |

These are finite implementation and caller safety policies, not format maxima or elapsed-time promises. Memory admission
reserves four bytes per advertised transformed byte for the packed BWT table, an input cursor, one output quantum and
65,536 bytes for bounded selectors/tables/counters. It precedes allocation. `memoryBytes` reports this peak typed-buffer
allowance, not process RSS, JavaScript object overhead, source-internal buffers or chunks retained by the consumer.
Input sources may perform hidden transport work outside the exact-range source contract.

The bounded input cursor can prefetch compressed bytes from a later block or footer while resolving a Huffman symbol.
Those bytes count against source work even when the consumer cancels after the first verified output chunk. A prefix
therefore does not promise to fetch only the exact compressed extent of its verified block.

`steps` counts packed bits, Huffman-table construction, MTF moves, transformed fills, inverse BWT visits and expanded
bytes. A compressed-byte bound cannot replace this policy: malformed coding tables can spend work without producing
output. The optional caller-owned `yield()` capability provides scheduling boundaries after finite kernel work and each
emitted chunk. It must return; this is not a background scheduler or wall-clock deadline. Cancellation is checked again
after each source read and scheduling callback, and before emission.

The standard archive limits also apply: defaults are 64 MiB source bytes, 4,096 requests, 64 MiB decoded/inspected work
and 16 MiB returned bytes. `work.decodedBytes` counts transformed bytes, all expanded bytes scanned for block CRC and
expanded bytes replayed for output. A complete read therefore charges plaintext twice in addition to transformed state.
`work.outputBytes` counts only returned chunks. A prefix pays full-block verification plus its emitted replay. Policies
and an optional external `ledger` remain cumulative for the whole decoder; individual pulls cannot reset them. Failed
reservations are not refunded.

## Cancellation has a separate join

The stream uses a zero high-water mark and acquires source bytes only on demand. Cancelling before the first pull
performs no source I/O. Cancellation marks the kernel stopped and returns promptly, even if a source or scheduling
callback reenters and awaits reader cancellation. `finished` remains the authoritative join: it settles only after the
active borrowed callback retires. No further chunk is emitted after cancellation.

Always observe `finished` before closing or reusing a borrowed source that still has an active operation. A source or
`yield` callback must not await `finished` while it owns that operation; that would create a join cycle. A callback can
await reader cancellation instead. If the provider later fails, the failure remains visible through `finished`, even
though a cancelled stream cannot publish another terminal error. External abort also waits for in-flight work to retire
before settling. A source that ignores cancellation and never returns prevents that join from completing.

## Independent evidence

The [historical producer](https://github.com/okikio/opfs/blob/68189c7/tests/fixtures/bzip/produce.py) alternated genuine
native bzip2 1.0.8 and Python `bz2` producers. Native bzip2, Python and 7zz 26.02 independently consume every complete
original payload. The corpus covers all nine levels, empty input, binary data, multiple blocks, run boundaries and a
two-million-byte expansion. The
[fixture receipt](https://github.com/okikio/opfs/blob/68189c7/tests/fixtures/bzip/README.md) pins source/tool/file
evidence and the padding discrepancy. No expected payload is obtained from this decoder.

Current `tests/fixtures/bzip/produce.ts` uses native bzip2 and reciprocal 7-Zip consumption without Python. It records a
new deterministic xorshift input recipe and native-only producer labels. The padding diagnostic retains the actual 7-Zip
exit and complete output, without presuming that another version must reproduce the historical refusal. The old source
remains inert as `produce.py.snapshot`; dated fixture hashes and receipts still describe that original execution, not a
new TypeScript run.

The format and CRC contracts were reconciled against the official
[bzip2 1.0.8 source release](https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz) and
[manual](https://sourceware.org/bzip2/manual/manual.html). The release archive is pinned by SHA-256
`ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269`; exact researched source-file hashes are retained in
the fixture receipt. The source release is evidence, not a production dependency, and no upstream implementation was
copied into this module. Focused runtime checks do not establish browser performance, full format compatibility,
randomized-block support or a published artifact's behavior.

`bench/bzip.bench.ts` measures complete-stream verification and verified-block prefix cancellation for binary,
multiblock and long-run native fixtures. Before timing, every complete decoded byte and each preview prefix is compared
with the independently authored original input. Each sample creates a fresh decoder with finite per-stream policies.
Labels expose source, decoded, returned, block, CPU-step and typed-scratch work. The predecoded Blob baseline only
copies existing plaintext and is a lower bound; it does not perform decompression or integrity checks. These workloads
measure the selected local runtime rather than browser, transport or deployed-provider behavior.
