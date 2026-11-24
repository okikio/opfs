/**
 * Multipart upload helpers for the S3 client.
 *
 * These helpers cut a stream into parts, plan server-side copy ranges, and build
 * the CompleteMultipartUpload body from a checked part list.
 *
 * @module
 */
import { S3_LIMITS } from "./schema.ts";
import type { S3ChunkSourceType, S3CopyRangeType, S3PartType } from "./types.ts";
import { open } from "../../chunk.ts";
import { createXmlElement, createXmlText, stringifyXml } from "../../xml.ts";

/** Default streamed upload part size. */
export const DEFAULT_PART_SIZE = 8 * 1024 * 1024;

/** Default server-side multipart-copy range size. */
export const DEFAULT_COPY_PART_SIZE = 1024 * 1024 * 1024;

/** Owns a numbered byte source before multipart initiation can fail. */
export function getChunks(source: ReadableStream<Uint8Array>, size: number, signal?: AbortSignal): S3ChunkSourceType {
  const chunks = open(source, size, signal);
  let number = 0;
  return {
    async next() {
      const result = await chunks.next();
      if (result.done) return { done: true, value: undefined };
      number += 1;
      if (number > S3_LIMITS.maxParts) {
        throw new RangeError(
          `S3 multipart upload exceeds ${S3_LIMITS.maxParts} parts. Supply the expected size or increase partSize.`,
        );
      }
      return { done: false, value: { number, bytes: result.value } };
    },
    async return() {
      await chunks.return?.();
      return { done: true, value: undefined };
    },
    interrupt: () => chunks.interrupt(),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

/** Yields the inclusive source ranges required for multipart server-side copy. */
export function* getCopyRanges(size: number, partSize: number): Generator<S3CopyRangeType> {
  const count = Math.ceil(size / partSize);
  for (let index = 0; index < count; index += 1) {
    const start = index * partSize;
    yield { number: index + 1, start, end: Math.min(size, start + partSize) - 1 };
  }
}

/** Builds one XML `<Part>` element for multipart completion. */
export function getCompletePart(part: S3PartType): ReturnType<typeof createXmlElement> {
  return createXmlElement("Part", [
    createXmlElement("PartNumber", [createXmlText(String(part.number))]),
    createXmlElement("ETag", [createXmlText(part.etag)]),
  ]);
}

/** Builds the XML body accepted by `CompleteMultipartUpload`. */
export function getCompleteBody(parts: readonly S3PartType[]): string {
  return stringifyXml(createXmlElement("CompleteMultipartUpload", parts.map(getCompletePart)));
}

/** Validates and orders part references before S3 commits a multipart upload. */
export function normalizeParts(parts: readonly S3PartType[]): S3PartType[] {
  if (parts.length === 0) throw new RangeError("CompleteMultipartUpload requires at least one part.");
  if (parts.length > S3_LIMITS.maxParts) {
    throw new RangeError(`S3 permits at most ${S3_LIMITS.maxParts} multipart parts.`);
  }

  const sorted = [...parts].sort((left, right) => left.number - right.number);
  let previous = 0;
  for (const part of sorted) {
    if (!Number.isSafeInteger(part.number) || part.number < 1 || part.number > S3_LIMITS.maxParts) {
      throw new RangeError(`S3 part number must be between 1 and ${S3_LIMITS.maxParts}.`);
    }
    if (part.number === previous) throw new RangeError(`S3 multipart part ${part.number} appears more than once.`);
    if (part.etag.length === 0) throw new TypeError(`S3 multipart part ${part.number} has an empty ETag.`);
    previous = part.number;
  }
  return sorted;
}
