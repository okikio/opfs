/**
 * Whole-file write semantics for backends that store a file as one complete value.
 *
 * Object stores, record stores and IndexedDB rows cannot change a byte range in place. To append or update,
 * they read the current file, build the next complete image, and replace the stored value. This module owns
 * that step, so every such backend applies the same `replace`, `append` and `update` rules.
 *
 * Published at `@okikio/opfs/driver/_image` for authors of custom drivers. Most callers never need it: the
 * object and record adapters, and the IndexedDB driver, already call it.
 *
 * @module
 */
import type { WriteModeType } from "../schema/types.ts";

export type { WriteModeType };

/**
 * Returns the complete file image after applying one write to the `existing` bytes.
 *
 * Call it between reading the current value and replacing it, inside the same conditional replacement or
 * transaction, so no other writer can change `existing` in between:
 *
 * ```ts
 * const next = applyWrite(current, data, options.mode, options.at, options.truncate ?? false);
 * ```
 *
 * - `replace` returns a copy of `data`.
 * - `append` writes `data` after the last byte of `existing`.
 * - `update` writes `data` at `at` (default 0). A gap past the end of `existing` is filled with zero bytes.
 * - `truncate` drops everything after the written bytes.
 *
 * The result is always a new array; neither input is modified or retained. It allocates the full next image,
 * so its cost grows with file size, not with the size of the write.
 */
export function applyWrite(
  existing: Uint8Array,
  data: Uint8Array,
  mode: WriteModeType,
  at: number | undefined,
  truncate: boolean,
): Uint8Array {
  if (mode === "replace") return data.slice();
  const position = mode === "append" ? existing.byteLength : at ?? 0;
  const size = Math.max(existing.byteLength, position + data.byteLength);
  let output = new Uint8Array(size);
  output.set(existing);
  output.set(data, position);
  if (truncate) output = output.slice(0, position + data.byteLength);
  return output;
}
