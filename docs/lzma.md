# Bounded LZMA previews

Decode an explicit `.lzma` Alone stream, raw LZMA1 stream, or raw LZMA2 stream into Web Stream chunks. The decoder
implements the codec locally; it does not load a runtime SDK. It does not parse a `.7z` or `.xz` container.

```ts
import { createLzmaDecoder } from "@okikio/opfs/archive/lzma";
import { createBlobSource } from "@okikio/opfs/source";

export async function decode(archive: Blob, destination: WritableStream<Uint8Array>) {
  const decoder = createLzmaDecoder(createBlobSource(archive), {
    format: "alone",
    maxSourceBytes: 8 * 1024 * 1024,
    maxDecodedBytes: 16 * 1024 * 1024,
    maxOutputBytes: 16 * 1024 * 1024,
    maxDictionaryBytes: 8 * 1024 * 1024,
    maxMemoryBytes: 16 * 1024 * 1024,
    maxDecisions: 64 * 1024 * 1024,
    maxSteps: 128 * 1024 * 1024,
  });
  try {
    await decoder.stream.pipeTo(destination);
  } catch (primary) {
    // pipeTo normally cancels upstream. Initiate cancellation if it did not.
    if (!decoder.stream.locked) await decoder.stream.cancel(primary).catch(() => {});
    try {
      await decoder.finished;
    } catch (terminal) {
      if (terminal === primary) throw primary;
      throw new AggregateError([primary, terminal], "Destination and decoder failed.");
    }
    throw primary;
  }
  return await decoder.finished;
}
```

The return value reports structural termination and logical work, with `integrity: "none"`. A complete decode checks the
exact packed extent, declared output size when present, and range-coder terminal state. It does not provide a checksum,
authentication, or evidence about who published the data. The enclosing container must supply and verify its own
checksum or authentication separately.

## Choose the exact profile

`format: "alone"` reads the 13-byte LZMA header. Its little-endian dictionary size has a minimum effective allocation of
4096 bytes. Its 64-bit output size must fit safe integer indexing; all-one bytes mean unknown size and require an end
marker. Known-size streams may finish without a marker only when the range code is zero and the exact packed extent has
ended. Extra packed bytes are refused.

Raw LZMA1 requires `format: "raw-lzma1"` and five `properties` bytes: one lc/lp/pb property followed by the
little-endian dictionary size. Optional `size` describes the exact output. `marker: "required"` always requires EOS;
`marker: "optional"` permits a marker-free known-size stream. Without a size, EOS is required in either policy. The
property bytes and options are copied when the handle is created, before any source operation.

Raw LZMA2 requires `format: "raw-lzma2"` and `dictionary`, the encoded LZMA2 property from 0 through 40, rather than a
byte count. For example, 8 describes a 64 KiB dictionary. Optional `size` is checked against the complete output. The
reader supports raw chunks and compressed chunks with dictionary, probability, state, and property resets. It rejects
missing required resets, reserved controls, inner LZMA1 EOS markers, chunk output overruns, incomplete packed chunks,
and bytes after the LZMA2 end control. `maxChunks` counts data chunks, not the end control.

All profiles deliberately require `lc + lp <= 4`. Larger literal models are unsupported even if their dictionaries fit.
There are no concatenated streams, filters, preset dictionaries, recovery mode, or automatic format detection.

## Preview and cancellation

Creation performs policy validation and captures the source descriptor; it starts no reads. Consumption allocates the
decoder and exact-range source cursor. Backpressure prevents another output quantum until the consumer asks for it. A
quantum returns at most 16 KiB. Its view can retain a 16 KiB backing buffer even when fewer bytes are returned. Callers
that retain chunks own that retained memory.

Cancel the reader after the prefix you need and await `finished`. A successful early cancellation reports
`status: "cancelled"` and `termination: "pending"`; it does not claim complete structural validation. Some plaintext can
be emitted before a later malformed token or missing terminal marker is discovered. Await `finished` before treating the
complete output as a structurally accepted stream.

The source is borrowed and is never closed. Cancellation and external abort wait for an outstanding exact-range read or
injected scheduling callback to settle. They cannot force a foreign provider to finish. A provider failure that arrives
while cancellation waits remains an error, rather than a successful cancellation. `finished` has an internal rejection
observer, so it is safe to attach the caller's observer after starting stream consumption; it still rejects with the
original failure. The example's identity comparison recognizes two observations of the same terminal failure, rather
than deduplicating independent release events.

Sources must declare `stability: "immutable"`, `"provider"`, or `"caller"`. `allowUnverifiedSource: true` explicitly
accepts missing stability evidence. A source identity is an optional bounded string, not an authentication claim.

## Resource accounting

Default source, decoded and output limits are 64 MiB, 64 MiB and 16 MiB; the request limit is 4096. Decoded work
includes plaintext plus framing bytes (the Alone header or LZMA2 chunk headers). Output counts every decoded byte
offered by the stream, including bytes a consumer later discards. Source bytes count logical exact-range requests, not
physical network traffic. `ledger` composes these counts with an enclosing archive reader and other operations; counts
are not refunded after refusal or cancellation.

`maxDictionaryBytes` defaults to 8 MiB, with a 64 MiB implementation ceiling. `maxMemoryBytes` defaults to 16 MiB, with
a 65 MiB ceiling. Its allocation policy covers the dictionary, the 65,600-byte packed cursor, a 16 KiB output quantum,
and probability arrays including replacement peak memory. It does not measure exact engine heap use, garbage-collection
timing, provider allocations, or buffers the consumer retains. A new dictionary or model is admitted before allocation.

`maxDecisions` defaults to 64 Mi binary range decisions, with a 512 Mi ceiling. `maxSteps` defaults to 128 Mi work
units, with a 1 Gi ceiling. A step is one range decision, one probability cell reset, or one dictionary byte written.
This also bounds repeated model resets and uncompressed chunks, which a range-decision-only limit would miss.
`maxChunks` defaults to 100,000, with a 1,000,000 ceiling. `inputChunkBytes` sets exact source request size from 1
through 65,536.

The scalar symbol decoder uses at most 48 range decisions for a new match. Adaptive probabilities remain between 31 and
2017 out of 2048; each decision requires at most one normalization byte. A 64-byte lookahead therefore admits a whole
symbol without a rollback buffer. At the actual tail, missing bytes fail; the decoder never invents zero padding. LZMA2
compressed chunks stage at most 65,536 packed bytes in the same cursor. Overlapping matches copy sequentially through
the dictionary, preserving LZMA semantics across wraparound.

The decoder checks cancellation between symbols and yields a stream quantum after at most 65,536 newly charged work
steps, except for one bounded symbol or model reset. Optional `yield` lets the caller inject an awaited task scheduling
boundary after a quantum. These are finite work policies, not elapsed-time guarantees. No runtime-specific scheduler or
top-level global configuration is installed.

## Evidence and maintenance

The [fixture producer](https://github.com/okikio/opfs/blob/18a4eda/tests/fixtures/lzma/create.py) uses genuine XZ Utils
raw and Alone encoders, native 7-Zip packed streams, and independent full-byte consumers. Known-size Alone and XZ
framing adaptations are labelled explicitly; they do not claim that the framing was emitted by the codec producer. The
provenance receipt pins producer source, fixture bytes, tools, and primary format sources. The fixtures exercise all 75
supported lc/lp/pb combinations, empty and literal output, overlapping matches, dictionary wraparound, and LZMA2 reset
forms. Tests also cover exact truncation, trailing bytes, policy exhaustion, captured options, backpressure,
cancellation during a borrowed read, abort and source failure propagation. No test executes the production decoder to
manufacture its expected payload.
