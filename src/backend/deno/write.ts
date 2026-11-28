/// <reference types="deno" />
/** Stream writes own the input reader while the backend retains its opened Deno descriptor. @module */
import { isBytes, toView } from "../../bytes.ts";
import { close } from "../../close.ts";
import type { FileDriverWriteOptionsType } from "../../driver/file.ts";
import { throwIfAborted } from "../../error.ts";
import type { PathType } from "../../path.ts";
import { openBytes, withAbortSignal } from "../../stream/mod.ts";

/**
 * Streams bytes into one already-open Deno file.
 *
 * The write starts at zero for replacement, the current file size for append,
 * or `options.at` (default zero) for update. Partial native writes are completed
 * before reading the next source chunk. The operation releases the source
 * reader and cancels an unfinished producer after failure or signal abort.
 *
 * The caller retains the file and owns any final truncation and close. The
 * returned byte position lets that caller truncate to the completed write end.
 * Source retirement preserves the write failure and any cleanup failures.
 */
export async function writeStreamToFile(
  file: Deno.FsFile,
  path: PathType,
  source: ReadableStream<Uint8Array>,
  options: FileDriverWriteOptionsType,
): Promise<number> {
  const reader = openBytes(withAbortSignal(source, options.signal, path, "write"));
  let terminal = false;
  let primary: readonly unknown[] = [];
  try {
    throwIfAborted(options.signal, "write", path);
    let position = options.mode === "append"
      ? (await file.stat()).size
      : options.mode === "update"
      ? options.at ?? 0
      : 0;
    throwIfAborted(options.signal, "write", path);
    await file.seek(position, Deno.SeekMode.Start);
    throwIfAborted(options.signal, "write", path);
    while (true) {
      throwIfAborted(options.signal, "write", path);
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (reason) {
        terminal = true;
        throw reason;
      }
      if (next.done) terminal = true;
      throwIfAborted(options.signal, "write", path);
      if (next.done) break;
      if (!isBytes(next.value)) throw new TypeError("A file stream chunk must be a Uint8Array.");
      const bytes = toView(next.value);

      let offset = 0;
      while (offset < bytes.byteLength) {
        throwIfAborted(options.signal, "write", path);
        const count = await file.write(bytes.subarray(offset));
        throwIfAborted(options.signal, "write", path);
        if (count <= 0) throw new Error(`Deno stream write made no progress for '${path}'.`);
        offset += count;
      }
      position += bytes.byteLength;
    }
    return position;
  } catch (reason) {
    primary = [reason];
    throw reason;
  } finally {
    await close([
      async () => {
        if (!terminal) await reader.cancel(primary[0]);
      },
      () => reader.releaseLock(),
    ], primary);
  }
}
