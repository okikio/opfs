# Preview indexed XZ data

XZ is a compressed byte stream, rather than a named-file archive. Open its index, then read a range of decoded bytes
without retaining the complete decoded stream. This profile supports exactly one LZMA2 filter per block with CRC64 (the
native XZ CLI default), CRC32, or no payload check. SHA-256 and other check identifiers remain unsupported.

```ts
import { createBlobSource } from "@okikio/opfs/source";
import { createArchiveLedger, openXz } from "@okikio/opfs/archive/xz";

export async function preview(compressed: Blob): Promise<Uint8Array> {
  const ledger = createArchiveLedger({
    maxSourceBytes: 16 * 1024 * 1024,
    maxRequests: 4096,
    maxDecodedBytes: 32 * 1024 * 1024,
    maxOutputBytes: 4096,
  });
  const archive = await openXz(createBlobSource(compressed), {
    ledger,
    maxIndexBytes: 1024 * 1024,
    maxBlocks: 4096,
    maxPaddingBytes: 65536,
    lzma: { maxDictionaryBytes: 8 * 1024 * 1024, maxMemoryBytes: 16 * 1024 * 1024 },
  });
  console.log(archive.size, archive.blocks, archive.metadata);
  const result = await archive.read({ length: Math.min(4096, archive.size) });
  console.log(result.checks, result.work, result.steps);
  return result.bytes;
}
```

`size` and every block's `decodedBytes` come from checked metadata and remain **declarations** until their data is
decoded. The index CRC detects accidental metadata corruption; it cannot make an intentionally incorrect declaration
true. A successful complete selected-block decode checks that block's exact compressed extent, actual decoded size and
LZMA2 end control against those declarations. `metadata` reports mandatory header, footer, index and block-header CRC
evidence, never payload verification or authenticity.

## Read selected blocks

`read({ offset, length })` defaults to verification. The index locates only the blocks that intersect the selected
range. Each selected block decodes from its own beginning; preceding blocks need not be decompressed. A late offset
inside one block still costs decoding that block's preceding bytes. The reader copies only selected bytes into its
returned array and discards other decoded output. It does not buffer an entire decoded block.

With `verify: true`, each selected block is drained through its exact end and its CRC32 or CRC64 is verified before the
method returns. `checks` identifies those blocks. No statement about unrelated payload blocks follows from that result.
A complete range over the whole declared stream verifies every block, including declared zero-length blocks. A stream
with no blocks has no payload checks to report.

With `verify: false`, the reader may cancel a block after the selected prefix. `decoding: "prefix"` means complete
structural termination is unverified; `"complete"` means the codec reached its terminal state. The codec's output
quantum and input lookahead can pass the selected end before cancellation, so a prefix may cost more source and decoded
bytes than its returned length. CRC32 and CRC64 checks report `pending` whenever verification was disabled, even if the
codec happened to reach the block's end. The `none` profile reports `not-provided` rather than inventing checksum
evidence.

Payload CRC32 or CRC64 covers the original decoded block bytes. It is not a checksum of the compressed extent and there
is no extra whole-stream payload CRC. Neither CRC authenticates a file or establishes who published it. Errors keep
archive categories (`invalid-archive`, `unsupported-profile`, `budget-exceeded`, `checksum-mismatch`) or preserve the
original provider/abort failure.

## Exact supported framing

The source contains one Stream beginning at offset zero, followed by optional bounded Stream Padding. All padding is
zero and four-byte aligned. SFX prefixes, leading padding, concatenated Streams and nonzero trailing data are refused.
SHA-256, reserved check identifiers, Delta/BCJ filters, filter chains and external codec implementations are
unsupported.

Opening reads the footer and Index to establish exact physical block ranges. It checks footer magic, CRC and Backward
Size; matching stream flags and header CRC; canonical base128 variable-length integers; Index count, CRC and padding;
and exactly fitting padded block sizes. Every block header has a format-defined maximum of 1024 bytes and its CRC is
checked before interpreting flags. Reserved bits, filter identifiers, property length/dictionary value, optional
compressed and decoded sizes, and zero block padding are checked. Physical blocks must fill the region between the
Stream Header and Index exactly.

Opening never decompresses a payload. A padded stream needs bounded lookbehind to locate its footer; those probes can
fetch preceding compressed bytes. Such bytes are included in source and parser-work accounting. Block headers and
padding are examined at open, while decoded data and block payload checks are examined only by reads. Integers are
restricted to exact JavaScript indexing through BigInt validation before any offset sum or allocation uses them.

## Budgets and ownership

Opening defaults to at most 8 MiB of Index bytes, 100,000 block records and 1 MiB of trailing padding. Source, request,
decoded-work and selected-output limits default to 64 MiB, 4096 requests, 64 MiB and 16 MiB. The Index allocation is
admitted before reading it, and record counts are bounded before arrays are created. Each block header is at most 1024
bytes. These are logical policies, not an exact JavaScript heap or elapsed-time guarantee.

Opening byte policies remain a lifetime allowance across subsequent reads. An opening `ledger` remains active even if a
read supplies another ledger; that second ledger adds admission. Repeating the same ledger does not double-charge it.
The operation's `work` reports its own requests, source bytes, decoded/parser work and selected output. LZMA2 framing
and discarded plaintext consume decoded work. Codec output is not charged a second time as returned output. Counts are
not refunded after cancellation or refusal.

The `lzma` options on opening are inherited by reads and can be overridden for one read. They accept
`maxDictionaryBytes`, `maxMemoryBytes`, `maxDecisions`, `maxSteps`, `maxChunks`, `inputChunkBytes` and injected `yield`.
Defaults and hard ceilings match [the raw LZMA decoder](lzma.md). Decisions, steps and chunk limits are cumulative
across all selected blocks in one read. A per-block restart does not reset the CPU allowance. The public result reports
those counters. Only one block decoder is active at a time, with its own bounded dictionary, flat probability model,
packed cursor and output quantum; retained selected bytes and Index records are separate container allocations. CRC64
adds one operation-owned 2 KiB table and two uint32 state words, created only when a selected block needs CRC64 and
reused with a state reset for each selected block. CRC32 and `none` reads do not allocate that table. The table is not a
module cache and is outside the raw decoder's `maxMemoryBytes` allowance.

CRC64 evidence uses `crc64`, exactly sixteen lowercase hexadecimal digits, so no 64-bit value passes through an
imprecise JavaScript number. Verified CRC64 checks report `crc64-verified`; the existing CRC32 numeric `crc` and
`crc32-verified` remain separate. The accumulator uses two 32-bit words and a flat table for one byte recurrence instead
of eight per-bit iterations. It creates no BigInt value per decoded byte and retains no complete body. This explains the
chosen bounded work and memory shape; it is not a measured throughput claim.

The source remains borrowed and is never closed. Its size, read capability, identity and stability are captured at
opening. It must declare `immutable`, `provider` or `caller` stability, unless missing evidence is explicitly accepted
with `allowUnverifiedSource: true`. Identity is a bounded optional string, not a stability or authentication proof.
Opening and operation abort signals are combined, so a later signal cannot bypass an aborted opening lifetime.

Decoder cancellation and `finished` are joined before a read returns or fails. An outstanding foreign source operation
or injected scheduler must settle first; these capabilities cannot be forcibly interrupted. Independent provider
failures remain visible if they arrive while cancellation waits. There are no background jobs, SDK loads, source
ownership transfers or global registries.

## Independent evidence

The historical `tests/fixtures/xz/create.py.snapshot` ran genuine signed-Debian XZ Utils encoders and compared every
output byte against the original input with Python liblzma and independent 7-Zip. Fixtures cover CRC32/CRC64/none, empty
data, dictionary overlap and wraparound, multiple independent blocks, and threaded encoder headers containing optional
size fields. Unsupported SHA-256 and Delta/BCJ files are genuine producer outputs accepted by independent consumers and
refused by this profile.

The trailing-padding fixture is an explicitly labelled adaptation of native output. Python's convenience
`lzma.decompress` rejected it on the recorded producer runtime. That negative observation remains in the fixture; native
`xz -dc` and 7-Zip accept the full payload. Python's lower-level `LZMADecompressor` separately records EOF and exact
unused padding bytes. No consumer failure is relabelled as a success or hidden by stripping bytes.

Current `tests/fixtures/xz/create.ts` runs installed XZ Utils and 7-Zip without Python. Its new deterministic random
recipe is identified explicitly and differs from the historical Python recipe. It independently calculates each CRC64
block check with a bit-at-a-time BigInt oracle, checks corrupted checksums with both native tools and retains their
observed failures. Its explicit output destination keeps new results separate from the historical corpus.

The receipt pins source, fixtures, native tools and the official
[XZ format version 1.2.1](https://tukaani.org/xz/xz-file-format-1.2.1.txt), SHA-256
`acc324b995261e6d9d5793c6a504639a6dfe97f2ccaf3cf8667f20a2486fc85b`. The decoder implementation comes from the separately
verified local LZMA2 engine; no upstream SDK implementation is copied. Native producer tools are test-only and do not
become runtime dependencies. Framing controls use independently authored bitwise CRC and known byte sequences, rather
than candidate-generated expected payloads.

The CRC64/XZ profile follows section 6 of that same primary specification. The independent check vector ASCII
`123456789` is `995dc9bbdf1939fa`, also recorded in
[CRC RevEng's CRC-64/XZ catalogue](https://reveng.sourceforge.io/crc-catalogue/17plus.htm#crc.cat.crc-64-xz). An
independently authored Python bitwise oracle checks native stored block CRC64 values against original payload slices.
Native XZ and 7-Zip must both reject fixtures with corrupted payload check bytes. This supplies algorithm and stored
checksum-scope evidence without deriving expected values from the candidate's two-word table implementation.

## Read costs and benchmarks

`deno task bench:xz` runs 21 workloads after comparing complete decoded bytes with the independent originals. It
separates cold metadata opening, whole-stream verification, early and late selected-block reads, and unchecked prefixes
for CRC32, CRC64 and no-check fixtures. The CRC32/CRC64 workloads include multiple blocks; the small no-check fixture is
single-block. Labels retain observed source, decoded and selected-output work. A decoded native Blob range is a
copy-only lower bound, not a competing native XZ decoder. Encoder and block-layout differences prevent treating the
CRC32/CRC64 lanes as an isolated checksum speed comparison.

The benchmark uses an explicit finite opening lifetime allowance for repeated sampling while keeping ordinary read
policies. CI retains raw distributions and runtime details. These bounded workload observations do not establish
universal throughput, exact heap use, or a cross-format speedup.
