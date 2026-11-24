/**
 * Decodes one 7-Zip folder that uses a single LZMA or LZMA2 coder.
 *
 * The reader reads copy folders directly. Folders with other coders, or with more
 * than one coder, are listed in the index but not decoded.
 *
 * @module
 */
import { add } from "./cursor.ts";
import type { SevenCoderType, SevenLzmaOptionsType, SevenPackType } from "./types.ts";
import { ArchiveBudget } from "../budget.ts";
import { createLzmaDecoder } from "../lzma.ts";
import type { LzmaFormatType } from "../lzma.ts";
import type { ByteSourceType } from "../../source.ts";
import { invalid, unsupported } from "../error.ts";
import type { ArchiveLedgerType } from "../budget.ts";
import { crc32 } from "../../hash.ts";

/** Select a frozen codec from exact method properties; no registry or caller-supplied decoder runs. */
export function codec(coder: SevenCoderType): Exclude<LzmaFormatType, { format: "alone" }> | undefined {
  const count = coder.method === "030101" ? 5 : coder.method === "21" ? 1 : 0;
  if (count === 0) return undefined;
  if (coder.properties.length !== count * 2) throw invalid("7z LZMA coder property length is invalid.");
  const bytes = new Uint8Array(count);
  for (let at = 0; at < count; at++) bytes[at] = Number.parseInt(coder.properties.slice(at * 2, at * 2 + 2), 16);
  if (coder.method === "030101") {
    if (bytes.length !== 5 || bytes[0]! >= 225) throw invalid("7z LZMA1 properties must contain five valid bytes.");
    const lc = bytes[0]! % 9;
    const lp = Math.floor(bytes[0]! / 9) % 5;
    if (lc + lp > 4) return undefined;
    return { format: "raw-lzma1", properties: bytes, marker: "optional" };
  }
  if (coder.method === "21") {
    if (bytes.length !== 1 || bytes[0]! > 40) {
      throw invalid("7z LZMA2 properties must contain one valid dictionary byte.");
    }
    return { format: "raw-lzma2", dictionary: bytes[0]! };
  }
  return undefined;
}

/** Retain only codec policy fields. Container framing and work owners cannot be overwritten by foreign options. */
export function codecPolicy(options: SevenLzmaOptionsType = {}): SevenLzmaOptionsType {
  const result: Record<string, unknown> = {};
  for (
    const key of [
      "maxDictionaryBytes",
      "maxMemoryBytes",
      "maxDecisions",
      "maxSteps",
      "maxChunks",
      "inputChunkBytes",
      "yield",
    ] as const
  ) {
    if (options[key] !== undefined) result[key] = options[key];
  }
  return result;
}

/** Decoding visits one packed extent from its start. Packed and plaintext CRCs never share an accumulator.
 * The container charges source operations and selected output; the codec charges decoded work through the relay.
 * Decoder output is bounded scan work, not a second charge against returned archive bytes. */
export async function decode(
  snapshot: ByteSourceType,
  pack: SevenPackType,
  coder: SevenCoderType,
  size: number,
  offset: number,
  length: number,
  verify: boolean,
  budget: ArchiveBudget,
  policy: SevenLzmaOptionsType,
  signal?: AbortSignal,
  selectedOutput = true,
  decodedCredit = 0,
): Promise<{ bytes: Uint8Array; complete: boolean; packed: number; plain: number }> {
  const framing = codec(coder);
  if (!framing) throw unsupported("7z coder is outside the supported LZMA profile.");
  if (selectedOutput) budget.output(length);
  signal?.throwIfAborted();
  const output = new Uint8Array(length);
  if (!verify && length === 0) return { bytes: output, complete: false, packed: 0, plain: 0 };
  let packedState = 0xffffffff;
  let plainState = 0xffffffff;
  let packedRead = 0;
  const source: ByteSourceType = {
    size: pack.size,
    stability: snapshot.stability ?? "caller",
    async read(at, count) {
      if (at !== packedRead) throw invalid("7z decoder requested a nonsequential packed range.");
      const bytes = await budget.read(add(pack.offset, at), count);
      packedState = crc32(bytes, packedState);
      packedRead += count;
      return bytes;
    },
  };
  const relay: ArchiveLedgerType = {
    reserve(kind, count) {
      if (kind === "decodedBytes") {
        const credit = Math.min(decodedCredit, count);
        decodedCredit -= credit;
        budget.decoded(count - credit);
      }
    },
    inspect: () => budget.inspect(),
  };
  const decoder = createLzmaDecoder(source, {
    ...policy,
    ...framing,
    size,
    maxSourceBytes: budget.limits.maxSourceBytes,
    maxRequests: budget.limits.maxRequests,
    maxDecodedBytes: budget.limits.maxDecodedBytes,
    maxOutputBytes: size,
    ledger: relay,
    ...(signal === undefined ? {} : { signal }),
  });
  const reader = decoder.stream.getReader();
  let at = 0;
  let complete = false;
  let failed = false;
  let primary: unknown;
  const retain = (reason: unknown): void => {
    if (failed && reason === primary) return; // A second observation of this decoder's single terminal promise.
    primary = failed ? new AggregateError([primary, reason], "7z decode and retirement failed.") : reason;
    failed = true;
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        break;
      }
      const bytes = result.value;
      plainState = crc32(bytes, plainState);
      const end = add(at, bytes.length);
      const from = Math.max(at, offset);
      const until = Math.min(end, offset + length);
      if (until > from) output.set(bytes.subarray(from - at, until - at), from - offset);
      at = end;
      if (!verify && offset + length < size && at >= offset + length) break;
    }
  } catch (reason) {
    retain(reason);
  }
  if (!complete) {
    try {
      await reader.cancel();
    } catch (reason) {
      retain(reason);
    }
  }
  try {
    const terminal = await decoder.finished;
    if (terminal.status === "complete") complete = true;
  } catch (reason) {
    retain(reason);
  }
  reader.releaseLock();
  if (failed) throw primary;
  if (complete && (at !== size || packedRead !== pack.size)) throw invalid("7z decoded extent is incomplete.");
  return { bytes: output, complete, packed: (packedState ^ 0xffffffff) >>> 0, plain: (plainState ^ 0xffffffff) >>> 0 };
}
