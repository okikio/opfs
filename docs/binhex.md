# Preview a BinHex file without losing its resource fork

A BinHex 4.0 attachment contains one file with two byte streams: a data fork and a resource fork. The resource fork may
hold application metadata that an ordinary file copy would discard. `openBinHex` preserves both, inspects the header,
and previews bounded selected bytes without extracting host files. This is the optional `archive-binhex` catalog
profile.

```ts
import { openBinHex } from "@okikio/opfs/archive/binhex";
import { createBlobSource } from "@okikio/opfs/source";

export async function preview(attachment: ArrayBuffer) {
  const archive = await openBinHex(createBlobSource(new Blob([attachment])), {
    maxPreambleBytes: 4096,
    maxForkBytes: 16 * 1024 * 1024,
    maxSourceBytes: 32 * 1024 * 1024,
    maxDecodedBytes: 32 * 1024 * 1024,
    maxOutputBytes: 1024 * 1024,
  });
  const result = await archive.read("data", { length: Math.min(256, archive.dataSize) });
  return {
    name: archive.name,
    bytes: result.bytes,
    dataIntegrity: result.data,
    resourceIntegrity: result.resource,
    terminalFraming: result.terminal,
    work: result.work,
  };
}
```

Opening verifies the header CRC16. The default data-fork read verifies the complete data fork before returning its
prefix. It does not inspect the resource fork or final framing, which remain `pending`. A resource-fork read must first
decode and verify the preceding data fork, then verify its own complete fork and terminal framing. `archive.verify()`
checks both forks and final framing without retaining their payloads.

CRC16 detects accidental corruption. An attacker can change the bytes and recompute the CRCs. No result authenticates a
publisher, name, freshness or source. This format has no native encryption.

## Replays, budgets and nested readers

Encoded offsets cannot be derived from decoded offsets. Every read starts decoding again from the beginning. A 37-byte
resource preview therefore decodes the preceding data fork and the complete resource fork by default. This is replayable
access over a borrowed `ByteSourceType`, rather than a physical random-access index.

For a partial selection with no complete selected-fork check, pass `verify: false`; its selected-fork evidence remains
`pending`. Any preceding complete data fork is still checked. Complete selections, including complete empty forks,
verify their CRC even when this option is false. Zero-length partial selections may stop after the mandatory header. An
unselected suffix corruption can make a verified prefix reject after its selected bytes have already been decoded.

`archive.member("data")` or `archive.member("resource")` returns an exact-byte source that another reader can borrow.
Each nested range replays preceding content, and a partial nested read makes no whole-fork CRC claim. Opening and member
ledgers, local lifetime limits and signals remain active for those replays. Passing the same external ledger at opening
and member creation does not charge that owner twice. A derived identity names the physical source and fork, not a
decoded filename; it is not authentication. The source's stability evidence is inherited only when provided.

Defaults are 4,096 preamble bytes (through the opening colon), 64 MiB per declared fork, 64 MiB source bytes, 64 MiB
decoded work, 16 MiB selected output and 4,096 source requests. `inputChunkBytes` defaults to 4,096 and accepts
1–65,536: larger windows reduce request count but may read ahead beyond the parsed header or selected range. Opening
work includes that read-ahead. The fork size cap does not increase the separate decoded-work allowance. Increase
aggregate allowances explicitly for repeated reads; no implicit reset bypasses the opening lifetime limits.

Output allowance is reserved before allocating selected output. Source windows are admitted before source I/O and owned
copying. RLE runs are admitted as a complete expansion before use, so a pending prefix may reserve more decoded work
than it consumes from its last run. Work counters report admitted source/request/decoded/output costs, with no refund
after cancellation or failure. Source work inside an arbitrary injected provider is outside these counters. Encoded
replay cost is not known from selected decoded offsets, so source and request exhaustion can occur during a read even
when selected-output admission succeeds.

The reader captures opening options, source methods/descriptor, name decoder and external ledger methods before its
first await. It owns bounded encoded windows, parser state, output chunks and returned byte copies. It borrows the
source and cancellation signals; it never closes the source. A provider must supply stable replay evidence via
`stability`, or the caller must explicitly accept an unverified source with `allowUnverifiedSource: true`.

For one genuine fixture with a 65,537-byte data fork and 99-byte resource fork, a verified 37-byte data selection at
offset 17 requested all 89,423 encoded source bytes in 22 windows and admitted 65,569 decoded bytes. The corresponding
pending selection requested one 4,096-byte window and admitted 84 decoded bytes. A verified resource selection admitted
65,670 decoded bytes. These are recorded work counts for that fixture and window size, not a general speed claim. The
benchmark compares those scopes with a decoded-Blob lower bound and full verification/streaming lanes; its source and
raw-distribution hashes are retained in fixture provenance.

## Stream provisional output

`archive.stream(fork, options)` returns a backpressured stream and an authoritative `finished` promise. Stream chunks
are provisional until that promise confirms the relevant fork CRC. A consumer must not treat an early prefix as
verified. A selected stream with default verification continues through the unselected suffix before successful
completion. Cancellation joins active source work and reports `cancelled: true` with whatever components were actually
completed; it does not claim whole-fork verification for incomplete content. An independent provider error during
cancellation still rejects. An immediate internal rejection observer prevents an unhandled rejection before a consumer
awaits `finished`, without changing its public rejection.

```ts
import { openBinHex } from "@okikio/opfs/archive/binhex";
import { createBlobSource } from "@okikio/opfs/source";

export async function copyData(attachment: ArrayBuffer, destination: WritableStream<Uint8Array>) {
  const archive = await openBinHex(createBlobSource(new Blob([attachment])), {
    maxForkBytes: 16 * 1024 * 1024,
    maxSourceBytes: 32 * 1024 * 1024,
    maxDecodedBytes: 32 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
  });
  const output = archive.stream("data");
  try {
    await output.stream.pipeTo(destination);
  } catch (pipelineError) {
    try {
      await output.finished;
    } catch (terminalError) {
      // The same decoder terminal error can be observed through both promises.
      if (terminalError === pipelineError) throw terminalError;
      throw new AggregateError([pipelineError, terminalError], "Destination and decoder failed.");
    }
    throw pipelineError;
  }
  return await output.finished;
}
```

The caller owns the destination. `pipeTo` propagates destination failure by cancelling the input stream; the catch above
also retains independent decoder failure. The identity comparison recognizes two observations of the same terminal
error, rather than deduplicating independent cleanup events. No hard completion deadline or source disposal is implied.

## Metadata and exact profile

`name` is inert metadata. `rawName`, `type` and `creator` return independent owned copies; `flags` preserves the raw
16-bit value. Default names are strict ASCII. `decodeName` receives an owned name copy and must return NUL-free text no
larger than 4,096 UTF-8 bytes. There is no implicit MacRoman decoding, pathname normalization, text newline conversion,
permission application or host extraction.

The initial profile admits only version-zero BinHex 4.0, one object, the exact RFC identifying comment at column one,
bounded ignored text before that comment, colon-delimited bodies with at most 64 characters per line, the fixed
alphabet, valid continuous RLE state, complete declared components and zero unused terminal bits. Only CR/LF may follow
the terminal colon. Other formats, versions, concatenated objects and trailing text refuse. Full terminal evidence
requires reaching the resource fork's end; a data-only read cannot provide it.

The native macutils producer uses a different comment. Default parsing refuses it. Explicit
`preamble: "rfc1741-or-macutils"` additionally accepts precisely that observed comment; `preambleProfile` records
`"macutils"` rather than hiding the compatibility choice. This option changes only the identifying comment, not body
syntax, lengths, checksums or terminal rules.

The Perl Convert::BinHex producer pads its packed input to a three-byte group using complete zero bytes after the
resource CRC. Default `padding: "canonical"` refuses that deviation. Explicit `padding: "convert-binhex"` requires
exactly `(3 - packedByteCount % 3) % 3` literal zero packed bytes (0–2), then a complete encoded quantum and closing
colon. It refuses pending RLE output, encoded RLE padding, nonzero bytes, missing bytes, excess zeros and wrong
alignment. This policy expects that producer's exact padding scheme; it is not a generic relaxation for all canonical
inputs.

`paddingPolicy` is exposed by the archive and every terminal result. `terminalPaddingBytes` is null before terminal
framing completes, then reports the observed zero count. The resource CRC covers its payload, not these padding bytes.
Header and data-only reads cannot establish the terminal padding count.

The [fixture provenance](../tests/fixtures/binhex/README.md) records immutable primary/source hashes and native proof.
Thirty-two unchanged genuine C/Perl outputs preserve every original fork through both native decoders. Strict C framing
and four unpadded Perl cases verify by default once the relevant banner policy is selected; twelve padded Perl cases
require the explicit padding policy. Six separately authored corruptions are refused by native C with CRC diagnostics;
Perl is only a full-byte oracle. A genuine nested ZIP exercises `openZip(archive.member("data"))`. No whole-format or
archive-writer completeness claim follows from this reader profile.
