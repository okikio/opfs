/**
 * Split one stream of WARC records across numbered files.
 *
 * A long crawl writes more than one WARC file should hold. {@link createWarcSegments}
 * starts a new file once the current one reaches `maxSegmentBytes`, but only
 * between records, so no record is ever split across files. Each file starts
 * with its own `warcinfo` record and is a complete WARC on its own.
 *
 * ```text
 * records ─► segment-000001.warc.gz  (warcinfo, r1, r2, r3)   ≥ maxSegmentBytes after r3
 *         ─► segment-000002.warc.gz  (warcinfo, r4, r5)
 * ```
 *
 * The segments have `name` and `source`, so they can go straight into
 * `createWaczStream({ warcs })`.
 *
 * @module
 */
import { assertInteger } from "../budget.ts";
import {
  createWarcStream,
  type WarcWriteOptionsType,
  type WarcWriteRecordType,
  type WarcWrittenType,
} from "./write.ts";

/** One WARC file in the sequence. */
export interface WarcSegmentType {
  /** Position in the sequence, from 1. */
  readonly sequence: number;
  /** File name, such as `segment-000001.warc.gz`. */
  readonly name: string;
  /** The file's bytes. Read it to the end before asking for the next segment. */
  readonly source: ReadableStream<Uint8Array>;
}

/** Where one record landed, with the file it landed in. */
export interface WarcSegmentRecordType extends WarcWrittenType {
  /** The segment's file name. A CDXJ line's `filename` is this value. */
  readonly filename: string;
  /** The segment's position in the sequence, from 1. */
  readonly sequence: number;
}

/** Options for {@link createWarcSegments}. */
export interface WarcSegmentOptionsType extends Omit<WarcWriteOptionsType, "onRecord" | "compression"> {
  /**
   * Starts a new segment after the record that brings the current one to this
   * many bytes or more. A single record larger than this still fits in one
   * segment, so a segment can pass the limit by up to one record.
   */
  readonly maxSegmentBytes: number;
  /** `gzip` (the default) writes one gzip member per record, which a CDXJ index can address. */
  readonly compression?: "none" | "gzip";
  /** File name for a sequence number. Defaults to `segment-000001.warc.gz` (or `.warc` without gzip). */
  readonly name?: (sequence: number) => string;
  /**
   * Fields for the `warcinfo` record that opens each segment, as `name: value`
   * lines. Defaults to `software` and `format`. Pass `null` to write no
   * `warcinfo` record.
   */
  readonly info?: Readonly<Record<string, string>> | null;
  /** Called after each record's bytes are emitted, with its file, offset and length. */
  readonly onRecord?: (record: WarcSegmentRecordType) => void;
}

/** Returns the default segment name: six digits keep the names in order when sorted as text. */
export function getSegmentName(sequence: number, compression: "none" | "gzip" = "gzip"): string {
  assertInteger(sequence, "WARC segment sequence", 999_999, 1);
  return `segment-${String(sequence).padStart(6, "0")}${compression === "gzip" ? ".warc.gz" : ".warc"}`;
}

/** Builds the `warcinfo` record that opens a segment. */
function getInfo(name: string, fields: Readonly<Record<string, string>>): WarcWriteRecordType {
  const text = Object.entries(fields).map(([key, value]) => `${key}: ${value}\r\n`).join("");
  return {
    type: "warcinfo",
    contentType: "application/warc-fields",
    fields: [{ name: "WARC-Filename", value: name }],
    block: new TextEncoder().encode(text),
  };
}

/**
 * Writes records across a sequence of WARC files, starting a new one between
 * records once a file reaches `maxSegmentBytes`.
 *
 * Records are pulled only as segment bytes are read, so a crawl never sits in
 * memory. Read each segment's `source` to its end before asking for the next
 * segment; asking early throws, because the next segment would need records
 * the current one has not written yet. No empty trailing segment is produced.
 *
 * Stopping early (a `break`, or returning the iterator) returns the `records`
 * iterator, so its own cleanup runs.
 *
 * @example Write segments and collect a CDXJ index as they stream.
 * ```ts
 * import { createWarcSegments } from "@okikio/opfs/archive/warc/write";
 *
 * const index = [];
 * for await (const segment of createWarcSegments(records, {
 *   maxSegmentBytes: 1024 ** 3,
 *   onRecord: (r) => r.targetUri && index.push({ url: r.targetUri, date: r.date, filename: r.filename, offset: r.offset, length: r.length }),
 * })) {
 *   await fs.writeFile(`/crawl/${segment.name}`, segment.source);
 * }
 * ```
 */
export async function* createWarcSegments(
  records: Iterable<WarcWriteRecordType> | AsyncIterable<WarcWriteRecordType>,
  options: WarcSegmentOptionsType,
): AsyncGenerator<WarcSegmentType> {
  assertInteger(options.maxSegmentBytes, "maxSegmentBytes", Number.MAX_SAFE_INTEGER, 1);
  const compression = options.compression ?? "gzip";
  const info = options.info === undefined ? { software: "@okikio/opfs", format: "WARC File Format 1.1" } : options.info;
  const input: Iterator<WarcWriteRecordType> | AsyncIterator<WarcWriteRecordType> = Symbol.asyncIterator in records
    ? records[Symbol.asyncIterator]()
    : records[Symbol.iterator]();
  let finished = false;
  try {
    // Pull one record ahead, so a segment is only started when it has a record to hold.
    let next = await input.next();
    for (let sequence = 1; !next.done; sequence++) {
      const name = options.name?.(sequence) ?? getSegmentName(sequence, compression);
      let full = false;
      let done = false;
      // The first record of each segment is our warcinfo when `info` is set; it is not reported.
      let skip = info === null ? 0 : 1;
      const body = async function* (): AsyncGenerator<WarcWriteRecordType> {
        if (info !== null) yield getInfo(name, info);
        while (!next.done && !full) {
          const record = next.value;
          next = await input.next();
          yield record;
        }
      };
      const writer = createWarcStream(body(), {
        compression,
        ...(options.digest === undefined ? {} : { digest: options.digest }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        onRecord: (record) => {
          if (record.offset + record.length >= options.maxSegmentBytes) full = true;
          if (skip > 0) skip--;
          else options.onRecord?.({ ...record, filename: name, sequence });
        },
      });
      // Track the end of the segment so asking for the next one early is caught.
      const source = writer.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          flush() {
            done = true;
          },
        }),
      );
      yield { sequence, name, source };
      if (!done) throw new Error(`Read ${name} to its end before asking for the next WARC segment.`);
    }
    finished = true;
  } finally {
    if (!finished) await input.return?.();
  }
}
