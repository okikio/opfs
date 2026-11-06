/** ZIP method-12 relay: codec work and caller output have separate accounting owners. @module */
import { createBzipDecoder } from "./bzip.ts";
import type { BzipOptionsType, BzipResultType } from "./bzip.ts";
import type { ArchiveBudget, ArchiveLimitsType } from "./record.ts";
import type { ByteSourceType } from "../source.ts";
import { close } from "../close.ts";

/**
 * Optional BZip2 kernel policy; defaults and implementation ceilings match archive/bzip.
 * These bound transformed blocks, typed scratch, CPU steps, scheduling and chunk sizes.
 * ZIP's opening/read byte ledgers and signals remain authoritative and cannot be replaced here.
 */
export type ZipBzipOptionsType = Pick<
  BzipOptionsType,
  | "maxBlockBytes"
  | "maxMemoryBytes"
  | "maxBlocks"
  | "maxSteps"
  | "inputChunkBytes"
  | "outputChunkBytes"
  | "yield"
>;

/**
 * Decode exactly one borrowed ZIP packed extent. No dictionary, provider or registry is acquired.
 * Source reservations flow once into ZIP's operation ledger; transformed/verification/replay work
 * flows into its decoded budget. Codec output is internal, so only ZIP's selected-copy step charges
 * caller output. Terminal settlement joins borrowed reads/yields even after prefix cancellation.
 */
export async function readZipBzip(
  source: ByteSourceType,
  offset: number,
  size: number,
  limits: ArchiveLimitsType & { readonly signal?: AbortSignal; readonly bzip?: ZipBzipOptionsType },
  budget: ArchiveBudget,
  complete: boolean,
  wanted: number,
  consume: (bytes: Uint8Array) => void,
): Promise<BzipResultType> {
  const initial = budget.inspect();
  const remaining = budget.limits.maxDecodedBytes - initial.decodedBytes;
  const decoder = createBzipDecoder({
    size,
    ...(source.stability === undefined ? {} : { stability: source.stability }),
    read: (at, count, options) => source.read(offset + at, count, options),
  }, {
    ...limits.bzip,
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
  let terminal: BzipResultType | undefined;
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
      () => eof || failedRead ? undefined : reader.cancel(),
      async () => {
        try {
          terminal = await decoder.finished;
        } catch (reason) {
          // stream.read and finished observe the same decoder terminal event.
          // This does not remove independent reader-release/cancellation failures.
          if (failures.length && Object.is(reason, failures[0])) return;
          throw reason;
        }
      },
      () => reader.releaseLock(),
    ], failures);
  }
  limits.signal?.throwIfAborted();
  return terminal!;
}
