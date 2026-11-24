/**
 * Write WARC 1.1 records as a stream, plain or as `.warc.gz`.
 *
 * @module
 */
import { Sha256 } from "../../hash.ts";
import { assertInteger } from "../budget.ts";
import { base32, token, type WarcFieldType } from "./header.ts";
import { readHttpHead } from "./http.ts";
export {
  createWarcSegments,
  getSegmentName,
  type WarcSegmentOptionsType,
  type WarcSegmentRecordType,
  type WarcSegmentType,
} from "./segment.ts";

export {
  createRequestRecord,
  createResponseRecord,
  type HttpHeadType,
  type HttpRequestInputType,
  type HttpResponseInputType,
  readHttpHead,
} from "./http.ts";

/** A block whose bytes arrive as a stream. The size must be known up front because `Content-Length` comes first. */
export interface WarcStreamBlockType {
  /** Exact block length in bytes. A mismatch errors the output. */
  readonly size: number;
  /** Block bytes. The writer acquires and owns its reader once it reaches this record. */
  readonly stream: ReadableStream<Uint8Array>;
}

/** One record to write. */
export interface WarcWriteRecordType {
  /** `WARC-Type`, such as `response`, `request`, `resource`, `metadata`, `warcinfo` or `revisit`. */
  readonly type: string;
  /** `WARC-Target-URI`. Required by WARC for `response`, `request`, `resource` and `revisit`. */
  readonly targetUri?: string;
  /** `WARC-Date`. Defaults to the time the record is written, to the second. */
  readonly date?: Date | string;
  /** `WARC-Record-ID`, with angle brackets. Defaults to `<urn:uuid:...>` from `crypto.randomUUID()`. */
  readonly recordId?: string;
  /** `Content-Type` of the block, such as `application/http; msgtype=response`. */
  readonly contentType?: string;
  /** More fields, written in order after the standard ones. */
  readonly fields?: readonly WarcFieldType[];
  /** The block: header bytes and body for HTTP records, the resource bytes for `resource`. */
  readonly block: Uint8Array | WarcStreamBlockType;
}

/** Where one written record landed, for building a CDXJ index. */
export interface WarcWrittenType {
  readonly recordId: string;
  readonly type: string;
  readonly targetUri: string | undefined;
  readonly date: string;
  /** Offset of the record, or its gzip member, in the output. */
  readonly offset: number;
  /** Output bytes the record used, including the separator or the whole gzip member. */
  readonly length: number;
  /** The `WARC-Block-Digest` value written, when there is one. */
  readonly blockDigest: string | undefined;
  /**
   * The `WARC-Payload-Digest` value written, when there is one: the SHA-256 of
   * the HTTP body of an `application/http` byte block. A CDXJ line's `digest`
   * carries this value, so two captures of the same body share it.
   */
  readonly payloadDigest: string | undefined;
  /** HTTP status of an `application/http` response block, when the writer could read it. */
  readonly status: number | undefined;
  /** Media type from the HTTP `Content-Type` of an `application/http` block, lowercased, without parameters. */
  readonly mime: string | undefined;
}

/** Options for {@link createWarcStream}. */
export interface WarcWriteOptionsType {
  /** `gzip` writes one gzip member per record, the `.warc.gz` layout. Default `none`. */
  readonly compression?: "none" | "gzip";
  /**
   * Adds `WARC-Block-Digest: sha256:<base32>` to records whose block is a
   * `Uint8Array`, and `WARC-Payload-Digest` over the HTTP body when the block is
   * an `application/http` message. Streamed blocks get no digest, because the
   * header is written before the block is read. Default `true`.
   */
  readonly digest?: boolean;
  /** Called after each record's bytes are emitted, with its output offset and length. */
  readonly onRecord?: (record: WarcWrittenType) => void;
  /** Cancels the output and the active block stream. */
  readonly signal?: AbortSignal;
}

/** Fields the writer sets itself. A duplicate in `fields` would break the singleton rule. */
const reserved = new Set([
  "warc-type",
  "warc-record-id",
  "warc-date",
  "warc-target-uri",
  "content-type",
  "content-length",
  "warc-block-digest",
  "warc-payload-digest",
]);

/** Formats a date as WARC 1.1 expects: UTC, to the second. */
function formatDate(date: Date | string | undefined): string {
  if (typeof date === "string") return date;
  return (date ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Refuses CR, LF and other controls, which would end or split a header line. */
function assertValue(value: string, label: string): void {
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new TypeError(`${label} contains a control character.`);
}

/** Builds the header text for one record, ending with the empty line. */
function getHeader(
  record: WarcWriteRecordType,
  recordId: string,
  date: string,
  size: number,
  digest?: string,
  payload?: string,
): string {
  if (!token.test(record.type)) throw new TypeError("WARC-Type must be a token.");
  if (!/^<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+>$/.test(recordId)) {
    throw new TypeError("WARC-Record-ID must be <scheme:id>.");
  }
  const lines = ["WARC/1.1", `WARC-Type: ${record.type}`, `WARC-Record-ID: ${recordId}`, `WARC-Date: ${date}`];
  assertValue(date, "WARC-Date");
  if (record.targetUri !== undefined) {
    assertValue(record.targetUri, "WARC-Target-URI");
    lines.push(`WARC-Target-URI: ${record.targetUri}`);
  }
  if (record.contentType !== undefined) {
    assertValue(record.contentType, "Content-Type");
    lines.push(`Content-Type: ${record.contentType}`);
  }
  if (digest !== undefined) lines.push(`WARC-Block-Digest: ${digest}`);
  if (payload !== undefined) lines.push(`WARC-Payload-Digest: ${payload}`);
  for (const field of record.fields ?? []) {
    if (!token.test(field.name)) throw new TypeError(`Invalid WARC field name: ${field.name}.`);
    if (reserved.has(field.name.toLowerCase())) {
      throw new TypeError(`${field.name} is set by the writer; use the record option instead.`);
    }
    assertValue(field.value, field.name);
    lines.push(`${field.name}: ${field.value}`);
  }
  lines.push(`Content-Length: ${size}`);
  return `${lines.join("\r\n")}\r\n\r\n`;
}

const separator = new Uint8Array([13, 10, 13, 10]);

/** Yields the uncompressed bytes of one record. Checks a streamed block's length. */
async function* getRecordBytes(
  header: Uint8Array,
  block: Uint8Array | WarcStreamBlockType,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  yield header;
  if (block instanceof Uint8Array) {
    if (block.length > 0) yield block;
  } else {
    const reader = block.stream.getReader();
    let seen = 0;
    let done = false;
    try {
      while (true) {
        signal?.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        seen += chunk.value.length;
        if (seen > block.size) throw new RangeError("WARC block stream is longer than its declared size.");
        yield chunk.value;
      }
      done = true;
    } finally {
      if (!done) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (seen !== block.size) throw new RangeError("WARC block stream is shorter than its declared size.");
  }
  yield separator;
}

/** Compresses one record's bytes into one gzip member. */
async function* gzip(chunks: AsyncGenerator<Uint8Array>): AsyncGenerator<Uint8Array> {
  const codec: ReadableWritablePair<Uint8Array, Uint8Array<ArrayBuffer>> = new CompressionStream("gzip");
  const writer = codec.writable.getWriter();
  const reader = codec.readable.getReader();
  // Feed the codec concurrently so its output buffer never blocks the input.
  const feeding = (async () => {
    try {
      for await (const chunk of chunks) {
        // Native codecs refuse views over a SharedArrayBuffer, so copy those.
        await writer.write(
          chunk.buffer instanceof ArrayBuffer ? chunk as Uint8Array<ArrayBuffer> : new Uint8Array(chunk),
        );
      }
      await writer.close();
    } catch (reason) {
      await writer.abort(reason).catch(() => undefined);
      throw reason;
    }
  })();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      yield chunk.value;
    }
    await feeding;
  } finally {
    await reader.cancel().catch(() => undefined);
    await feeding.catch(() => undefined);
  }
}

/**
 * Writes WARC 1.1 records to a byte stream.
 *
 * Each record gets `WARC-Type`, `WARC-Record-ID`, `WARC-Date`,
 * `Content-Length` and, for byte blocks, `WARC-Block-Digest`. Records are
 * pulled from `records` only as the output is read, so a large crawl never
 * sits in memory. With `compression: "gzip"`, each record is its own gzip
 * member, which `openWarc` and other `.warc.gz` readers can seek to by offset.
 *
 * `onRecord` reports each record's output offset and length. Those are the
 * coordinates a CDXJ index stores.
 *
 * @example Write a resource record to a `.warc.gz` file.
 * ```ts
 * import { createWarcStream } from "@okikio/opfs/archive/warc/write";
 *
 * const stream = createWarcStream([{
 *   type: "resource",
 *   targetUri: "https://example.com/notes.txt",
 *   contentType: "text/plain",
 *   block: new TextEncoder().encode("hello"),
 * }], { compression: "gzip", onRecord: (record) => console.log(record.offset, record.length) });
 * await fs.writeFile("/capture.warc.gz", stream);
 * ```
 *
 * The output is valid only after it ends without error. Write to a temporary
 * name and rename after success.
 */
export function createWarcStream(
  records: Iterable<WarcWriteRecordType> | AsyncIterable<WarcWriteRecordType>,
  options: WarcWriteOptionsType = {},
): ReadableStream<Uint8Array> {
  const compression = options.compression ?? "none";
  if (compression !== "none" && compression !== "gzip") throw new TypeError("Unknown WARC compression.");
  const signal = options.signal;
  const encoder = new TextEncoder();
  async function* write(): AsyncGenerator<Uint8Array> {
    let offset = 0;
    for await (const record of records) {
      signal?.throwIfAborted();
      const size = record.block instanceof Uint8Array ? record.block.length : record.block.size;
      assertInteger(size, "WARC block size");
      const recordId = record.recordId ?? `<urn:uuid:${crypto.randomUUID()}>`;
      const date = formatDate(record.date);
      let blockDigest: string | undefined;
      let payloadDigest: string | undefined;
      // Only an HTTP message block has a payload, a status and a media type to report.
      const head = record.block instanceof Uint8Array && /^application\/http\b/i.test(record.contentType ?? "")
        ? readHttpHead(record.block)
        : undefined;
      if (options.digest !== false && record.block instanceof Uint8Array) {
        const hash = new Sha256();
        hash.update(record.block);
        blockDigest = `sha256:${base32(hash.digest())}`;
        if (head !== undefined) {
          const body = new Sha256();
          body.update(record.block.subarray(head.bodyOffset));
          payloadDigest = `sha256:${base32(body.digest())}`;
        }
      }
      const header = encoder.encode(getHeader(record, recordId, date, size, blockDigest, payloadDigest));
      const chunks = getRecordBytes(header, record.block, signal);
      let length = 0;
      for await (const chunk of compression === "gzip" ? gzip(chunks) : chunks) {
        length += chunk.length;
        yield chunk;
      }
      options.onRecord?.({
        recordId,
        type: record.type,
        targetUri: record.targetUri,
        date,
        offset,
        length,
        blockDigest,
        payloadDigest,
        status: head?.status,
        mime: head?.mime,
      });
      offset += length;
    }
  }
  const iterator = write();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      // Runs the generator's finally blocks, which cancel the active block stream.
      await iterator.return(undefined);
    },
  });
}
