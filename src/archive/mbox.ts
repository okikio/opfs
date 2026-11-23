/** Explicit LF-native mboxo/mboxrd indexing and MIME preview sources. @module */
import type { ByteSourceType } from "../source.ts";
import { sourceRange } from "../source.ts";
import { ArchiveBudget, ArchiveError, createArchiveLedger, integer, invalid, unsupported } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
export { ArchiveError, createArchiveLedger } from "./record.ts";
export type { ArchiveErrorCodeType, ArchiveLedgerType, ArchiveLimitsType, ArchiveWorkType } from "./record.ts";

/** A physical region, including all trailing message bytes but excluding its envelope. */
export interface MboxEntryType {
  readonly id: number;
  readonly envelope: string;
  readonly envelopeOffset: number;
  readonly offset: number;
  readonly size: number;
}
/** Chosen framing is a caller assertion, not automatic format detection. */
export interface MboxOpenOptionsType extends ArchiveLimitsType {
  readonly dialect: "mboxo" | "mboxrd";
  readonly signal?: AbortSignal;
  readonly allowUnverifiedSource?: boolean;
  /** Default 10000. */
  readonly maxMessages?: number;
  /** ASCII envelope bytes excluding LF. Default 4096. */
  readonly maxEnvelopeBytes?: number;
  /** Retained envelope bytes plus 64 accounted bytes per entry. Default 4 MiB. */
  readonly maxMetadataBytes?: number;
  /** Physical read ceiling, 1..65536; default 4096. */
  readonly maxChunkBytes?: number;
}
/** No removal of a producer-owned trailing blank line is implicit. */
export interface MboxMessageOptionsType extends ArchiveLimitsType {
  readonly trailing: "preserve" | "remove-one";
  readonly signal?: AbortSignal;
  /** Maximum retained range-map pieces. Default 100000. */
  readonly maxPieces?: number;
  /** Accounted map size, 32 bytes per piece. Default 4 MiB; not a JS heap estimate. */
  readonly maxMetadataBytes?: number;
}
/** Every read is a preview conversion, never evidence of original signed bytes. */
export interface MboxMessageType {
  readonly source: ByteSourceType;
  readonly transformation: {
    readonly newline: "lf-to-crlf";
    readonly quoting: "mboxrd-unquote-one" | "mboxo-stored-quotes";
    readonly trailing: "preserve" | "remove-one";
    readonly integrity: "none";
  };
  /** Scan work plus cumulative reads; range reads do not reset the limits supplied at opening. */
  inspect(): ArchiveWorkType;
}
/** The source is borrowed. Indexing scans all bytes; opening a message scans that region again. */
export interface MboxArchiveType {
  readonly entries: readonly MboxEntryType[];
  readonly work: ArchiveWorkType;
  readonly source: {
    readonly identity?: string;
    readonly stability: "immutable" | "provider" | "caller" | "unverified";
  };
  readRaw(
    id: number,
    options?: ArchiveLimitsType & { readonly signal?: AbortSignal; readonly offset?: number; readonly length?: number },
  ): Promise<{ readonly bytes: Uint8Array; readonly integrity: "none"; readonly work: ArchiveWorkType }>;
  openMessage(id: number, options: MboxMessageOptionsType): Promise<MboxMessageType>;
}

/** Map pieces either copy an exact physical extent or synthesize CR before a stored LF. */
interface PieceType {
  readonly start: number;
  readonly offset: number;
  readonly size: number;
  readonly cr: boolean;
}

function cap(value: number, maximum: number, label: string): void {
  if (value > maximum) throw new ArchiveError("budget-exceeded", `${label} limit exceeded.`);
}

/** Walks without buffering a whole line, including malformed very long body lines. */
async function scan(
  work: ArchiveBudget,
  offset: number,
  size: number,
  chunk: number,
  visit: (byte: number, offset: number) => void,
): Promise<void> {
  const end = offset + size;
  for (let at = offset; at < end;) {
    const bytes = await work.read(at, Math.min(chunk, end - at));
    for (let index = 0; index < bytes.length; index++) visit(bytes[index]!, at + index);
    at += bytes.length;
  }
}

/** Index two explicit LF-only profiles; Content-Length never controls these delimiters. */
export async function openMbox(input: ByteSourceType, options: MboxOpenOptionsType): Promise<MboxArchiveType> {
  if (options.dialect !== "mboxo" && options.dialect !== "mboxrd") {
    unsupported("Choose mboxo or mboxrd explicitly; other mailbox dialects are unsupported.");
  }
  const dialect = options.dialect;
  const { size, identity, stability } = input;
  integer(size, "Source size");
  const read = input.read.bind(input);
  const source: ByteSourceType = {
    size,
    read,
    ...(identity === undefined ? {} : { identity }),
    ...(stability === undefined ? {} : { stability }),
  };
  if (!stability && !options.allowUnverifiedSource) {
    unsupported("MBOX inspection needs a stable source or explicit unverified-source acceptance.");
  }
  if (stability && !["immutable", "provider", "caller"].includes(stability)) {
    throw new TypeError("Unknown source stability evidence.");
  }
  const chunk = options.maxChunkBytes ?? 4096;
  const messages = options.maxMessages ?? 10000;
  const envelopeMaximum = options.maxEnvelopeBytes ?? 4096;
  const metadataMaximum = options.maxMetadataBytes ?? 4 * 1024 * 1024;
  for (const [label, maximum] of Object.entries({ chunk, messages, envelopeMaximum, metadataMaximum })) {
    integer(maximum, label);
  }
  if (chunk < 1 || chunk > 65536) throw new RangeError("maxChunkBytes must be 1..65536.");
  const work = new ArchiveBudget(source, options, options.signal);
  options.signal?.throwIfAborted();
  const pending: MboxEntryType[] = [];
  let metadata = 0;
  let lineStart = 0;
  let lineLength = 0;
  let prefix = "";
  let envelope = "";
  let candidate = false;
  let previousEmpty = false;
  const state: { current: { id: number; envelope: string; envelopeOffset: number; offset: number } | undefined } = {
    current: undefined,
  };
  await scan(work, 0, size, chunk, (byte, at) => {
    if (byte === 13) unsupported("This mailbox profile accepts LF only, not CR or CRLF.");
    if (byte !== 10) {
      lineLength++;
      if (prefix.length < 5) {
        prefix += String.fromCharCode(byte);
        candidate = prefix === "From ";
        if (candidate) envelope = prefix;
      } else if (candidate) envelope += String.fromCharCode(byte);
      if (candidate) {
        cap(lineLength, envelopeMaximum, "MBOX envelope");
        if (byte < 32 || byte > 126) invalid("MBOX envelope must be printable ASCII.");
      }
      return;
    }
    if (candidate) {
      if (envelope.length <= 5) invalid("MBOX envelope has no sender or date metadata.");
      if (state.current) {
        if (!previousEmpty) invalid("MBOX message requires a terminal empty line in this profile.");
        pending.push(Object.freeze({ ...state.current, size: lineStart - state.current.offset }));
      } else if (lineStart !== 0) invalid("MBOX must start with an envelope separator.");
      cap(pending.length + 1, messages, "MBOX messages");
      cap(envelope.length + 64, metadataMaximum - metadata, "MBOX metadata");
      metadata += envelope.length + 64;
      state.current = { id: pending.length, envelope, envelopeOffset: lineStart, offset: at + 1 };
    } else if (!state.current) invalid("MBOX must start with an envelope separator.");
    previousEmpty = lineLength === 0;
    lineStart = at + 1;
    lineLength = 0;
    prefix = "";
    envelope = "";
    candidate = false;
  });
  if (size && (!state.current || lineStart !== size || !previousEmpty)) {
    invalid("MBOX requires a final terminal empty line.");
  }
  if (state.current) pending.push(Object.freeze({ ...state.current, size: size - state.current.offset }));
  const entries = Object.freeze(pending);
  function at(id: number): MboxEntryType {
    integer(id, "MBOX ordinal");
    const entry = entries[id];
    if (!entry) throw new RangeError("MBOX ordinal does not exist.");
    return entry;
  }
  return {
    entries,
    work: work.inspect(),
    source: Object.freeze({ ...(identity === undefined ? {} : { identity }), stability: stability ?? "unverified" }),
    async readRaw(id, policy = {}) {
      const entry = at(id);
      const offset = policy.offset ?? 0;
      const length = policy.length ?? entry.size - offset;
      sourceRange(entry.size, offset, length);
      const budget = new ArchiveBudget(source, policy, policy.signal);
      budget.output(length);
      const result = new Uint8Array(length);
      for (let written = 0; written < length;) {
        const bytes = await budget.read(entry.offset + offset + written, Math.min(chunk, length - written));
        result.set(bytes, written);
        written += bytes.length;
      }
      policy.signal?.throwIfAborted();
      return { bytes: result, integrity: "none", work: budget.inspect() };
    },
    async openMessage(id, requestPolicy) {
      const policy = { ...requestPolicy };
      const entry = at(id);
      if (policy.trailing !== "preserve" && policy.trailing !== "remove-one") {
        throw new TypeError("Choose a trailing blank-line policy explicitly.");
      }
      const maximum = policy.maxPieces ?? 100000;
      const metadata = policy.maxMetadataBytes ?? 4 * 1024 * 1024;
      integer(maximum, "maxPieces");
      integer(metadata, "maxMetadataBytes");
      policy.signal?.throwIfAborted();
      const total = createArchiveLedger(policy);
      const ledger = {
        reserve(kind: keyof ArchiveWorkType, count: number): void {
          total.reserve(kind, count);
          policy.ledger?.reserve(kind, count);
        },
        inspect: () => total.inspect(),
      };
      const budget = new ArchiveBudget(source, { ...policy, ledger }, policy.signal);
      const pieces: PieceType[] = [];
      let logicalSize = 0;
      let copied = entry.offset;
      const end = entry.offset + entry.size - (policy.trailing === "remove-one" ? 1 : 0);
      function piece(offset: number, length: number, cr: boolean): void {
        if (!length) return;
        cap(pieces.length + 1, maximum, "MBOX range map pieces");
        cap(pieces.length + 1, Math.floor(metadata / 32), "MBOX range map metadata");
        integer(logicalSize + length, "Converted message size");
        pieces.push({ start: logicalSize, offset, size: length, cr });
        logicalSize += length;
      }
      function edit(offset: number, remove: boolean): void {
        piece(copied, offset - copied, false);
        if (!remove) piece(offset, 1, true);
        copied = offset + (remove ? 1 : 0);
      }
      let start = entry.offset;
      let quotes = 0;
      let match = 0;
      let prefix = true;
      const marker = [70, 114, 111, 109, 32];
      await scan(budget, entry.offset, end - entry.offset, chunk, (byte, offset) => {
        if (byte === 10) {
          edit(offset, false);
          start = offset + 1;
          quotes = 0;
          match = 0;
          prefix = true;
        } else if (dialect === "mboxrd" && prefix) {
          if (match === 0 && byte === 62) quotes++;
          else if (byte === marker[match]) {
            match++;
            if (match === marker.length) {
              if (quotes) edit(start, true);
              prefix = false;
            }
          } else prefix = false;
        }
      });
      piece(copied, end - copied, false);
      // Scan does not return decoded bytes. Range reads charge only the logical bytes actually produced.
      const transformation = Object.freeze({
        newline: "lf-to-crlf" as const,
        quoting: dialect === "mboxrd" ? "mboxrd-unquote-one" as const : "mboxo-stored-quotes" as const,
        trailing: policy.trailing,
        integrity: "none" as const,
      });
      const converted: ByteSourceType = {
        size: logicalSize,
        ...(stability === undefined ? {} : { stability }),
        // Derived identity preserves snapshot provenance without pretending preview conversion is original wire data.
        ...(identity === undefined
          ? {}
          : { identity: JSON.stringify(["mbox-preview", identity, id, dialect, policy.trailing]) }),
        async read(offset, length, request = {}) {
          policy.signal?.throwIfAborted();
          request.signal?.throwIfAborted();
          sourceRange(logicalSize, offset, length);
          const signal = request.signal && policy.signal
            ? AbortSignal.any([request.signal, policy.signal])
            : request.signal ?? policy.signal;
          const rangeBudget = new ArchiveBudget(source, { ...policy, ledger }, signal);
          rangeBudget.decoded(length);
          rangeBudget.output(length);
          const result = new Uint8Array(length);
          if (!length) return result;
          let low = 0;
          let high = pieces.length;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (pieces[middle]!.start <= offset) low = middle + 1;
            else high = middle;
          }
          let index = Math.max(0, low - 1);
          let written = 0;
          while (written < length) {
            policy.signal?.throwIfAborted();
            request.signal?.throwIfAborted();
            const part = pieces[index++]!;
            const within = Math.max(0, offset + written - part.start);
            const take = Math.min(part.size - within, length - written);
            if (part.cr) {
              result[written++] = 13;
              continue;
            }
            for (let readBytes = 0; readBytes < take;) {
              const bytes = await rangeBudget.read(part.offset + within + readBytes, Math.min(chunk, take - readBytes));
              result.set(bytes, written + readBytes);
              readBytes += bytes.length;
            }
            written += take;
          }
          request.signal?.throwIfAborted();
          return result;
        },
      };
      return { source: Object.freeze(converted), transformation, inspect: () => total.inspect() };
    },
  };
}
