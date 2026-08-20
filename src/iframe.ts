import { createOpfsAdapter } from "./adapter/opfs.ts";
import type { FileSystemOptionsType } from "./adapter/definition.ts";
import { FileSystemError, toFileSystemError } from "./error.ts";
import type { OpfsDirectoryHandleType } from "./driver/opfs.ts";
import { createFileSystem, type FileSystemType } from "./filesystem.ts";

/** Storage Access API result shape used without depending on experimental DOM declarations. */
interface StorageAccessHandleType {
  /** Returns the unpartitioned OPFS root when the browser granted that capability. */
  getDirectory?: () => Promise<OpfsDirectoryHandleType>;
}

/** Document shape for browsers that implement unpartitioned OPFS Storage Access. */
interface StorageAccessDocumentType {
  /** Requests selected unpartitioned storage capabilities from an embedded document. */
  requestStorageAccess?: (types?: { readonly getDirectory?: boolean }) => Promise<StorageAccessHandleType>;
}

/**
 * Returns true when the current document exposes the Storage Access API entrypoint.
 *
 * A true result does not mean that a request will be granted. Browsers can require
 * user activation, iframe permissions policy, prior site interaction, or a user
 * decision before they return an unpartitioned OPFS directory.
 */
export function supportsUnpartitionedOpfsRequest(): boolean {
  const documentValue = Reflect.get(globalThis, "document") as unknown as StorageAccessDocumentType | undefined;
  return typeof documentValue?.requestStorageAccess === "function";
}

/**
 * Requests an unpartitioned OPFS root from an embedded document.
 *
 * Normal `openFileSystem()` uses the current storage key. In a third-party
 * iframe that storage can be partitioned by the top-level site. This opt-in API
 * requests the browser's unpartitioned `getDirectory` capability instead.
 *
 * The caller must invoke this function from a context that satisfies the
 * browser's Storage Access requirements. The returned filesystem borrows the
 * browser root and therefore has no root resource to dispose.
 *
 * @example Request unpartitioned storage after a user action.
 * ```ts
 * import { requestUnpartitionedFileSystem } from "@okikio/opfs/iframe";
 *
 * button.addEventListener("click", async () => {
 *   const fileSystem = await requestUnpartitionedFileSystem();
 *   await fileSystem.writeFile("/state.json", "{}", { parents: true });
 * });
 * ```
 */
export async function requestUnpartitionedFileSystem(options: FileSystemOptionsType = {}): Promise<FileSystemType> {
  const documentValue = Reflect.get(globalThis, "document") as unknown as StorageAccessDocumentType | undefined;
  if (typeof documentValue?.requestStorageAccess !== "function") {
    throw new FileSystemError(
      "unavailable",
      "request-unpartitioned-opfs",
      undefined,
      "The Storage Access API is unavailable in this document.",
    );
  }

  try {
    const access = await documentValue.requestStorageAccess({ getDirectory: true });
    if (typeof access.getDirectory !== "function") {
      throw new FileSystemError(
        "unavailable",
        "request-unpartitioned-opfs",
        undefined,
        "The browser did not grant the OPFS directory capability.",
      );
    }
    return createFileSystem(createOpfsAdapter(await access.getDirectory()), options);
  } catch (error) {
    throw toFileSystemError(error, "request-unpartitioned-opfs");
  }
}
