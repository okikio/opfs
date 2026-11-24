/**
 * Conversions between the write inputs the facade accepts and the byte forms drivers need.
 *
 * `writeFile()` accepts bytes, Blobs, strings, streams and async iterables. These helpers turn one of them into bytes
 * (`toBytes`, `collectBytes`) or a stream (`toByteStream`), and own reader locks and cancellation while they do it
 * (`openBytes`, `retire`, `withAbortSignal`). A custom driver can use them to accept the same inputs.
 *
 * @module
 */

export { openBytes } from "./reader.ts";

export type { ByteReaderType } from "./reader.ts";

export { collectBytes, toByteStream } from "./source.ts";

export { observeBytes, retire, withAbortSignal } from "./abort.ts";

export { isAsyncIterable, isReadableStream, toBytes } from "./input.ts";

export type { WriteDataType } from "./input.ts";
