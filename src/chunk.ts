import { concat } from "@std/bytes/concat";

/**
 * Splits a byte stream into owned chunks with a fixed maximum size.
 *
 * Network streams can produce chunks that are much smaller than an S3 part or
 * an Azure block. Repeatedly concatenating each incoming chunk onto one growing
 * `Uint8Array` makes that workload copy the same prefix many times. This
 * splitter keeps zero-copy views until one output chunk is complete, then uses
 * `@std/bytes/concat` to copy each retained byte into one owned result.
 *
 * The final chunk can be smaller than `size`. This matches both S3 multipart
 * upload and Azure block-upload semantics. If the consumer stops early, the
 * source reader is cancelled so a Fetch body or another producer does not keep
 * generating bytes after the upload has become terminal.
 *
 * @example Split arbitrary network chunks into 8 MiB upload parts.
 * ```ts
 * for await (const part of split(response.body!, 8 * 1024 * 1024)) {
 *   await uploadPart(part);
 * }
 * ```
 */
export async function* split(source: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("Chunk size must be a positive integer.");

  const reader = source.getReader();
  let pieces: Uint8Array[] = [];
  let length = 0;
  let completed = false;

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        break;
      }

      let offset = 0;
      while (offset < result.value.byteLength) {
        const count = Math.min(size - length, result.value.byteLength - offset);
        pieces.push(result.value.subarray(offset, offset + count));
        length += count;
        offset += count;

        if (length === size) {
          yield concat(pieces);
          pieces = [];
          length = 0;
        }
      }
    }

    if (length > 0) yield concat(pieces);
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
