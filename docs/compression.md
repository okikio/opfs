# Stream compressed bytes and TAR members

Use native gzip, zlib-framed `deflate`, unframed `deflate-raw`, or optional Brotli/Zstandard codecs without collecting
an archive. `compressStream()` and `decompressStream()` return Web byte streams. `createCompressedTar()` and
`readCompressedTar()` compose those codecs with the [TAR writer and visitor](tar.md). A late TAR member still requires
sequential decompression of preceding bytes; these APIs do not provide compressed random access or resume checkpoints.

This example writes a gzip TAR, then consumes a selected member. Both layers have explicit byte limits:

```ts
import { createCompressedTar, readCompressedTar } from "@okikio/opfs/archive/compress";

const output = createCompressedTar(
  [
    { name: "notes/hello.txt", size: 5, body: new Blob(["hello"]).stream() },
  ],
  "gzip",
  {
    tar: { maxSourceBytes: 1024, maxDecodedBytes: 1024, maxOutputBytes: 16 * 1024 },
    compression: { maxSourceBytes: 16 * 1024, maxDecodedBytes: 16 * 1024, maxOutputBytes: 4096 },
  },
);
const result = await readCompressedTar(output, "gzip", async (entry, body) => {
  if (entry.name === "notes/hello.txt") {
    const decoder = new TextDecoder();
    for await (const bytes of body) console.log(decoder.decode(bytes, { stream: true }));
    console.log(decoder.decode());
  }
}, {
  compression: { maxSourceBytes: 4096, maxDecodedBytes: 16 * 1024, maxOutputBytes: 16 * 1024 },
  tar: { maxSourceBytes: 16 * 1024, maxDecodedBytes: 1024, maxOutputBytes: 1024, maxEntries: 100 },
});
console.log(result.complete, result.compression.integrity);
// true, "gzip-crc32"
```

TAR end blocks occur before the compression footer. After a complete TAR traversal, `readCompressedTar()` continues to
decoder EOF, discarding remaining TAR record padding under the compression budgets. This final drain checks gzip CRC32
and uncompressed size, or zlib Adler32, against the decoded content. A corrupt/truncated footer rejects the operation
even when all TAR visitors already ran. Consumer side effects are not rolled back: stage important writes and publish
them only after the returned result succeeds.

For an early preview, stop iterating a body and return `false` from the visitor. Set `tar.bodyChunkBytes` to bound each
selected output view, as described in the TAR guide. Early stopping cancels the decoder instead of checking the
remaining compressed stream. It returns `complete: false` and
`compression: { complete: false, integrity: "pending", ... }`. Already admitted codec output and producer read-ahead
still count. A checksum is not authentication; use a separately verified hash/signature or an authenticated encryption
format when adversarial content matters.

## Use an individual codec

```ts
import { compressStream, decompressStream } from "@okikio/opfs/archive/compress";
import { createArchiveLedger } from "@okikio/opfs/archive/tar";

const ledger = createArchiveLedger({
  maxSourceBytes: 1024 * 1024,
  maxDecodedBytes: 4 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
});
const compressed = compressStream(new Blob(["hello"]).stream(), "deflate");
const plain = decompressStream(compressed, "deflate", { ledger, outputChunkBytes: 1024 });
await plain.pipeTo(
  new WritableStream({
    write(bytes) {
      console.log(bytes);
    },
  }),
);
console.log(ledger.inspect());
```

The format is explicit. `deflate` means an RFC1950 zlib header, DEFLATE payload and Adler32 footer; it is not raw
DEFLATE. `deflate-raw` means the RFC1951 bitstream alone. No format sniffing, fallback dependency or runtime-specific
import is used. Native codec availability is checked when the function is called, before acquiring a producer reader.
Unsupported profiles use `ArchiveError` with `code: "unsupported-profile"`; byte-policy failures use
`"budget-exceeded"`. Native codec failures retain their error. Independent footer mismatches use `"checksum-mismatch"`.

The wrapper independently checks zlib header constraints, refuses preset dictionaries, and computes Adler32 as output
arrives. It independently computes gzip CRC32/ISIZE too; the native codec owns gzip optional-header parsing and DEFLATE
decoding. Those checks use constant-size checksum/trailer state. They do not replace a structural DEFLATE parser or
cryptographic verification. Successful gzip/zlib EOF establishes the applicable plaintext/footer checksum scope, not
canonical encoding or authentication of metadata.

Raw DEFLATE has no checksum. `readCompressedTar()` therefore reports `compression.integrity: "none"` for raw input, even
at native EOF. On Deno 2.9.8 the native raw decoder can return shortened plaintext and EOF for a truncated final block;
native EOF does not independently prove structural DEFLATE completeness. TAR end markers also do not prove the absence
of truncated later raw content. Callers that require complete raw bytes must check a trusted expected length/hash or use
an appropriate framed profile. Zlib checksum validation was added because the same runtime's native zlib decoder alone
also accepted corrupt/missing Adler32 bytes. Tests record these native differences without requiring other engines to
share them.

## Budgets and ownership

Each operation uses finite `ArchiveLimitsType` defaults: 64 MiB source bytes, 4096 producer reads, 64 MiB decoded bytes
and 16 MiB output bytes. During compression, source/decoded work counts plain input and output counts encoded bytes.
During decompression, source counts compressed input, decoded counts entire native output chunks and output counts
delivered views. A small selected output can require more decoded work than it returns. Producer EOF attempts and empty
chunks count against the request budget.

Additional compression options are:

| Option               | Default    | Boundary                                                                                                                        |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `maxChunkBytes`      | 64 KiB     | An acquired producer chunk. A larger chunk is rejected after receipt; its producer controls that allocation.                    |
| `inputChunkBytes`    | 1024 bytes | One native write after splitting producer chunks. Maximum 64 KiB. Smaller writes limit admitted work per native transform step. |
| `maxCodecChunkBytes` | 4 MiB      | A native output chunk, checked after native allocation and before delivery.                                                     |
| `outputChunkBytes`   | 64 KiB     | One delivered view. Output views can be smaller than the retained native chunk.                                                 |

Native codec state and internal queues are opaque. These bounds control this library's producer retention, submitted
input, admitted decoded work and delivered output. They are not a hard bound on memory already allocated inside the
native codec, upstream memory, CPU time or wall-clock duration. Producer chunks are split without collecting the input;
one acquired producer chunk and one acquired native output chunk can be retained. While waiting for native output the
codec can require more input or buffer internally. Once this wrapper retains an output chunk, further producer reads
wait for renewed output demand, apart from an already active step. `Blob.stream()` chunk sizes vary by runtime: a large
Blob can require a caller-owned bounded producer or an explicit larger `maxChunkBytes`. Large PAX metadata emitted by a
TAR writer is also subject to the compression producer limit.

Compressed TAR options keep `compression` and `tar` policy separate. `result.work` reports TAR parsing/selected payload
work; `result.compression.work` reports compressed acquisition, total expanded bytes and decoder delivery, including the
footer drain. Layer counters overlap by design: expanded bytes are codec output and TAR input. Do not add them and call
the sum physical network traffic. A caller-owned `ledger` can aggregate reservations across operations or layers, but
will count each layer's declared work. Reservations are not refunded after failure.

No source reader is acquired until the returned codec stream is pulled. Once acquired, the operation owns its reader,
awaits cancellation on stop/error/abort, and releases locks before completion. Compression factories themselves do not
open files or acquire credentials. Cancelling an output before its first pull leaves the unacquired producer untouched.
Errors preserve the primary source/codec failure and independently observed cleanup failures. `signal` is cooperative:
an upstream cancellation hook must settle. There is no forced deadline or hidden retry.

`readCompressedTar()` and `createCompressedTar()` accept one top-level `signal` and combine it with any layer signals.
This authority reaches TAR consumption/production and the final decoder drain. A stream or body is consumed once;
retrying requires a new source and, for writing, a new entry sequence/body streams. These operations do not publish a
transfer checkpoint or guarantee rollback of output already emitted.

## Evidence

`tests/fixtures/compression/create.py` uses Python 3.9.6 stdlib gzip/zlib 1.2.12 to produce inert independent gzip,
zlib, raw-DEFLATE, expansion and compressed-PAX-TAR fixtures. `independent.json` records compressed-byte SHA-256 hashes
and a complete payload oracle. The TAR bytes come from the independently produced TAR fixtures, not this writer.
`tests/compress.test.ts` checks split input, every output byte, corruption/truncation, limits, foreign native bytes,
backpressure, abort, cancellation, cleanup errors and complete/partial TAR checksum scopes. Its independently built gzip
optional-header fixture is verified by Python zlib and exercises FTEXT, FEXTRA, FNAME, FCOMMENT and FHCRC. Valid
byte-split headers decode; corrupt FHCRC, reserved flags, invalid methods and unterminated optional fields reject
through the native header parser. `tests/compress-process.test.ts` sends all three native encodings and a gzip TAR to
Python gzip/zlib/tarfile consumers with 10-second and 64-KiB subprocess-output bounds. These are compatibility and
resource controls, not a complete compression conformance corpus or performance result.

The API follows the [WHATWG Compression Streams specification](https://compression.spec.whatwg.org/), with format
definitions from [RFC1950](https://www.rfc-editor.org/rfc/rfc1950), [RFC1951](https://www.rfc-editor.org/rfc/rfc1951)
and [RFC1952](https://www.rfc-editor.org/rfc/rfc1952). This implementation supports the three profiles listed here;
newer native codec names do not automatically expand its public profile set.

## Optional Brotli and Zstandard

```ts
import { decompressStream } from "@okikio/opfs/archive/compress";

export function decodePreview(input: ReadableStream<Uint8Array>, signal: AbortSignal) {
  return decompressStream(input, "brotli", {
    signal,
    maxSourceBytes: 1024 * 1024,
    maxDecodedBytes: 4 * 1024 * 1024,
    maxOutputBytes: 4 * 1024 * 1024,
    outputChunkBytes: 4096,
  });
}
```

The returned stream owns the acquired input reader. Consume or cancel it; importing this module does not acquire a
codec. Brotli follows RFC7932 and is now included by the [Compression Standard](https://compression.spec.whatwg.org/).
`zstd` names a host extension and is not part of that standard's current format enum. Both formats require native
support for the selected direction. The reviewed living-standard revision is
[`94b42518d2c2f97e64bd5a483d6deb8c8f14c365`](https://compression.spec.whatwg.org/commit-snapshots/94b42518d2c2f97e64bd5a483d6deb8c8f14c365/);
that immutable snapshot records the review, while the living standard remains the current reference. Unsupported
constructors fail synchronously before acquiring the input reader; the library does not substitute Node modules,
download a codec or add a runtime package. No version string is used as a capability oracle. The installed Deno2.9.8,
Node26.13.0 and Bun1.4.2 support Brotli; only Bun's native Web stream constructors support Zstandard in this recorded
environment. These observations do not promise support in older runtimes or browsers.

Brotli has no content checksum. Zstandard can include optional frame checksums, but this wrapper neither parses their
presence nor independently verifies them. Native parsing, dictionaries, window allocation, concatenated frames and
trailing-data acceptance remain host behavior. Successful native EOF therefore reports `compression.integrity: "none"`
in the TAR composition for both formats. It is not proof of authenticated content or strict single-frame conformance. A
trusted expected digest/length is still needed when those properties matter. Early TAR preview remains incomplete and
does not certify unseen content. Existing input/output/work limits, cancellation and native-allocation limits apply.

Independent signed Debian `brotli`1.0.9-2+deb12u1 and `zstd`1.5.4+dfsg2-5 CLIs produce and independently decode the
retained binary/empty fixtures. Tests compare complete authored bytes across tiny chunks, reject truncated fixtures and
excess decoded work on supported hosts, compose a TAR and exercise explicit refusal on unsupported hosts. Those cases
establish their exercised profiles, not all dialects or native codec implementations. See the
[retained fixture receipt](https://github.com/okikio/opfs/blob/cfa022f/tests/fixtures/compression/NATIVE.md) for
reproduction instructions and source/encoded-byte hashes; no producer executable enters the package.
