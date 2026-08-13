import { FileSystemError, throwIfAborted } from "./error.ts";

/** Write input accepted by the high-level filesystem facade. */
export type WriteDataType =
  | string
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

/** Shared UTF-8 encoder; TextEncoder has no mutable per-call state. */
const textEncoder = new TextEncoder();

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
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Converts any supported write value into a ReadableStream without eager copying. */
export function toByteStream(data: WriteDataType): ReadableStream<Uint8Array> {
  if (isReadableStream(data)) return data;
  if (isAsyncIterable(data)) {
    const iterator = data[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        if (typeof iterator.return === "function") await iterator.return();
      },
    });
  }

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(await toBytes(data));
      controller.close();
    },
  });
}

/**
 * Materializes a stream with an explicit memory limit.
 *
 * Record/database adapters need complete values because their public contracts
 * are value-oriented. The limit prevents a large browser stream from silently
 * becoming an unbounded heap allocation when the selected adapter cannot stream.
 */
export async function collectBytes(
  source: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal | undefined,
  operation: string,
  path: string,
): Promise<Uint8Array> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;

  try {
    while (true) {
      throwIfAborted(signal, operation, path);
      const next = await reader.read();
      if (next.done) {
        completed = true;
        break;
      }
      total += next.value.byteLength;
      if (total > limit) {
        throw new FileSystemError(
          "too-large",
          operation,
          path,
          [
            `${operation} for '${path}' requires more than ${limit} buffered bytes.`,
            "Select a streaming adapter or raise maxBufferedWriteBytes.",
          ].join(" "),
        );
      }
      chunks.push(next.value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {
      // The original read, size, or cancellation failure is more actionable.
    }
    throw error;
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // The producer can already be closed after a failure.
      }
    }
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/**
 * Wraps a stream so an AbortSignal cancels an already-open producer.
 *
 * Opening a stream and then aborting before its next pull must release the
 * underlying reader. Otherwise native file descriptors and browser resources
 * can remain alive until garbage collection.
 */
export function withAbortSignal(
  source: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  path: string,
  operation = "read",
): ReadableStream<Uint8Array> {
  if (signal === undefined) return source;
  const reader = source.getReader();
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  const closeReader = async (reason?: unknown): Promise<void> => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", onAbort);
    try {
      await reader.cancel(reason);
    } finally {
      reader.releaseLock();
    }
  };

  const onAbort = (): void => {
    const error = new FileSystemError(
      "aborted",
      operation,
      path,
      `${operation} was aborted for '${path}'.`,
      signal.reason,
    );
    controller?.error(error);
    void closeReader(error);
  };

  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(value) {
      throwIfAborted(signal, operation, path);
      try {
        const next = await reader.read();
        if (next.done) {
          value.close();
          await closeReader();
        } else {
          value.enqueue(next.value);
        }
      } catch (error) {
        value.error(error);
        await closeReader(error);
      }
    },
    async cancel(reason) {
      await closeReader(reason);
    },
  });
}
