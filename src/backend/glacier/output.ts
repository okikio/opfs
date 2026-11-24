/**
 * Job output helpers for the Glacier client.
 *
 * These helpers find the archive range a job returns, check whether a byte range
 * is tree-hash aligned, and read a bounded output body.
 *
 * @module
 */
import { GLACIER_MIB, type GlacierJobType, SizeSchema } from "./schema.ts";
import { isBytes } from "../../bytes.ts";
import { aggregate, close } from "../../close.ts";
import { openBytes } from "../../stream.ts";

/** Admit original archive coordinates before any callback. Tail bytes are allowed only at actual archive EOF. */
export function archiveRange(
  job: GlacierJobType,
): { readonly archiveSize: number; readonly start: number; readonly length: number } {
  const archiveSize = SizeSchema.parse(job.ArchiveSizeInBytes);
  if (job.RetrievalByteRange === null || job.RetrievalByteRange === undefined) {
    return { archiveSize, start: 0, length: archiveSize };
  }
  const fields = job.RetrievalByteRange.split("-");
  if (fields.length !== 2) throw new TypeError("Malformed Glacier retrieval range.");
  const start = decimal(fields[0]!);
  const end = decimal(fields[1]!);
  if (
    end < start || end >= archiveSize || start % GLACIER_MIB !== 0 ||
    ((end + 1) % GLACIER_MIB !== 0 && end !== archiveSize - 1)
  ) throw new RangeError("Glacier retrieval range requires MiB boundaries or the actual archive tail.");
  return { archiveSize, start, length: end - start + 1 };
}

/** Completed output size uses the selected retrieval extent, not the whole original archive size. */
export function outputSize(job: GlacierJobType): number {
  if (job.Action === "InventoryRetrieval") return SizeSchema.parse(job.InventorySizeInBytes);
  if (job.Action !== "ArchiveRetrieval") throw new TypeError("Select output is outside this client profile.");
  return archiveRange(job).length;
}

/** A tree node covers aligned power-of-two leaves, clipped only at the actual final leaf.
 * Walking heights admits promoted odd tail nodes without rounding a requested
 * byte extent into another one. Arithmetic remains exact without 32-bit shifts.
 */
export function treeAligned(size: number, start: number, length: number): boolean {
  if (length === 0 || start % GLACIER_MIB !== 0) return false;
  const end = start + length;
  if (end !== size && end % GLACIER_MIB !== 0) return false;
  const leaves = Math.ceil(size / GLACIER_MIB);
  const first = start / GLACIER_MIB;
  const after = Math.ceil(end / GLACIER_MIB);
  for (let width = 1;; width *= 2) {
    if (first % width === 0 && Math.min(first + width, leaves) === after) return true;
    if (width >= leaves) return false;
  }
}

/** Both the original retrieval and selected output must be archive-tree nodes. Inventory has no service tree checksum. */
export function checksumScope(job: GlacierJobType, offset: number, length: number): boolean {
  if (job.Action !== "ArchiveRetrieval") return false;
  const selected = archiveRange(job);
  return treeAligned(selected.archiveSize, selected.start, selected.length) &&
    treeAligned(selected.archiveSize, selected.start + offset, length);
}

/** Own exactly one reader until EOF/error/cancel; cancellation and release failures retain the original fault. */
export async function outputBytes(
  response: Response,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (response.body === null) throw new TypeError("Glacier output has no body.");
  const reader = openBytes(response.body);
  let bytes = new Uint8Array(0);
  let at = 0;
  let settled = false;
  let cancellation: Promise<void> | undefined;
  const failures: unknown[] = [];
  const abort = () => {
    cancellation = reader.cancel(signal?.reason);
    void cancellation.catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    // Allocation can refuse a caller-raised ceiling; the acquired reader must still retire.
    bytes = new Uint8Array(length);
    signal?.throwIfAborted();
    while (true) {
      let item: ReadableStreamReadResult<Uint8Array>;
      try {
        item = await reader.read();
      } catch (reason) {
        // A delivered native read fault is already terminal, as in readResponse.
        // A borrowed rejection grants no stronger proof; refuse success and
        // release the acquired reader rather than recancelling a stored fault.
        settled = true;
        if (signal?.aborted) {
          throw aggregate([reason, signal.reason], "Glacier output read and caller cancellation were both observed.");
        }
        throw reason;
      }
      signal?.throwIfAborted();
      if (item.done) {
        settled = true;
        break;
      }
      if (!isBytes(item.value) || item.value.length > length - at) {
        throw new RangeError("Glacier output exceeded its admitted extent or returned a non-byte chunk.");
      }
      bytes.set(item.value, at);
      at += item.value.length;
    }
    if (at !== length) throw new RangeError("Glacier output was truncated.");
  } catch (reason) {
    failures.push(reason);
  } finally {
    signal?.removeEventListener("abort", abort);
    await close([
      ...(cancellation === undefined ? settled ? [] : [() => reader.cancel()] : [() => cancellation!]),
      () => reader.releaseLock(),
    ], failures);
  }
  return bytes;
}

/** Pure admission uses ASCII decimal text without the final-newline loophole of a dollar anchor. */
export function decimal(value: string): number {
  if (value.length === 0 || /[^0-9]/.test(value)) throw new TypeError("Expected unsigned decimal text.");
  return SizeSchema.parse(Number(value));
}
