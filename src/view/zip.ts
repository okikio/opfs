import type { AdapterType } from "../adapter/definition.ts";
import type { ZipArchiveType, ZipReadOptionsType } from "../archive/zip.ts";
import { createArchiveAdapter } from "./tree.ts";

/** Each filesystem read has finite archive limits. No streaming claim is made for buffered results. */
export interface ZipViewOptionsType extends
  Pick<
    ZipReadOptionsType,
    "maxSourceBytes" | "maxRequests" | "maxDecodedBytes" | "maxOutputBytes" | "inflate" | "bzip" | "lzma" | "ledger"
  > {
  /** Full-member CRC checking is the default even for a selected range; disable explicitly for unchecked prefixes. */
  readonly verify?: boolean;
}

/**
 * Projects an archive into a read-only filesystem after validating every name.
 * The archive and source remain borrowed; closing the filesystem does not close them.
 * Selected reads retain full-member CRC verification unless explicitly disabled.
 */
export function createZipAdapter(archive: ZipArchiveType, options: ZipViewOptionsType = {}): AdapterType {
  // Construction captures policy values, while the archive and ledger stay borrowed.
  // Replacing nested option fields later must not raise this view's configured caps.
  options = {
    ...options,
    ...(options.bzip ? { bzip: { ...options.bzip } } : {}),
    ...(options.lzma ? { lzma: { ...options.lzma } } : {}),
  };
  for (const entry of archive.entries) {
    if (entry.directory !== (entry.kind === "directory")) {
      throw new TypeError("ZIP directory flag and entry kind disagree.");
    }
  }
  return createArchiveAdapter("zip", archive.entries, async (entry, read) => {
    return (await archive.read(entry.id, { ...options, ...read, verify: options.verify ?? true })).bytes;
  }, options.maxOutputBytes);
}
