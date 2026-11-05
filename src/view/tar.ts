/** Read-only indexed TAR projection. @module */
import type { AdapterType } from "../adapter/definition.ts";
import type { TarArchiveType, TarReadOptionsType } from "../archive/tar.ts";
import { createArchiveAdapter } from "./tree.ts";

/** Per-read budgets; share a ledger when several previews need an aggregate limit. */
export interface TarViewOptionsType extends Omit<TarReadOptionsType, "offset" | "length" | "signal"> {}

/**
 * Expose regular TAR members and directories after strict namespace admission.
 * Links, duplicate paths, traversal and file/directory collisions fail before reads.
 * Only selected payload extents are read. TAR header checksums do not verify payloads.
 * Closing this adapter leaves the archive and source borrowed and usable.
 */
export function createTarAdapter(archive: TarArchiveType, options: TarViewOptionsType = {}): AdapterType {
  return createArchiveAdapter("tar", archive.entries, async (entry, read) => {
    return (await archive.read(entry.id, { ...options, ...read })).bytes;
  }, options.maxOutputBytes);
}
