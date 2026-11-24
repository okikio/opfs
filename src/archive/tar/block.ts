/**
 * TAR's 512-byte block rule, shared by the reader in `mod.ts` and the stream reader and writer in `stream.ts`.
 *
 * Every TAR header and payload occupies whole 512-byte blocks. A payload whose size is not a multiple of 512
 * is followed by zero bytes up to the next block boundary.
 *
 * Published at `@okikio/opfs/archive/tar/_block` for code that reads or writes TAR blocks itself. Most callers
 * never need it: `openTar()`, `readTarStream()` and `createTarStream()` already apply it.
 *
 * @module
 */

/**
 * Returns how many zero bytes follow a payload of `size` bytes to reach the next 512-byte block boundary.
 *
 * Call it where a reader skips or a writer emits that tail, with the payload's own size:
 *
 * ```ts
 * await cursor.read(padding(entry.size));
 * if (padding(size)) yield new Uint8Array(padding(size));
 * ```
 *
 * The result is between 0 and 511. A size that is already a multiple of 512 needs no padding. The modulo
 * form avoids rounding `size` up first, which could exceed the safe-integer range for very large sizes.
 */
export function padding(size: number): number {
  return (512 - size % 512) % 512;
}
