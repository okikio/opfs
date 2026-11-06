/** Internal CK framing and 32 KiB history profile for CAB MSZIP units. @module */
import { invalid } from "./record.ts";
import { readDeflate } from "./deflate.ts";

/** Decode one complete CK-prefixed unit, borrowing prior folder history and returning only new bytes.
 * The caller reserves source/decoded/output work before this bounded allocation. No partial output escapes errors.
 */
export function readMszip(
  packed: Uint8Array,
  size: number,
  history: Uint8Array,
  signal?: AbortSignal,
  admitBlock?: () => void,
): Uint8Array {
  signal?.throwIfAborted();
  if (packed.length < 3 || packed.length > 32780 || packed[0] !== 0x43 || packed[1] !== 0x4b) {
    invalid("MSZIP block requires CK and at most 32780 packed bytes.");
  }
  if (!Number.isSafeInteger(size) || size < 1 || size > 32768 || history.length > 32768) {
    invalid("MSZIP decoded block/history exceeds 32 KiB.");
  }
  return readDeflate(packed.subarray(2), size, history, signal, admitBlock);
}
