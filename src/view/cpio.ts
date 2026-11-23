/** Read-only indexed SVR4 CPIO projection. @module */
import type { AdapterType } from "../adapter/definition.ts";
import type { CpioArchiveType, CpioReadOptionsType } from "../archive/cpio.ts";
import { createArchiveAdapter } from "./tree.ts";

/** Per-read budgets and CRC policy; use a shared ledger to limit several previews together. */
export interface CpioViewOptionsType extends Omit<CpioReadOptionsType, "offset" | "length" | "signal"> {}

/**
 * Project regular CPIO files and directories after strict namespace admission.
 * Resolved hard-link aliases read their physical data owner; no host links are created.
 * Symbolic links, special objects, duplicate paths, traversal and collisions fail
 * before member reads. CRC reads verify the complete data-owner payload by default,
 * including for a prefix; newc has no content checksum. Closing the adapter leaves
 * the archive and its source borrowed and usable.
 */
export function createCpioAdapter(archive: CpioArchiveType, options: CpioViewOptionsType = {}): AdapterType {
  return createArchiveAdapter("cpio", archive.entries, async (entry, read) => {
    return (await archive.read(entry.id, { ...options, verify: options.verify ?? true, ...read })).bytes;
  }, options.maxOutputBytes);
}
