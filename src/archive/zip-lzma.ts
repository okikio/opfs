/** ZIP method-14 framing over the bounded authored raw-LZMA1 decoder. @module */
import { createLzmaDecoder } from "./lzma.ts";
import type { LzmaLimitsType, LzmaResultType } from "./lzma.ts";
import { invalid, unsupported, view } from "./record.ts";
import type { ArchiveBudget, ArchiveLimitsType } from "./record.ts";
import type { ByteSourceType } from "../source.ts";
import { close } from "../close.ts";

/**
 * Optional raw-LZMA1 kernel policy. The archive/lzma defaults and hard ceilings apply.
 * ZIP owns framing, expected size, EOS requirement, byte ledgers and cancellation.
 */
export type ZipLzmaOptionsType = Pick<
  LzmaLimitsType,
  | "maxDictionaryBytes"
  | "maxMemoryBytes"
  | "maxDecisions"
  | "maxSteps"
  | "inputChunkBytes"
  | "yield"
>;

/**
 * Parse the bounded 2+2+5-byte ZIP LZMA prefix before constructing the kernel.
 * SDK version bytes identify the producer; the five property bytes select this
 * supported decoder profile. Raw EOS is mandatory and is not a standalone checksum.
 * Source work flows once into ZIP's ledger, internal codec output stays private,
 * and dictionary/decoded work remains distinct from selected returned bytes.
 */
export async function readZipLzma(
  source: ByteSourceType,
  offset: number,
  size: number,
  unpacked: number,
  limits: ArchiveLimitsType & { readonly signal?: AbortSignal; readonly lzma?: ZipLzmaOptionsType },
  budget: ArchiveBudget,
  complete: boolean,
  wanted: number,
  consume: (bytes: Uint8Array) => void,
): Promise<LzmaResultType> {
  if (size < 9) invalid("ZIP LZMA property prefix is truncated.");
  const prefix = await budget.read(offset, 9);
  if (view(prefix).getUint16(2, true) !== 5) {
    unsupported("ZIP LZMA requires exactly five property bytes.");
  }
  // Capture borrowed property bytes before another read can reuse their storage.
  const properties = prefix.slice(4, 9);
  const initial = budget.inspect(), remaining = budget.limits.maxDecodedBytes - initial.decodedBytes;
  const decoder = createLzmaDecoder({
    size: size - 9,
    ...(source.stability === undefined ? {} : { stability: source.stability }),
    read: (at, count, options) => source.read(offset + 9 + at, count, options),
  }, {
    ...limits.lzma,
    format: "raw-lzma1",
    properties,
    size: unpacked,
    marker: "required",
    ...(limits.signal === undefined ? {} : { signal: limits.signal }),
    allowUnverifiedSource: source.stability === undefined,
    maxSourceBytes: budget.limits.maxSourceBytes - initial.sourceBytes,
    maxRequests: budget.limits.maxRequests - initial.requests,
    maxDecodedBytes: remaining,
    maxOutputBytes: remaining,
    ledger: {
      reserve(kind, count) {
        if (kind === "decodedBytes") budget.decoded(count);
        else if (kind !== "outputBytes") limits.ledger?.reserve(kind, count);
      },
      inspect: () => budget.inspect(),
    },
  });
  const reader = decoder.stream.getReader();
  let decoded = 0, eof = false, failedRead = false;
  let terminal: LzmaResultType | undefined;
  let cancelledTerminal: { readonly reason: unknown } | undefined;
  let failures: unknown[] = [];
  try {
    while (complete || decoded < wanted) {
      limits.signal?.throwIfAborted();
      let next: Awaited<ReturnType<typeof reader.read>>;
      try {
        next = await reader.read();
      } catch (reason) {
        failedRead = true;
        throw reason;
      }
      limits.signal?.throwIfAborted();
      if (next.done) {
        eof = true;
        break;
      }
      consume(next.value);
      decoded += next.value.length;
    }
  } catch (reason) {
    failures = [reason];
  } finally {
    await close([
      async () => {
        if (eof || failedRead) return;
        try {
          await reader.cancel();
        } catch (reason) {
          // The owned LZMA cancel hook joins active work and rethrows its terminal
          // failure. Observe that same event once again through finished below.
          cancelledTerminal = { reason };
          if (failures.length && Object.is(reason, failures[0])) return;
          throw reason;
        }
      },
      async () => {
        try {
          terminal = await decoder.finished;
        } catch (reason) {
          // Both observation channels report the same owned decoder terminal event.
          // Independently failing cancellation/release actions remain separate.
          if (
            (failures.length && Object.is(reason, failures[0])) ||
            (cancelledTerminal && Object.is(reason, cancelledTerminal.reason))
          ) return;
          throw reason;
        }
      },
      () => reader.releaseLock(),
    ], failures);
  }
  limits.signal?.throwIfAborted();
  return terminal!;
}
