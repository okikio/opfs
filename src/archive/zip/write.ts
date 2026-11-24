import { isBytes, toView } from "../../bytes.ts";
import { aggregate, close } from "../../close.ts";
import { openBytes } from "../../stream/mod.ts";
import type { ByteReaderType } from "../../stream/mod.ts";
import { assertInteger } from "../budget.ts";
import { crc32 } from "../../hash.ts";

/** A source is consumed only after its name and limits are admitted. No link entries are accepted. */
export interface ZipWriteEntryType {
  /** Portable, NFC relative path. Directory names end in a slash. */
  readonly name: string;
  /** Defaults to file. Directories must not supply a source or a nonzero size. */
  readonly kind?: "file" | "directory";
  /** Borrowed bytes or a stream whose acquired reader is owned by this write. */
  readonly source?: Uint8Array | ReadableStream<Uint8Array>;
  /** Optional uncompressed size. A mismatch errors the output, leaving an incomplete archive. */
  readonly size?: number;
  /**
   * How the ZIP stores the bytes. Defaults to `"store"`.
   *
   * Use `"store"` for data that is already compressed (a `.warc.gz`, a JPEG) or that
   * readers must reach by byte range. Use `"deflate"` for text such as JSON, CDXJ
   * and JSON Lines, which usually shrinks a lot.
   */
  readonly compression?: "store" | "deflate";
}

/** Finite limits apply before copying chunks or retaining another directory entry. */
export interface ZipWriteOptionsType {
  /** Cancels the output stream and retires the current entry source and the entry iterator. */
  readonly signal?: AbortSignal;
  /** Default 10,000; classic ZIP excludes the ZIP64 sentinel 65,535. */
  readonly maxEntries?: number;
  /** Default 16 MiB for retained central records, including encoded names. */
  readonly maxDirectoryBytes?: number;
  /** Default 64 MiB per entry; must be below the ZIP64 size sentinel. */
  readonly maxEntryBytes?: number;
  /** Default 1 GiB including headers, descriptors and directory; must be below 4 GiB. */
  readonly maxArchiveBytes?: number;
  /** Default 64 KiB for each admitted producer chunk and emitted payload chunk. */
  readonly maxChunkBytes?: number;
  /** Default 65,535, the format limit for one UTF-8 filename. */
  readonly maxNameBytes?: number;
  /** Default 64; bounds collision-index work and retained ancestor names. */
  readonly maxPathDepth?: number;
  /** Default 1,000,000 across all entries, including empty producer chunks. */
  readonly maxSourceChunks?: number;
  /**
   * Allows ZIP64 records, so entries and the archive may pass 4 GiB and the
   * archive may hold more than 65,534 entries. Defaults to `false`.
   *
   * With `true`, the limits above may exceed the ZIP32 bounds, and the writer
   * adds ZIP64 fields only where a size, offset or count needs them. An entry
   * whose size is unknown and whose limit passes 4 GiB gets ZIP64 sizes in its
   * local header and data descriptor, because a streaming writer cannot go back
   * and widen them.
   */
  readonly zip64?: boolean;
}

/** Kept until the final directory is emitted; source streams and payload bytes are never retained here. */
interface DirectoryType {
  readonly name: Uint8Array;
  readonly directory: boolean;
  readonly offset: number;
  /** Uncompressed size. */
  readonly size: number;
  /** Stored size: equal to `size` for STORED entries. */
  readonly compressed: number;
  readonly crc: number;
  /** 0 for STORED, 8 for DEFLATED. */
  readonly method: 0 | 8;
  /** The local header and descriptor used ZIP64 sizes. */
  readonly wide: boolean;
}
/** One acquired stream reader, with exactly one cancellation/release attempt. */
interface SourceOwnerType {
  readonly reader: ByteReaderType;
  complete: boolean;
  retirement?: Promise<void>;
}
/** ZIP32 uses these flags for UTF-8 names and non-seekable data descriptors. */
const ZIP_FLAGS = 0x0808;
/** The largest value a ZIP32 field holds. 0xffffffff is the ZIP64 sentinel and is never a real value here. */
const ZIP32_MAX = 0xfffffffe;
/** The ZIP64 sentinel for a 32-bit field. */
const WIDE = 0xffffffff;
/** The largest ZIP32 entry count. 0xffff is the ZIP64 sentinel. */
const COUNT_MAX = 0xfffe;

/**
 * The most bytes DEFLATE can produce for `size` input bytes.
 *
 * Incompressible input falls back to stored blocks, which add 5 bytes per 16 KiB
 * block or less; 64 bytes covers the stream header and final block.
 */
function bound(size: number, method: 0 | 8): number {
  return method === 0 ? size : size + Math.ceil(size / 16384) * 5 + 64;
}

/** Timestamp and permissions are deterministic; this writer does not inspect a clock or host filesystem. */
function local(name: Uint8Array, method: 0 | 8, wide: boolean): Uint8Array {
  const extra = wide ? 20 : 0;
  const bytes = new Uint8Array(30 + name.byteLength + extra);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 0x04034b50, true);
  data.setUint16(4, wide ? 45 : 20, true);
  data.setUint16(6, ZIP_FLAGS, true);
  data.setUint16(8, method, true);
  data.setUint16(12, 33, true); // 1980-01-01 00:00:00 in DOS fields.
  if (wide) {
    // The real sizes follow in the ZIP64 data descriptor.
    data.setUint32(18, WIDE, true);
    data.setUint32(22, WIDE, true);
  }
  data.setUint16(26, name.byteLength, true);
  data.setUint16(28, extra, true);
  bytes.set(name, 30);
  if (wide) {
    const at = 30 + name.byteLength;
    data.setUint16(at, 0x0001, true);
    data.setUint16(at + 2, 16, true);
  }
  return bytes;
}
/** A signed descriptor follows every entry, including zero-byte entries. ZIP64 entries use 8-byte sizes. */
function descriptor(crc: number, compressed: number, size: number, wide: boolean): Uint8Array {
  const bytes = new Uint8Array(wide ? 24 : 16);
  const data = new DataView(bytes.buffer);
  data.setUint32(0, 0x08074b50, true);
  data.setUint32(4, crc, true);
  if (wide) {
    data.setBigUint64(8, BigInt(compressed), true);
    data.setBigUint64(16, BigInt(size), true);
  } else {
    data.setUint32(8, compressed, true);
    data.setUint32(12, size, true);
  }
  return bytes;
}
/** Bytes one central record takes, so the directory budget is charged before the entry is written. */
function centralBytes(name: Uint8Array, zip64: boolean): number {
  // A ZIP64 extra field holds up to three 8-byte values after its 4-byte header.
  return 46 + name.byteLength + (zip64 ? 28 : 0);
}
/**
 * Only final, measured sizes and CRCs enter the central directory.
 *
 * A ZIP64 extra field carries the sizes when the entry used ZIP64 sizes or a
 * size passes ZIP32, and the offset when the offset passes ZIP32, in the order
 * the ZIP specification gives.
 */
function central(entry: DirectoryType): Uint8Array {
  const sizes = entry.wide || entry.size > ZIP32_MAX || entry.compressed > ZIP32_MAX;
  const offset = entry.offset > ZIP32_MAX;
  const extra = sizes || offset ? 4 + (sizes ? 16 : 0) + (offset ? 8 : 0) : 0;
  const bytes = new Uint8Array(46 + entry.name.byteLength + extra);
  const data = new DataView(bytes.buffer);
  const zip64 = extra > 0;
  data.setUint32(0, 0x02014b50, true);
  data.setUint16(4, zip64 ? 0x032d : 0x0314, true);
  data.setUint16(6, zip64 ? 45 : 20, true);
  data.setUint16(8, ZIP_FLAGS, true);
  data.setUint16(10, entry.method, true);
  data.setUint16(14, 33, true);
  data.setUint32(16, entry.crc, true);
  data.setUint32(20, sizes ? WIDE : entry.compressed, true);
  data.setUint32(24, sizes ? WIDE : entry.size, true);
  data.setUint16(28, entry.name.byteLength, true);
  data.setUint16(30, extra, true);
  data.setUint32(38, entry.directory ? 0x41ed0010 : 0x81a40000, true);
  data.setUint32(42, offset ? WIDE : entry.offset, true);
  bytes.set(entry.name, 46);
  if (zip64) {
    let at = 46 + entry.name.byteLength;
    data.setUint16(at, 0x0001, true);
    data.setUint16(at + 2, extra - 4, true);
    at += 4;
    if (sizes) {
      data.setBigUint64(at, BigInt(entry.size), true);
      data.setBigUint64(at + 8, BigInt(entry.compressed), true);
      at += 16;
    }
    if (offset) data.setBigUint64(at, BigInt(entry.offset), true);
  }
  return bytes;
}
/**
 * The end records prove successful completion; a cancelled or failed prefix has none.
 *
 * With `zip64`, a ZIP64 end record and its locator come first, and each ZIP32
 * field that overflows holds its sentinel.
 */
function end(count: number, size: number, offset: number, zip64: boolean): Uint8Array {
  const bytes = new Uint8Array((zip64 ? 76 : 0) + 22);
  const data = new DataView(bytes.buffer);
  let at = 0;
  if (zip64) {
    const record = offset + size;
    data.setUint32(0, 0x06064b50, true);
    data.setBigUint64(4, 44n, true);
    data.setUint16(12, 0x032d, true);
    data.setUint16(14, 45, true);
    data.setBigUint64(24, BigInt(count), true);
    data.setBigUint64(32, BigInt(count), true);
    data.setBigUint64(40, BigInt(size), true);
    data.setBigUint64(48, BigInt(offset), true);
    data.setUint32(56, 0x07064b50, true);
    data.setBigUint64(64, BigInt(record), true);
    data.setUint32(72, 1, true);
    at = 76;
  }
  data.setUint32(at, 0x06054b50, true);
  data.setUint16(at + 8, count > COUNT_MAX ? 0xffff : count, true);
  data.setUint16(at + 10, count > COUNT_MAX ? 0xffff : count, true);
  data.setUint32(at + 12, size > ZIP32_MAX ? WIDE : size, true);
  data.setUint32(at + 16, offset > ZIP32_MAX ? WIDE : offset, true);
  return bytes;
}
/**
 * Compresses chunks with raw DEFLATE, pulling input only as output is read.
 *
 * Cancelling the output, or a failure, returns `chunks`, so its own cleanup
 * runs.
 */
async function* deflate(chunks: AsyncGenerator<Uint8Array>): AsyncGenerator<Uint8Array> {
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(new Uint8Array(next.value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  }, { highWaterMark: 0 });
  const codec: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>> = new CompressionStream("deflate-raw");
  const reader = input.pipeThrough(codec).getReader();
  let done = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        done = true;
        return;
      }
      if (next.value.byteLength !== 0) yield next.value;
    }
  } finally {
    if (!done) await reader.cancel();
    reader.releaseLock();
  }
}
/** Reject ambiguous paths rather than silently rewriting what an extractor will create. */
function path(value: string, directory: boolean, maxDepth: number): string {
  if (
    typeof value !== "string" || value.length === 0 || value.normalize("NFC") !== value || value.includes("\\") ||
    value.includes(":")
  ) throw new TypeError("ZIP names require an NFC relative path without backslashes or colons.");
  if (value.endsWith("/") !== directory) throw new TypeError("Only ZIP directories have a trailing slash.");
  const plain = directory ? value.slice(0, -1) : value;
  const parts = plain.split("/");
  if (parts.length > maxDepth) throw new RangeError("ZIP path depth exceeds the budget.");
  if (
    parts.some((part) =>
      !part || part === "." || part === ".." || /[. ]$/.test(part) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    )
  ) throw new TypeError("ZIP path has an empty, traversal, reserved or ambiguous component.");
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) {
      throw new TypeError("ZIP names cannot contain controls or unpaired surrogates.");
    }
  }
  return plain;
}
/** Validate finite policy before acquiring the entries iterator or an entry reader. */
function limits(options: ZipWriteOptionsType) {
  const result = {
    maxEntries: options.maxEntries ?? 10_000,
    maxDirectoryBytes: options.maxDirectoryBytes ?? 16 * 1024 * 1024,
    maxEntryBytes: options.maxEntryBytes ?? 64 * 1024 * 1024,
    maxArchiveBytes: options.maxArchiveBytes ?? 1024 * 1024 * 1024,
    maxChunkBytes: options.maxChunkBytes ?? 64 * 1024,
    maxNameBytes: options.maxNameBytes ?? 65535,
    maxPathDepth: options.maxPathDepth ?? 64,
    maxSourceChunks: options.maxSourceChunks ?? 1_000_000,
  };
  for (const [name, value] of Object.entries(result)) assertInteger(value, name);
  if (result.maxNameBytes > 65535 || result.maxChunkBytes < 1) {
    throw new RangeError("ZIP name or chunk limits are outside the format.");
  }
  if (
    options.zip64 !== true &&
    (result.maxEntries > COUNT_MAX || result.maxEntryBytes > ZIP32_MAX || result.maxArchiveBytes > ZIP32_MAX ||
      result.maxDirectoryBytes > ZIP32_MAX)
  ) throw new RangeError("ZIP32 limits exceed this writer profile; set zip64 to allow larger archives.");
  return { ...result, zip64: options.zip64 === true };
}
/**
 * Create a non-seekable, single-disk ZIP stream with signed data descriptors.
 *
 * Each entry is STORED or DEFLATED, as its `compression` says. ZIP32 is the
 * default; set `zip64` to allow entries and archives past 4 GiB or 65,534
 * entries, and ZIP64 fields appear only where a value needs them. Unknown sizes
 * are allowed within finite entry and archive budgets. UTF-8 names, 1980
 * timestamps and fixed regular/directory modes are deterministic. Encryption and
 * link metadata are unsupported.
 *
 * Pulling owns the entries iterator and each reached stream's reader. Cancellation
 * retires the active reader, then the iterator. Unreached entry sources remain
 * caller-owned. Async entry iterators must settle pending next/return calls; JavaScript
 * cannot forcibly retire a non-cooperative promise. Bytes must stay stable until
 * their entry is consumed. Each admitted producer chunk is copied before delivery.
 * Persist to a temporary destination and publish only after successful EOF.
 */
export function createZipStream(
  entries: Iterable<ZipWriteEntryType> | AsyncIterable<ZipWriteEntryType>,
  options: ZipWriteOptionsType = {},
): ReadableStream<Uint8Array> {
  const policy = limits(options);
  const signal = options.signal;
  let cancelled = false;
  const cancellation = {};
  let active: SourceOwnerType | undefined;
  let iterator: AsyncGenerator<Uint8Array> | undefined;
  let pending: Promise<void> | undefined;
  let failure: { readonly reason: unknown } | undefined;
  let listener: (() => void) | undefined;

  /** Shared retirement promise prevents output cancellation and generator finally from releasing twice. */
  function retire(owner: SourceOwnerType, cause?: unknown): Promise<void> {
    owner.retirement ??= close([
      ...(owner.complete ? [] : [() => owner.reader.cancel(cause)]),
      () => owner.reader.releaseLock(),
    ]);
    return owner.retirement;
  }
  /** Local abort state catches consumer cancellation even without an external AbortSignal. */
  function check(): void {
    if (cancelled) throw cancellation;
    signal?.throwIfAborted();
  }
  /** Generator suspension means no next source read occurs until downstream asks for another chunk. */
  async function* write(): AsyncGenerator<Uint8Array> {
    let input: Iterator<ZipWriteEntryType> | AsyncIterator<ZipWriteEntryType> | undefined;
    let finished = false;
    let output = 0;
    let directoryBytes = 0;
    let sourceChunks = 0;
    const directory: DirectoryType[] = [];
    const names = new Map<string, boolean>();
    const parents = new Set<string>();
    let ancestorBytes = 0;
    /** Account complete archive bytes before exposing them to the consumer. */
    function reserve(bytes: number): void {
      if (bytes > policy.maxArchiveBytes - output) throw new RangeError("ZIP archive byte budget exceeded.");
      output += bytes;
    }
    let primary: { readonly reason: unknown } | undefined;
    try {
      check();
      input = Symbol.asyncIterator in entries ? entries[Symbol.asyncIterator]() : entries[Symbol.iterator]();
      while (true) {
        check();
        const item = await input.next();
        check();
        if (item.done) {
          finished = true;
          break;
        }
        const entry = item.value;
        if (entry.kind !== undefined && entry.kind !== "file" && entry.kind !== "directory") {
          throw new TypeError("ZIP writer does not support links or special entry kinds.");
        }
        const isDirectory = entry.kind === "directory";
        const raw = entry.name;
        if (typeof raw !== "string" || raw.length > policy.maxNameBytes) {
          throw new RangeError("ZIP filename exceeds the preliminary string budget.");
        }
        const plain = path(raw, isDirectory, policy.maxPathDepth);
        const key = plain.toLowerCase();
        if (names.has(key) || (!isDirectory && parents.has(key))) {
          throw new TypeError("ZIP duplicate name or file/directory collision.");
        }
        const parts = key.split("/");
        for (let count = 1; count < parts.length; count++) {
          const parent = parts.slice(0, count).join("/");
          if (names.get(parent) === false) throw new TypeError("ZIP file cannot be an ancestor directory.");
          if (!parents.has(parent)) {
            const bytes = new TextEncoder().encode(parent).byteLength;
            if (bytes > policy.maxDirectoryBytes - ancestorBytes) {
              throw new RangeError("ZIP ancestor-name index exceeds the directory budget.");
            }
            ancestorBytes += bytes;
            parents.add(parent);
          }
        }
        const encoded = new TextEncoder().encode(raw);
        if (encoded.byteLength > policy.maxNameBytes) throw new RangeError("ZIP filename exceeds the byte budget.");
        const retained = centralBytes(encoded, policy.zip64);
        if (
          directory.length >= policy.maxEntries || retained > policy.maxDirectoryBytes - directoryBytes - ancestorBytes
        ) {
          throw new RangeError("ZIP central directory budget exceeded.");
        }
        const source = entry.source;
        const declared = entry.size;
        if (declared !== undefined) {
          assertInteger(declared, "ZIP entry size");
          if (declared > policy.maxEntryBytes) throw new RangeError("ZIP entry exceeds the byte budget.");
        }
        if (isDirectory && (source !== undefined || (declared !== undefined && declared !== 0))) {
          throw new TypeError("ZIP directories must have no source and zero size.");
        }
        if (!isDirectory && source === undefined && declared !== undefined && declared !== 0) {
          throw new TypeError("A nonempty ZIP entry needs a source.");
        }
        if (entry.compression !== undefined && entry.compression !== "store" && entry.compression !== "deflate") {
          throw new TypeError("ZIP compression must be store or deflate.");
        }
        const method: 0 | 8 = entry.compression === "deflate" && !isDirectory ? 8 : 0;
        // A streaming writer cannot widen sizes after the fact, so choose ZIP64 from the largest size allowed.
        const wide = policy.zip64 && bound(declared ?? policy.maxEntryBytes, method) > ZIP32_MAX;
        let materialized: Uint8Array | undefined;
        const bodyStream = source !== undefined && !isBytes(source) ? source : undefined;
        if (source !== undefined && isBytes(source)) {
          materialized = toView(source);
          if (
            materialized.byteLength > policy.maxEntryBytes ||
            (declared !== undefined && materialized.byteLength !== declared)
          ) throw new RangeError("ZIP entry byte extent differs from its declared size or budget.");
        }
        names.set(key, isDirectory);
        directoryBytes += retained;
        const offset = output;
        const header = local(encoded, method, wide);
        reserve(header.byteLength);
        yield header;
        let size = 0;
        let state = 0xffffffff;
        /** Copy after native extent admission so producer mutation cannot change queued output or the stored CRC. */
        const payload = (chunk: Uint8Array): Uint8Array => {
          if (!isBytes(chunk)) throw new TypeError("ZIP source chunks must be Uint8Array values.");
          const bytes = toView(chunk);
          if (sourceChunks >= policy.maxSourceChunks) throw new RangeError("ZIP source chunk-count budget exceeded.");
          sourceChunks++;
          if (
            bytes.byteLength > policy.maxChunkBytes || bytes.byteLength > policy.maxEntryBytes - size ||
            (declared !== undefined && bytes.byteLength > declared - size)
          ) throw new RangeError("ZIP source exceeds its chunk, entry or declared-size budget.");
          const copy = new Uint8Array(bytes);
          size += copy.byteLength;
          state = crc32(copy, state);
          return copy;
        };
        /** Yields the entry's uncompressed bytes. Its own cleanup retires the source reader. */
        const chunks = async function* (): AsyncGenerator<Uint8Array> {
          if (materialized !== undefined) {
            for (let at = 0; at < materialized.byteLength; at += policy.maxChunkBytes) {
              check();
              yield payload(materialized.subarray(at, Math.min(materialized.byteLength, at + policy.maxChunkBytes)));
            }
          } else if (bodyStream !== undefined) {
            check();
            const owner: SourceOwnerType = { reader: openBytes(bodyStream), complete: false };
            active = owner;
            let sourceFailure: { readonly reason: unknown } | undefined;
            try {
              while (true) {
                check();
                let chunk: ReadableStreamReadResult<Uint8Array>;
                try {
                  chunk = await owner.reader.read();
                } catch (cause) {
                  owner.complete = true;
                  throw cause;
                }
                check();
                if (chunk.done) {
                  owner.complete = true;
                  break;
                }
                const bytes = payload(chunk.value);
                if (bytes.byteLength !== 0) yield bytes;
              }
            } catch (cause) {
              if (cause !== cancellation) sourceFailure = { reason: cause };
            } finally {
              active = undefined;
              await close(
                [() => retire(owner, sourceFailure?.reason)],
                sourceFailure === undefined ? [] : [sourceFailure.reason],
              );
            }
          }
        };
        let compressed = 0;
        for await (const chunk of method === 8 ? deflate(chunks()) : chunks()) {
          check();
          if (!wide && chunk.byteLength > ZIP32_MAX - compressed) {
            throw new RangeError("ZIP entry passed 4 GiB without ZIP64; set zip64 or declare its size.");
          }
          reserve(chunk.byteLength);
          compressed += chunk.byteLength;
          yield chunk;
        }
        check();
        if (declared !== undefined && declared !== size) {
          throw new RangeError("ZIP source ended before its declared size.");
        }
        const crc = (state ^ 0xffffffff) >>> 0;
        const trailer = descriptor(crc, compressed, size, wide);
        reserve(trailer.byteLength);
        yield trailer;
        directory.push({ name: encoded, directory: isDirectory, offset, size, compressed, crc, method, wide });
      }
      const start = output;
      let zip64 = directory.length > COUNT_MAX;
      for (const entry of directory) {
        check();
        const bytes = central(entry);
        zip64 ||= bytes.byteLength > 46 + entry.name.byteLength;
        reserve(bytes.byteLength);
        yield bytes;
      }
      check();
      const size = output - start;
      zip64 ||= start > ZIP32_MAX || size > ZIP32_MAX;
      const footer = end(directory.length, size, start, zip64);
      reserve(footer.byteLength);
      yield footer;
    } catch (cause) {
      if (cause !== cancellation) primary = { reason: cause };
    } finally {
      const actions: (() => void | PromiseLike<unknown>)[] = [];
      if (active !== undefined) {
        const owner = active;
        active = undefined;
        actions.push(() => retire(owner, primary?.reason));
      }
      if (!finished && input?.return !== undefined) {
        const owned = input;
        actions.push(async () => {
          await owned.return!();
        });
      }
      await close(actions, primary === undefined ? [] : [primary.reason]);
    }
  }
  /** Stop a blocked native read first, then wait for generator-owned cleanup and iterator retirement. */
  async function stop(cause: unknown): Promise<void> {
    cancelled = true;
    // Initiate native cancellation to unblock read; the generator owns observing its
    // result, combining failures and releasing the reader exactly once.
    if (active !== undefined) void retire(active, cause).catch(() => {});
    if (pending !== undefined) await pending;
    if (iterator !== undefined) await iterator.return(undefined);
    if (failure !== undefined) throw failure.reason;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal !== undefined) {
        listener = () => {
          const cause = signal.reason;
          // Abort waits for owned cleanup so an independent retirement failure is not discarded.
          void stop(cause).then(
            () => controller.error(cause),
            (cleanup: unknown) => controller.error(aggregate([cause, cleanup], "ZIP abort and cleanup failed.")),
          );
        };
        if (signal.aborted) listener();
        else signal.addEventListener("abort", listener, { once: true });
      }
    },
    pull(controller) {
      pending = (async () => {
        try {
          check();
          iterator ??= write();
          const item = await iterator.next();
          if (cancelled) return;
          if (item.done) {
            if (listener !== undefined) signal?.removeEventListener("abort", listener);
            controller.close();
          } else controller.enqueue(item.value);
        } catch (cause) {
          failure = { reason: cause };
          if (listener !== undefined) signal?.removeEventListener("abort", listener);
          if (!cancelled) controller.error(cause);
        }
      })();
      return pending;
    },
    async cancel(cause) {
      if (listener !== undefined) signal?.removeEventListener("abort", listener);
      await stop(cause);
    },
  }, { highWaterMark: 0 });
}
