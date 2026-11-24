/**
 * Write input: the values `writeFile()` accepts, and their conversion to bytes.
 *
 * @module
 */
import { toView } from "../bytes.ts";

/** Write input accepted by the high-level filesystem facade. */
export type WriteDataType =
  | string
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** Shared UTF-8 encoder; TextEncoder has no mutable per-call state. */
export const textEncoder = new TextEncoder();

/** Returns true when a write value is a Web ReadableStream. */
export function isReadableStream(data: WriteDataType): data is ReadableStream<Uint8Array> {
  return typeof data === "object" && data !== null && typeof Reflect.get(data, "getReader") === "function";
}

/** Returns true when a write value exposes an async iterator. */
export function isAsyncIterable(data: WriteDataType): data is AsyncIterable<Uint8Array> {
  return typeof data === "object" && data !== null && typeof Reflect.get(data, Symbol.asyncIterator) === "function";
}

/** Converts materialized write input into bytes without changing its content. */
export async function toBytes(
  data: Exclude<WriteDataType, ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>>,
): Promise<Uint8Array> {
  if (typeof data === "string") return textEncoder.encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return toView(data);
}
