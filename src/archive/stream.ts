import { isBytes, toView } from "../bytes.ts";
import { ArchiveError, createArchiveLedger, integer, invalid } from "./record.ts";
import type { ArchiveLimitsType, ArchiveWorkType } from "./record.ts";
import { TarHeaders, tarPadding } from "./tar.ts";
import type { TarEntryType, TarOpenOptionsType } from "./tar.ts";

export interface TarStreamOptionsType extends Omit<TarOpenOptionsType, "allowUnverifiedSource"> {
  /** Reject a larger producer chunk after receiving it. The producer controls its allocation. Default 64 KiB. */
  readonly maxChunkBytes?: number;
  /** Maximum byte view delivered by one body iteration. Set a smaller size for bounded prefixes. Default 64 KiB. */
  readonly bodyChunkBytes?: number;
}

export interface TarScanType {
  readonly entries: number;
  /** False when the visitor stops before the required two zero blocks. */
  readonly complete: boolean;
  readonly integrity: "header-checksum-only";
  readonly work: ArchiveWorkType;
}

/** Each body is single-use and valid only until its visitor settles. Links have empty bodies and are never followed. */
export type TarVisitorType = (
  entry: TarEntryType,
  body: AsyncIterable<Uint8Array>,
) => void | boolean | Promise<void | boolean>;

/**
 * Scan one uncompressed TAR stream. Awaited visitor consumption applies backpressure;
 * unread member bytes are drained under the same source/decoded budgets before the next header.
 * Return false to stop without draining. This operation owns the acquired reader and cancels
 * it on completion, stop, abort, or failure, then releases its lock. It offers no random access.
 */
export async function readTarStream(
  source: ReadableStream<Uint8Array>,
  visit: TarVisitorType,
  options: TarStreamOptionsType = {},
): Promise<TarScanType> {
  const headers = new TarHeaders(options);
  const bodyChunkBytes = options.bodyChunkBytes ?? 64 * 1024;
  integer(bodyChunkBytes, "Body chunk size");
  if (bodyChunkBytes === 0) throw new RangeError("Body chunk size must be positive.");
  const cursor = new TarCursor(source, options);
  let entries = 0;
  let failure: unknown;
  let failed = false;
  try {
    while (true) {
      const entry = await headers.next(
        (length) => cursor.read(length),
        (length) => cursor.reserve("decodedBytes", length),
      );
      if (!entry) return { entries, complete: true, integrity: "header-checksum-only", work: cursor.inspect() };
      entries++;
      let remaining = entry.size;
      let active = true;
      let started = false;
      let pending = false;
      const body: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          if (!active || started) throw new TypeError("TAR body is single-use and only valid inside its visitor.");
          started = true;
          return (async function* () {
            while (remaining > 0) {
              if (!active) throw new TypeError("TAR body visitor has already settled.");
              pending = true;
              let bytes: Uint8Array;
              try {
                bytes = await cursor.take(Math.min(remaining, bodyChunkBytes));
                cursor.reserve("decodedBytes", bytes.length);
                cursor.reserve("outputBytes", bytes.length);
                remaining -= bytes.length;
              } finally {
                pending = false;
              }
              if (!active) throw new TypeError("TAR body visitor has already settled.");
              yield bytes;
            }
          })();
        },
      };
      let proceed: void | boolean;
      try {
        proceed = await visit(entry, body);
      } finally {
        active = false;
      }
      if (pending) throw new TypeError("Await TAR body reads before returning from the visitor.");
      if (proceed === false) {
        return { entries, complete: false, integrity: "header-checksum-only", work: cursor.inspect() };
      }
      while (remaining > 0) {
        const bytes = await cursor.take(remaining);
        cursor.reserve("decodedBytes", bytes.length);
        remaining -= bytes.length;
      }
      await cursor.read(tarPadding(entry.size));
    }
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    await cursor.close(failed, failure);
  }
}

/** One retained producer chunk plus bounded exact header/metadata copies; no hidden whole-archive buffer. */
class TarCursor {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #ledger: ReturnType<typeof createArchiveLedger>;
  readonly #shared: ArchiveLimitsType["ledger"];
  readonly #signal: AbortSignal | undefined;
  readonly #maximum: number;
  readonly #abort: () => void;
  #chunk: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #cancelled: Promise<void> | undefined;

  constructor(source: ReadableStream<Uint8Array>, options: TarStreamOptionsType) {
    this.#ledger = createArchiveLedger(options);
    this.#shared = options.ledger;
    this.#maximum = options.maxChunkBytes ?? 64 * 1024;
    integer(this.#maximum, "Producer chunk limit");
    if (this.#maximum === 0) throw new RangeError("Producer chunk limit must be positive.");
    options.signal?.throwIfAborted();
    this.#signal = options.signal;
    this.#reader = source.getReader();
    this.#abort = () => {
      void this.#cancel(this.#signal?.reason).catch(() => {});
    };
    this.#signal?.addEventListener("abort", this.#abort, { once: true });
  }

  reserve(kind: keyof ArchiveWorkType, count: number): void {
    this.#ledger.reserve(kind, count);
    this.#shared?.reserve(kind, count);
  }

  inspect(): ArchiveWorkType {
    return this.#ledger.inspect();
  }

  async take(maximum: number): Promise<Uint8Array> {
    this.#signal?.throwIfAborted();
    while (this.#offset === this.#chunk.length) {
      this.reserve("requests", 1);
      const result = await this.#reader.read();
      this.#signal?.throwIfAborted();
      if (result.done) invalid("TAR stream ended before its member or end marker.");
      if (!isBytes(result.value)) invalid("TAR stream returned a non-byte chunk.");
      const bytes = toView(result.value);
      this.reserve("sourceBytes", bytes.length);
      if (bytes.length > this.#maximum) throw new ArchiveError("budget-exceeded", "TAR producer chunk limit exceeded.");
      this.#chunk = bytes;
      this.#offset = 0;
    }
    const length = Math.min(maximum, this.#chunk.length - this.#offset);
    const bytes = this.#chunk.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return bytes;
  }

  async read(length: number): Promise<Uint8Array> {
    const bytes = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await this.take(length - offset);
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  #cancel(reason?: unknown): Promise<void> {
    return this.#cancelled ??= this.#reader.cancel(reason);
  }

  async close(failed: boolean, failure?: unknown): Promise<void> {
    this.#signal?.removeEventListener("abort", this.#abort);
    try {
      await this.#cancel(failure);
    } catch (error) {
      if (!failed) throw error;
    } finally {
      this.#chunk = new Uint8Array();
      this.#reader.releaseLock();
    }
  }
}

export interface TarWriteEntryType {
  readonly name: string;
  readonly kind?: TarEntryType["kind"];
  readonly link?: string;
  /** Known uncompressed byte length. Non-file entries require zero. */
  readonly size: number;
  /** A file body is acquired lazily. Its reader is owned and cancelled after consumption. */
  readonly body?: ReadableStream<Uint8Array>;
}

export interface TarWriteOptionsType extends ArchiveLimitsType {
  readonly signal?: AbortSignal;
  readonly maxEntries?: number;
  readonly maxMetadataBytes?: number;
  readonly maxChunkBytes?: number;
}

/**
 * Emit deterministic uncompressed ustar with PAX path/linkpath/size extensions when needed.
 * Entries are consumed once in order. One output pull advances at most one yielded chunk;
 * cancellation retires the current body reader and the entry iterator. No host paths are opened.
 */
export function createTarStream(
  entries: AsyncIterable<TarWriteEntryType> | Iterable<TarWriteEntryType>,
  options: TarWriteOptionsType = {},
): ReadableStream<Uint8Array> {
  const ledger = createArchiveLedger(options);
  const maximum = options.maxEntries ?? 100_000;
  const metadataMaximum = options.maxMetadataBytes ?? 1024 * 1024;
  const chunkMaximum = options.maxChunkBytes ?? 64 * 1024;
  integer(maximum, "Entry limit");
  integer(metadataMaximum, "Metadata byte limit");
  integer(chunkMaximum, "Producer chunk limit");
  if (chunkMaximum === 0) throw new RangeError("Producer chunk limit must be positive.");
  options.signal?.throwIfAborted();
  let active: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  let metadata = 0;
  let count = 0;
  const reserve = (kind: keyof ArchiveWorkType, length: number) => {
    ledger.reserve(kind, length);
    options.ledger?.reserve(kind, length);
  };
  const abort = () => {
    void active?.cancel(options.signal?.reason).catch(() => {});
  };
  const iterator = (async function* () {
    try {
      for await (const entry of entries) {
        options.signal?.throwIfAborted();
        if (cancelled) return;
        if (count++ >= maximum) throw new ArchiveError("budget-exceeded", "TAR writer entry limit exceeded.");
        integer(entry.size, "Member size");
        const kind = entry.kind ?? "file";
        const type = { file: "0", directory: "5", "symbolic-link": "2", "hard-link": "1" }[kind];
        if (!type) throw new TypeError("Unsupported TAR writer member kind.");
        if (kind !== "file" && (entry.size !== 0 || entry.body)) {
          throw new TypeError("Non-file TAR entries cannot contain bodies.");
        }
        if (
          entry.name.length > Math.max(100, metadataMaximum - metadata) ||
          (entry.link?.length ?? 0) > Math.max(100, metadataMaximum - metadata)
        ) {
          throw new ArchiveError("budget-exceeded", "TAR writer metadata limit exceeded.");
        }
        const name = metadataText(entry.name, false);
        const link = metadataText(entry.link ?? "", true);
        if (kind === "file" && !entry.body && entry.size !== 0) {
          throw new TypeError("A nonempty TAR file requires a body.");
        }
        const records: Uint8Array[] = [];
        const extendedName = name.length > 100 || name.some((byte) => byte > 127);
        if (extendedName) records.push(paxRecord("path", entry.name));
        if (link.length > 100 || link.some((byte) => byte > 127)) records.push(paxRecord("linkpath", entry.link!));
        if (entry.size > 0o77777777777) records.push(paxRecord("size", String(entry.size)));
        const size = records.reduce((sum, record) => sum + record.length, 0);
        if (size > metadataMaximum - metadata) {
          throw new ArchiveError("budget-exceeded", "TAR writer metadata limit exceeded.");
        }
        metadata += size;
        if (size > 0) {
          yield header("PaxHeader", size, "x", "");
          for (const record of records) yield record;
          if (tarPadding(size)) yield new Uint8Array(tarPadding(size));
        }
        yield header(
          extendedName ? "PaxMember" : entry.name,
          entry.size > 0o77777777777 ? 0 : entry.size,
          type,
          link.length <= 100 ? entry.link ?? "" : "",
        );
        let remaining = entry.size;
        if (entry.body) {
          active = entry.body.getReader();
          let bodyFailed = false;
          try {
            while (true) {
              options.signal?.throwIfAborted();
              reserve("requests", 1);
              const result = await active.read();
              options.signal?.throwIfAborted();
              if (cancelled) return;
              if (result.done) break;
              if (!isBytes(result.value)) invalid("TAR writer body returned non-byte data.");
              const bytes = toView(result.value);
              reserve("sourceBytes", bytes.length);
              if (bytes.length > chunkMaximum) {
                throw new ArchiveError("budget-exceeded", "TAR writer body chunk limit exceeded.");
              }
              if (bytes.length > remaining) invalid("TAR writer body exceeds its declared size.");
              reserve("decodedBytes", bytes.length);
              remaining -= bytes.length;
              if (bytes.length) yield bytes;
            }
          } catch (error) {
            bodyFailed = true;
            throw error;
          } finally {
            const reader = active;
            active = undefined;
            await closeBody(reader, bodyFailed);
          }
        }
        if (remaining !== 0) invalid("TAR writer body is shorter than its declared size.");
        if (tarPadding(entry.size)) yield new Uint8Array(tarPadding(entry.size));
      }
      yield new Uint8Array(1024);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  })();
  options.signal?.addEventListener("abort", abort, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        options.signal?.throwIfAborted();
        const result = await iterator.next();
        if (cancelled) return;
        if (result.done) controller.close();
        else {
          reserve("outputBytes", result.value.length);
          controller.enqueue(result.value);
        }
      } catch (error) {
        options.signal?.removeEventListener("abort", abort);
        controller.error(error);
        try {
          await iterator.return(undefined);
        } catch { /* Preserve the primary archive/source failure. */ }
      }
    },
    async cancel(reason) {
      cancelled = true;
      options.signal?.removeEventListener("abort", abort);
      try {
        await active?.cancel(reason);
      } finally {
        await iterator.return(undefined);
      }
    },
  }, { highWaterMark: 0 });
}

/** Report cleanup failures only when there is no primary body failure to preserve. */
async function closeBody(reader: ReadableStreamDefaultReader<Uint8Array>, failed: boolean): Promise<void> {
  try {
    await reader.cancel();
  } catch (error) {
    if (!failed) throw error;
  } finally {
    reader.releaseLock();
  }
}

function metadataText(value: string, empty: boolean): Uint8Array {
  if ((!empty && !value) || value.includes("\0")) {
    throw new TypeError("TAR metadata requires a nonempty name and no NUL.");
  }
  if (!value.isWellFormed()) throw new TypeError("TAR metadata must contain valid Unicode scalar values.");
  return new TextEncoder().encode(value);
}

/** Length includes its own decimal digits; solve the fixed point before encoding the record. */
function paxRecord(key: string, value: string): Uint8Array {
  const content = `${key}=${value}\n`;
  const bytes = new TextEncoder().encode(content).length;
  let length = bytes + 3;
  while (length !== bytes + String(length).length + 1) length = bytes + String(length).length + 1;
  return new TextEncoder().encode(`${length} ${content}`);
}

/** Minimal deterministic ustar header: portable modes, zero owner IDs and timestamps; no host metadata discovery. */
function header(name: string, size: number, type: string, link: string): Uint8Array {
  const bytes = new Uint8Array(512);
  const set = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  set(0, name);
  set(100, `${(type === "5" ? 0o755 : 0o644).toString(8).padStart(7, "0")}\0`);
  set(108, "0000000\0");
  set(116, "0000000\0");
  set(124, `${size.toString(8).padStart(11, "0")}\0`);
  set(136, "00000000000\0");
  bytes.fill(32, 148, 156);
  set(156, type);
  set(157, link);
  set(257, "ustar\0");
  set(263, "00");
  const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
  set(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return bytes;
}
